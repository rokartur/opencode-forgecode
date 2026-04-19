// Core RepoMap implementation - ported from soulforge

import { Database, type Statement } from '../runtime/sqlite'
import { hashBytesToHex } from '../runtime/hash'
import { resolve, join, dirname, extname, relative } from 'path'
import { existsSync, statSync } from 'fs'

import { TreeSitterBackend } from './tree-sitter'
import { FileCache } from './cache'
import { tokenize, computeMinHash, computeFragmentHashes, jaccardSimilarity } from './clone-detection'
import { detectCommunities, detectBridges, detectSurpriseEdges } from './communities'
import {
	INDEXABLE_EXTENSIONS,
	PAGERANK_ITERATIONS,
	PAGERANK_DAMPING,
	GRAPH_SCAN_BATCH_SIZE,
	GRAPH_SCAN_PER_FILE_TIMEOUT_MS,
} from './constants'
import { isBarrelFile, kindTag, collectFilesAsync, extractSignature } from './utils'
import { withSqliteBusyRetry } from './retry'
import type {
	DbFile,
	DbSymbol,
	TopFileResult,
	FileDepResult,
	FileCoChangeResult,
	FileSymbolResult,
	SymbolSearchResult,
	SymbolSignatureResult,
	CallerResult,
	CalleeResult,
	EdgeConfidenceTier,
	UnusedExportResult,
	DuplicateStructureResult,
	NearDuplicateResult,
	ExternalPackageResult,
	GraphStats,
	SymbolKind,
	PrepareScanResult,
	ScanBatchResult,
	OrphanFileResult,
	CircularDependencyResult,
	ChangeImpactResult,
	ImpactedFile,
	SymbolReferenceResult,
	SymbolBlastRadiusResult,
	CallGraphCycleResult,
} from './types'

interface IndexedFile {
	id: number
	path: string
	mtime_ms: number
	language: string
	line_count: number
	symbol_count: number
	pagerank: number
	is_barrel: boolean
}

interface Edge {
	source_file_id: number
	target_file_id: number
	weight: number
	confidence: number
}

interface Ref {
	id: number
	file_id: number
	name: string
	source_file_id: number | null
	import_source: string
}

interface RepoMapConfig {
	cwd: string
	db: Database
}

export class RepoMap {
	private db: Database
	private cwd: string
	private treeSitter: TreeSitterBackend
	private cache: FileCache
	private stmts: Record<string, Statement> = {}
	// Scan state for batch operations
	private scanFiles: string[] = []
	private scanTotalFiles: number = 0

	constructor(config: RepoMapConfig) {
		this.cwd = resolve(config.cwd)
		this.db = config.db
		this.treeSitter = new TreeSitterBackend()
		this.cache = new FileCache(200)
		this.treeSitter.setCache(this.cache)
		this.prepareStatements()
	}

	/**
	 * Execute `fn` inside a DB transaction, retrying on SQLITE_BUSY with
	 * bounded backoff. All write paths in this class must go through this
	 * helper so that rare lock contention with concurrent followers'
	 * readonly readers (or a cross-process checkpoint) doesn't surface as
	 * a user-visible error.
	 *
	 * Reads continue to go through plain `this.stmts.*.get/all()` — under
	 * WAL they never block and never get SQLITE_BUSY, so the retry
	 * machinery is pure overhead for them.
	 */
	private txWrite<T>(fn: () => T): Promise<T> {
		return withSqliteBusyRetry(() => this.db.transaction(fn)())
	}

	private prepareStatements(): void {
		this.stmts = {
			getFileById: this.db.prepare('SELECT * FROM files WHERE id = ?'),
			getFileByPath: this.db.prepare('SELECT * FROM files WHERE path = ?'),
			getSymbolsByFileId: this.db.prepare('SELECT * FROM symbols WHERE file_id = ?'),
			getRefsByFileId: this.db.prepare('SELECT * FROM refs WHERE file_id = ?'),
			getEdgesBySource: this.db.prepare('SELECT * FROM edges WHERE source_file_id = ?'),
			getEdgesByTarget: this.db.prepare('SELECT * FROM edges WHERE target_file_id = ?'),
			getAllFiles: this.db.prepare('SELECT * FROM files ORDER BY pagerank DESC'),
			getAllSymbols: this.db.prepare('SELECT * FROM symbols'),
			getSymbolsByName: this.db.prepare('SELECT id, name, line, file_id FROM symbols WHERE name = ? LIMIT 10'),
			getAllEdges: this.db.prepare('SELECT * FROM edges'),
			getAllRefs: this.db.prepare('SELECT * FROM refs'),
			insertFile: this.db.prepare(`
        INSERT OR REPLACE INTO files (path, mtime_ms, language, line_count, symbol_count, pagerank, is_barrel, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
			insertSymbol: this.db.prepare(`
        INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported, signature, qualified_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `),
			insertRef: this.db.prepare(`
        INSERT INTO refs (file_id, name, source_file_id, import_source)
        VALUES (?, ?, ?, ?)
      `),
			insertEdge: this.db.prepare(`
        INSERT OR REPLACE INTO edges (source_file_id, target_file_id, weight, confidence)
        VALUES (?, ?, ?, ?)
      `),
			insertCoChange: this.db.prepare(`
        INSERT OR REPLACE INTO cochanges (file_id_a, file_id_b, count)
        VALUES (?, ?, ?)
      `),
			deleteFile: this.db.prepare('DELETE FROM files WHERE id = ?'),
			deleteRefsByFileId: this.db.prepare('DELETE FROM refs WHERE file_id = ?'),
			deleteEdgesBySource: this.db.prepare('DELETE FROM edges WHERE source_file_id = ?'),
			deleteEdgesByTarget: this.db.prepare('DELETE FROM edges WHERE target_file_id = ?'),
			deleteSymbolsByFileId: this.db.prepare('DELETE FROM symbols WHERE file_id = ?'),
			deleteShapeHashesByFileId: this.db.prepare('DELETE FROM shape_hashes WHERE file_id = ?'),
			deleteTokenSignaturesByFileId: this.db.prepare('DELETE FROM token_signatures WHERE file_id = ?'),
			deleteTokenFragmentsByFileId: this.db.prepare('DELETE FROM token_fragments WHERE file_id = ?'),
			deleteExternalImportsByFileId: this.db.prepare('DELETE FROM external_imports WHERE file_id = ?'),
			getCounts: this.db.prepare(`
        SELECT 
          (SELECT COUNT(*) FROM files) as files,
          (SELECT COUNT(*) FROM symbols) as symbols,
          (SELECT COUNT(*) FROM edges) as edges
      `),
			// Queries for dependents/dependencies
			getEdgesByTargetFile: this.db.prepare('SELECT * FROM edges WHERE target_file_id = ?'),
			getEdgesBySourceFile: this.db.prepare('SELECT * FROM edges WHERE source_file_id = ?'),
			// Query for blast radius
			getEdgesTargetIds: this.db.prepare('SELECT target_file_id FROM edges WHERE source_file_id = ?'),
			// FTS search
			searchSymbolsFtsQuery: this.db.prepare(`
        SELECT s.name, f.path, s.kind, s.line, s.is_exported AS isExported, f.pagerank, s.id
        FROM symbols_fts ft
        JOIN symbols s ON ft.rowid = s.id
        JOIN files f ON s.file_id = f.id
        WHERE symbols_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `),
			// Call graph queries
			getSymbolByFileAndLine: this.db.prepare(
				'SELECT id, name, kind, line, signature FROM symbols WHERE file_id = ? AND line = ? LIMIT 1',
			),
			getCallersQuery: this.db.prepare(`
        SELECT s.name as caller_name, f.path as caller_path, s.line as caller_line, c.line as call_line
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE c.callee_name = ? AND (c.callee_file_id IS NULL OR c.callee_file_id = ?)
      `),
			getCalleesQuery: this.db.prepare(`
        SELECT c.callee_name, f.path as callee_file, c.line as call_line, s.line as callee_def_line
        FROM calls c
        JOIN files f ON c.callee_file_id = f.id
        JOIN symbols s ON c.callee_symbol_id = s.id
        WHERE c.caller_symbol_id = ?
      `),
			// Co-changes
			getCoChanges: this.db.prepare(`
        SELECT 
          CASE WHEN file_id_a = ? THEN file_id_b ELSE file_id_a END as other_id,
          count
        FROM cochanges 
        WHERE file_id_a = ? OR file_id_b = ?
        ORDER BY count DESC
        LIMIT 20
      `),
			// File symbols query
			getFileSymbolsQuery: this.db.prepare('SELECT * FROM symbols WHERE file_id = ?'),
			// Resolve unresolved refs
			getUnresolvedRefs: this.db.prepare('SELECT * FROM refs WHERE source_file_id IS NULL'),
			resolveRefMatch: this.db.prepare(`
        SELECT s.id, s.file_id, f.path 
        FROM symbols s 
        JOIN files f ON s.file_id = f.id 
        WHERE s.name = ? AND s.is_exported = 1
      `),
			// Test files
			getTestFiles: this.db.prepare(`
        SELECT id, path FROM files 
        WHERE path LIKE '%.test.%' OR path LIKE '%_test.%' OR path LIKE '%.spec.%'
      `),
			// Build call graph helpers - include files with any refs (resolved or unresolved)
			getFilesWithImports: this.db.prepare(`
        SELECT DISTINCT f.id, f.path FROM files f
        WHERE EXISTS (SELECT 1 FROM symbols s WHERE s.file_id = f.id AND s.kind IN ('function', 'method'))
          AND EXISTS (SELECT 1 FROM refs r WHERE r.file_id = f.id AND r.name != '*')
      `),
			getImportsForFile: this.db.prepare<{ name: string; source_file_id: number }, [number]>(`
        SELECT DISTINCT r.name, r.source_file_id FROM refs r
        WHERE r.file_id = ? AND r.source_file_id IS NOT NULL AND r.name != '*'
      `),
			getFunctionsForFile: this.db.prepare<
				{ id: number; name: string; line: number; end_line: number },
				[number]
			>(`
        SELECT id, name, line, end_line FROM symbols
        WHERE file_id = ? AND kind IN ('function', 'method') AND end_line > line
      `),
			resolveCallee: this.db.prepare<{ id: number }, [number, string]>(`
        SELECT id FROM symbols WHERE file_id = ? AND name = ? AND is_exported = 1 LIMIT 1
      `),
			insertCall: this.db.prepare(`
        INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `),
			// Unused exports - single anti-join query
			getUnusedExportsQuery: this.db.prepare(`
        SELECT s.id, s.name, s.kind, s.line, s.end_line, f.path, f.line_count
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.is_exported = 1
          AND NOT EXISTS (
            SELECT 1 FROM refs r WHERE r.name = s.name AND r.source_file_id IS NOT NULL
          )
        LIMIT ?
      `),
			// Orphan files - files with no incoming edges
			getOrphanFilesQuery: this.db.prepare(`
        SELECT f.path, f.language, f.line_count, f.symbol_count
        FROM files f
        LEFT JOIN edges e ON e.target_file_id = f.id
        WHERE e.target_file_id IS NULL
          AND f.is_barrel = 0
          AND f.path NOT LIKE '%.test.%'
          AND f.path NOT LIKE '%.spec.%'
          AND f.path NOT LIKE '%_test.%'
        ORDER BY f.line_count DESC
        LIMIT ?
      `),
			// Reverse edge lookup for change impact BFS
			getEdgesSourceIdsByTarget: this.db.prepare('SELECT source_file_id FROM edges WHERE target_file_id = ?'),
			// Symbol references
			getRefsByName: this.db.prepare(`
        SELECT f.path, r.import_source
        FROM refs r
        JOIN files f ON r.file_id = f.id
        WHERE r.name = ?
      `),
			getCallsByCalleeName: this.db.prepare(`
        SELECT c.line, s.name as caller_name, f.path
        FROM calls c
        JOIN symbols s ON c.caller_symbol_id = s.id
        JOIN files f ON s.file_id = f.id
        WHERE c.callee_name = ?
      `),
			getReexportsByName: this.db.prepare(`
        SELECT f.path, s.line
        FROM symbols s
        JOIN files f ON s.file_id = f.id
        WHERE s.name = ? AND s.is_exported = 1 AND f.is_barrel = 1
      `),
		}
	}

	async initialize(): Promise<void> {
		try {
			await this.treeSitter.initialize(this.cwd)
			this.initSchema()
		} catch (err) {
			console.error('Failed to initialize RepoMap:', err)
			throw err
		}
	}

	private initSchema(): void {
		this.db.run(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id INTEGER PRIMARY KEY,
        version INTEGER NOT NULL
      )
    `)

		const version = this.db.prepare('SELECT version FROM schema_version ORDER BY id DESC LIMIT 1').get() as
			| { version: number }
			| undefined

		if (!version || version.version < 1) {
			this.db.run('INSERT INTO schema_version (version) VALUES (1)')
		}

		// Only populate FTS if symbols table exists
		try {
			const ftsCount = this.db.prepare('SELECT COUNT(*) as c FROM symbols_fts').get() as { c: number } | undefined
			if (!ftsCount || ftsCount.c === 0) {
				const symbols = this.stmts.getAllSymbols.all() as Array<{
					id: number
					name: string
					kind: string
					file_id: number
				}>
				for (const sym of symbols) {
					const file = this.stmts.getFileById.get(sym.file_id) as { path: string } | undefined
					if (file) {
						try {
							this.db.run('INSERT INTO symbols_fts (rowid, name, path, kind) VALUES (?, ?, ?, ?)', [
								sym.id,
								sym.name,
								file.path,
								sym.kind,
							])
						} catch {
							// FTS insert may fail
						}
					}
				}
			}
		} catch {
			// FTS table may not exist yet - that's ok, it will be created by database.ts
		}
	}

	async scan(): Promise<void> {
		// For backward compatibility, use the staged scan approach
		await this.prepareScan()
		let offset = 0
		let completed = false
		while (!completed) {
			const result = await this.scanBatch(offset, GRAPH_SCAN_BATCH_SIZE)
			offset = result.nextOffset
			completed = result.completed
		}
		await this.finalizeScan()
	}

	/**
	 * Prepare for a full scan by collecting all indexable files and resetting scan state.
	 * Returns the total number of files to process and the batch size to use.
	 */
	async prepareScan(): Promise<PrepareScanResult> {
		// Collect all indexable files without any cap
		const result = await collectFilesAsync(this.cwd)
		this.scanFiles = result.files.map(f => relative(this.cwd, f.path))
		this.scanTotalFiles = this.scanFiles.length

		// Reset derived state tables before fresh scan to avoid stale data
		await this.resetGraphDataForFullScan()

		return {
			totalFiles: this.scanTotalFiles,
			batchSize: GRAPH_SCAN_BATCH_SIZE,
		}
	}

	/**
	 * Scan a batch of files starting at the given offset.
	 * Returns progress info including whether scanning is complete.
	 *
	 * Each file is guarded by a per-file timeout so one pathological file
	 * (e.g. very large, tree-sitter bug, syscall stall) cannot starve the
	 * whole batch. Timed-out files are counted in `skippedTimeouts` and the
	 * scan continues.
	 */
	async scanBatch(offset: number, batchSize: number): Promise<ScanBatchResult> {
		const filesToProcess = this.scanFiles.slice(offset, offset + batchSize)
		const processedCount = filesToProcess.length
		const startedAt = Date.now()
		let skippedTimeouts = 0

		for (const filePath of filesToProcess) {
			try {
				await this.indexFileWithTimeout(filePath, GRAPH_SCAN_PER_FILE_TIMEOUT_MS)
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err)
				if (msg.startsWith('__indexFileTimeout__')) {
					skippedTimeouts++
					console.error(`Skipping ${filePath}: indexing exceeded ${GRAPH_SCAN_PER_FILE_TIMEOUT_MS}ms`)
				} else {
					console.error(`Error indexing ${filePath}:`, err)
				}
			}
		}

		const nextOffset = offset + processedCount
		const completed = nextOffset >= this.scanTotalFiles

		return {
			processed: processedCount,
			completed,
			nextOffset,
			totalFiles: this.scanTotalFiles,
			elapsedMs: Date.now() - startedAt,
			skippedTimeouts,
		}
	}

	/**
	 * Race indexFile() against a wall-clock timeout. On timeout the indexing
	 * promise is orphaned (tree-sitter parsing is CPU-bound and not
	 * cancellable); the scan proceeds with the next file. The orphan's
	 * eventual settle is swallowed to avoid unhandled rejections.
	 */
	private async indexFileWithTimeout(filePath: string, timeoutMs: number): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | null = null
		const indexingPromise = this.indexFile(filePath)
		// Keep errors from rejecting the process after the race is resolved.
		indexingPromise.catch(() => {})
		try {
			await Promise.race([
				indexingPromise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`__indexFileTimeout__:${filePath}`)), timeoutMs)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	/**
	 * Finalize the scan by building all derived state (refs, edges, PageRank, etc).
	 * Should be called once after all file batches have been processed.
	 */
	async finalizeScan(): Promise<void> {
		await this.resolveUnresolvedRefs()
		await this.buildEdges()
		await this.computePageRank()
		await this.linkTestFiles()
		await this.buildCallGraph()
		await this.buildCoChanges()
		await this.rescueOrphans()
	}

	/**
	 * Reset graph data tables before a fresh full scan.
	 * This ensures stale file entries and derived data from previous scans are removed.
	 */
	private async resetGraphDataForFullScan(): Promise<void> {
		await this.txWrite(() => {
			this.db.run('DELETE FROM refs')
			this.db.run('DELETE FROM edges')
			this.db.run('DELETE FROM calls')
			this.db.run('DELETE FROM cochanges')
			this.db.run('DELETE FROM shape_hashes')
			this.db.run('DELETE FROM token_signatures')
			this.db.run('DELETE FROM token_fragments')
			this.db.run('DELETE FROM external_imports')
			this.db.run('DELETE FROM semantic_summaries')
			// Drop and recreate FTS table to avoid trigger issues on empty content tables
			this.db.run('DROP TABLE IF EXISTS symbols_fts')
			this.db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5(
          name,
          path,
          kind
        )
      `)
			this.db.run('DROP TRIGGER IF EXISTS symbols_ai')
			this.db.run('DROP TRIGGER IF EXISTS symbols_ad')
			this.db.run('DROP TRIGGER IF EXISTS symbols_au')
			this.db.run(`
        CREATE TRIGGER symbols_ai AFTER INSERT ON symbols BEGIN
          INSERT INTO symbols_fts(rowid, name, path, kind)
          VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
        END
      `)
			this.db.run(`
        CREATE TRIGGER symbols_ad AFTER DELETE ON symbols BEGIN
          DELETE FROM symbols_fts WHERE rowid = old.id;
        END
      `)
			this.db.run(`
        CREATE TRIGGER symbols_au AFTER UPDATE ON symbols BEGIN
          DELETE FROM symbols_fts WHERE rowid = old.id;
          INSERT INTO symbols_fts(rowid, name, path, kind)
          VALUES (new.id, new.name, (SELECT path FROM files WHERE id = new.file_id), new.kind);
        END
      `)
			this.db.run('DELETE FROM symbols')
			this.db.run('DELETE FROM files')
		})
	}

	async indexFile(filePath: string): Promise<void> {
		const absPath = filePath.startsWith('/') ? filePath : resolve(this.cwd, filePath)
		const relPath = relative(this.cwd, absPath)

		const ext = extname(absPath).toLowerCase()
		if (!(ext in INDEXABLE_EXTENSIONS)) return

		let stats: { size: number; mtimeMs: number }
		try {
			stats = statSync(absPath)
		} catch {
			return
		}

		if (stats.size > 500_000) return

		const outline = await this.treeSitter.getFileOutline(absPath)
		if (!outline) return

		const existing = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
		if (existing && existing.mtime_ms === stats.mtimeMs) {
			return
		}

		const isBarrel = isBarrelFile(relPath)
		const lineCount =
			outline.symbols.length > 0
				? Math.max(...outline.symbols.map(s => s.location.endLine || s.location.line))
				: 1

		// Async I/O: collect all data before entering the synchronous transaction
		const { readFile } = await import('fs/promises')
		const content = await readFile(absPath, 'utf-8')
		const lines = content.split('\n')

		// Pre-resolve imports
		const resolvedImports: Array<{
			specifiers: string[]
			sourceFileId: number | null
			importSource: string
		}> = []
		const externalImports: Array<{ package: string; specifiers: string[] }> = []

		for (const imp of outline.imports) {
			const isRelative = imp.source.startsWith('.') || imp.source.startsWith('/')

			if (isRelative) {
				const resolvedSource = await this.resolveImportSource(imp.source, absPath)
				let sourceFileId: number | null = null
				if (resolvedSource) {
					const resolvedFile = this.stmts.getFileByPath.get(resolvedSource) as IndexedFile | undefined
					if (resolvedFile) {
						sourceFileId = resolvedFile.id
					}
				}
				resolvedImports.push({
					specifiers: imp.specifiers,
					sourceFileId,
					importSource: imp.source,
				})
			} else {
				let packageName: string
				if (imp.source.startsWith('@')) {
					const parts = imp.source.split('/')
					packageName = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0]
				} else {
					packageName = imp.source.split('/')[0]
				}
				externalImports.push({ package: packageName, specifiers: imp.specifiers })
			}
		}

		const shapeHashes = await this.treeSitter.getShapeHashes(filePath)

		// Pre-compute token data
		const tokenSignatures: Array<{
			name: string
			line: number
			endLine: number
			minhash: Uint32Array
		}> = []
		let fragmentHashes: Array<{ hash: string; tokenOffset: number }> = []
		try {
			const cachedContent = (await this.cache.get(absPath)) || ''
			const tokens = tokenize(cachedContent)
			const minhash = computeMinHash(tokens)
			if (minhash) {
				for (const sym of outline.symbols) {
					const symMinhash = computeMinHash(
						tokens.slice(
							Math.floor(((sym.location.line - 1) * tokens.length) / lineCount),
							Math.floor(((sym.location.endLine || sym.location.line) * tokens.length) / lineCount),
						),
					)
					if (symMinhash) {
						tokenSignatures.push({
							name: sym.name,
							line: sym.location.line,
							endLine: sym.location.endLine || sym.location.line,
							minhash: symMinhash,
						})
					}
				}
				fragmentHashes = computeFragmentHashes(tokens)
			}
		} catch (err) {
			console.debug('Token extraction failed for file:', filePath, err)
		}

		// All DB writes in a single transaction (retries on SQLITE_BUSY).
		await this.txWrite(() => {
			// Re-check inside the transaction to avoid races with concurrent
			// indexFile flows that may have inserted a row for the same path
			// between our pre-transaction read and here.
			const current = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
			if (current) {
				this.stmts.deleteRefsByFileId.run([current.id])
				this.stmts.deleteEdgesBySource.run([current.id])
				this.stmts.deleteEdgesByTarget.run([current.id])
				this.stmts.deleteSymbolsByFileId.run([current.id])
				this.stmts.deleteShapeHashesByFileId.run([current.id])
				this.stmts.deleteTokenSignaturesByFileId.run([current.id])
				this.stmts.deleteTokenFragmentsByFileId.run([current.id])
				this.stmts.deleteFile.run([current.id])
			}

			const fileId = this.db.run(
				'INSERT INTO files (path, mtime_ms, language, line_count, symbol_count, pagerank, is_barrel, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				[
					relPath,
					stats.mtimeMs,
					outline.language,
					lineCount,
					outline.symbols.length,
					0,
					isBarrel ? 1 : 0,
					Date.now(),
				],
			).lastInsertRowid as number

			const seenSymbols = new Set<string>()
			for (const sym of outline.symbols) {
				const key = `${sym.location.line}-${sym.name}-${sym.kind}`
				if (seenSymbols.has(key)) continue
				seenSymbols.add(key)

				const signature = extractSignature(lines, sym.location.line - 1, sym.kind)
				this.stmts.insertSymbol.run([
					fileId,
					sym.name,
					sym.kind,
					sym.location.line,
					sym.location.endLine || sym.location.line,
					outline.exports.some(e => e.name === sym.name) ? 1 : 0,
					signature || null,
					sym.name,
				])
			}

			for (const ref of resolvedImports) {
				for (const specifier of ref.specifiers) {
					this.stmts.insertRef.run([fileId, specifier, ref.sourceFileId, ref.importSource])
				}
			}

			for (const extImp of externalImports) {
				this.db.run('INSERT INTO external_imports (file_id, package, specifiers) VALUES (?, ?, ?)', [
					fileId,
					extImp.package,
					extImp.specifiers.join(','),
				])
			}

			if (shapeHashes) {
				for (const hash of shapeHashes) {
					this.db.run(
						'INSERT INTO shape_hashes (file_id, name, kind, line, end_line, shape_hash, node_count) VALUES (?, ?, ?, ?, ?, ?, ?)',
						[fileId, hash.name, hash.kind, hash.line, hash.endLine, hash.shapeHash, hash.nodeCount],
					)
				}
			}

			for (const sig of tokenSignatures) {
				this.db.run(
					'INSERT INTO token_signatures (file_id, name, line, end_line, minhash) VALUES (?, ?, ?, ?, ?)',
					[fileId, sig.name, sig.line, sig.endLine, sig.minhash],
				)
			}

			for (const frag of fragmentHashes) {
				this.db.run(
					'INSERT INTO token_fragments (hash, file_id, name, line, token_offset) VALUES (?, ?, ?, ?, ?)',
					[frag.hash, fileId, '', 1, frag.tokenOffset],
				)
			}
		})
	}

	private async resolveImportSource(importSource: string, fromFile: string): Promise<string | null> {
		const fromDir = dirname(fromFile)

		if (importSource.startsWith('.')) {
			const resolved = resolve(fromDir, importSource)

			if (existsSync(resolved)) return relative(this.cwd, resolved)

			for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.py', '.go', '.rs']) {
				if (existsSync(resolved + ext)) {
					return relative(this.cwd, resolved + ext)
				}
			}

			for (const index of ['/index.ts', '/index.tsx', '/index.js', '/__init__.py']) {
				if (existsSync(resolved + index)) {
					return relative(this.cwd, resolved + index)
				}
			}

			return null
		}

		return null
	}

	async resolveUnresolvedRefs(): Promise<void> {
		const unresolved = this.stmts.getUnresolvedRefs.all() as Ref[]
		if (unresolved.length === 0) return

		const findExported = this.db.prepare(`
      SELECT s.id, s.file_id, f.path
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name = ? AND s.is_exported = 1
    `)

		await this.txWrite(() => {
			for (const ref of unresolved) {
				const matches = findExported.all(ref.name) as Array<{
					id: number
					file_id: number
					path: string
				}>

				if (matches.length >= 1) {
					if (ref.import_source) {
						const pathMatch = matches.find(m => {
							const importPath = ref.import_source.startsWith('.') ? ref.import_source : ref.import_source
							return m.path === importPath || m.path.endsWith(importPath)
						})
						if (pathMatch) {
							this.db.run('UPDATE refs SET source_file_id = ? WHERE id = ?', [pathMatch.file_id, ref.id])
							continue
						}
					}

					this.db.run('UPDATE refs SET source_file_id = ? WHERE id = ?', [matches[0].file_id, ref.id])
				}
			}
		})
	}

	async buildEdges(): Promise<void> {
		const refs = this.stmts.getAllRefs.all() as Ref[]
		const edgeMap = new Map<string, { weight: number; confidence: number }>()

		for (const ref of refs) {
			if (ref.source_file_id) {
				const key = `${ref.file_id}-${ref.source_file_id}`
				const existing = edgeMap.get(key)
				if (existing) {
					edgeMap.set(key, { weight: existing.weight + 1, confidence: existing.confidence })
				} else {
					edgeMap.set(key, { weight: 1, confidence: 1 })
				}
			}
		}

		await this.txWrite(() => {
			for (const [key, data] of edgeMap) {
				const [source, target] = key.split('-').map(Number)
				const idf = Math.log(2)
				const dampenedWeight = data.weight * idf
				this.stmts.insertEdge.run([source, target, dampenedWeight, data.confidence])
			}
		})
	}

	async computePageRank(): Promise<void> {
		const files = this.stmts.getAllFiles.all() as IndexedFile[]
		const n = files.length

		if (n === 0) return

		const damping = PAGERANK_DAMPING
		const iterations = PAGERANK_ITERATIONS

		const ranks = new Map<number, number>()
		for (const file of files) {
			ranks.set(file.id, 1 / n)
		}

		const edges = this.stmts.getAllEdges.all() as Edge[]
		const outgoing = new Map<number, number>()
		const incoming = new Map<number, Edge[]>()

		for (const edge of edges) {
			outgoing.set(edge.source_file_id, (outgoing.get(edge.source_file_id) || 0) + edge.weight)
			if (!incoming.has(edge.target_file_id)) {
				incoming.set(edge.target_file_id, [])
			}
			incoming.get(edge.target_file_id)!.push(edge)
		}

		for (let iter = 0; iter < iterations; iter++) {
			const newRanks = new Map<number, number>()

			for (const file of files) {
				let rank = (1 - damping) / n

				const incomingEdges = incoming.get(file.id) || []
				for (const edge of incomingEdges) {
					const outWeight = outgoing.get(edge.source_file_id) || 1
					const sourceRank = ranks.get(edge.source_file_id) || 0
					rank += damping * ((sourceRank * edge.weight) / outWeight)
				}

				newRanks.set(file.id, rank)
			}

			ranks.clear()
			for (const [k, v] of newRanks) {
				ranks.set(k, v)
			}
		}

		await this.txWrite(() => {
			for (const file of files) {
				const rank = ranks.get(file.id) || 0
				this.db.run('UPDATE files SET pagerank = ? WHERE id = ?', [rank, file.id])
			}
		})
	}

	async computePageRankSync(): Promise<void> {
		await this.computePageRank()
	}

	async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
		const maxFiles = opts?.maxFiles ?? 20
		const maxSymbolsPerFile = opts?.maxSymbols ?? 5

		const files = this.stmts.getAllFiles.all() as IndexedFile[]
		if (!files || files.length === 0) {
			return { content: '', paths: [] }
		}

		const topFiles = files.slice(0, maxFiles)

		let content = ''
		const paths: string[] = []

		for (const file of topFiles) {
			const symbols = this.stmts.getSymbolsByFileId.all(file.id) as DbSymbol[]
			if (!symbols || symbols.length === 0) continue

			content += `// ${file.path}\n`
			for (const sym of symbols.slice(0, maxSymbolsPerFile)) {
				content += `//   ${kindTag(sym.kind as SymbolKind)}${sym.name}\n`
			}
			content += '\n'
			paths.push(file.path)
		}

		return { content, paths }
	}

	getStats(): GraphStats {
		const counts = this.stmts.getCounts.get() as { files: number; symbols: number; edges: number }
		const summaries = this.db.prepare('SELECT COUNT(*) as count FROM semantic_summaries').get() as {
			count: number
		}
		const calls = this.db.prepare('SELECT COUNT(*) as count FROM calls').get() as { count: number }

		return {
			files: counts.files,
			symbols: counts.symbols,
			edges: counts.edges,
			summaries: summaries.count,
			calls: calls.count,
		}
	}

	getTopFiles(limit = 20): TopFileResult[] {
		const files = this.db.prepare('SELECT * FROM files ORDER BY pagerank DESC LIMIT ?').all(limit) as DbFile[]
		return files.map(f => ({
			path: f.path,
			pagerank: f.pagerank,
			lines: f.line_count,
			symbols: f.symbol_count,
			language: f.language,
		}))
	}

	getFileDependents(path: string): FileDepResult[] {
		const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
		if (!file) return []

		const edges = this.stmts.getEdgesByTargetFile.all(file.id) as Edge[]
		const results: FileDepResult[] = []

		for (const edge of edges) {
			const source = this.stmts.getFileById.get(edge.source_file_id) as IndexedFile | undefined
			if (source) {
				results.push({ path: source.path, weight: edge.weight })
			}
		}

		return results
	}

	getFileDependencies(path: string): FileDepResult[] {
		const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
		if (!file) return []

		const edges = this.stmts.getEdgesBySourceFile.all(file.id) as Edge[]
		const results: FileDepResult[] = []

		for (const edge of edges) {
			const target = this.stmts.getFileById.get(edge.target_file_id) as IndexedFile | undefined
			if (target) {
				results.push({ path: target.path, weight: edge.weight })
			}
		}

		return results
	}

	getFileCoChanges(path: string): FileCoChangeResult[] {
		const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
		if (!file) return []

		const cochanges = this.stmts.getCoChanges.all(file.id, file.id, file.id) as Array<{
			other_id: number
			count: number
		}>

		return cochanges
			.map(c => {
				const other = this.stmts.getFileById.get(c.other_id) as IndexedFile | undefined
				return {
					path: other?.path || '',
					count: c.count,
				}
			})
			.filter(r => r.path)
	}

	getFileBlastRadius(path: string): number {
		const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
		if (!file) return 0

		const visited = new Set<number>()
		const queue = [file.id]

		while (queue.length > 0) {
			const id = queue.shift()!
			if (visited.has(id)) continue
			visited.add(id)

			const edges = this.stmts.getEdgesTargetIds.all(id) as Array<{ target_file_id: number }>
			for (const edge of edges) {
				if (!visited.has(edge.target_file_id)) {
					queue.push(edge.target_file_id)
				}
			}
		}

		return visited.size - 1
	}

	getFileSymbols(path: string): FileSymbolResult[] {
		const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
		if (!file) return []

		const symbols = this.stmts.getFileSymbolsQuery.all(file.id) as DbSymbol[]
		return symbols.map(s => ({
			name: s.name,
			kind: s.kind,
			isExported: !!s.is_exported,
			line: s.line,
			endLine: s.end_line,
		}))
	}

	findSymbols(query: string, limit = 50): SymbolSearchResult[] {
		const results = this.db
			.prepare(`
      SELECT s.name, f.path, s.kind, s.line, s.is_exported AS isExported, f.pagerank, s.id
      FROM symbols s
      JOIN files f ON s.file_id = f.id
      WHERE s.name LIKE ?
      ORDER BY f.pagerank DESC
      LIMIT ?
    `)
			.all(`%${query}%`, limit) as Array<SymbolSearchResult & { id: number }>

		return results
	}

	searchSymbolsFts(query: string, limit = 50): SymbolSearchResult[] {
		try {
			const results = this.stmts.searchSymbolsFtsQuery.all(query, limit) as Array<
				SymbolSearchResult & { id: number }
			>

			return results
		} catch {
			return []
		}
	}

	getSymbolSignature(path: string, line: number): SymbolSignatureResult | null {
		const file = this.stmts.getFileByPath.get(path) as IndexedFile | undefined
		if (!file) return null

		const symbol = this.stmts.getSymbolByFileAndLine.get(file.id, line) as
			| { id: number; name: string; kind: string; line: number; signature?: string }
			| undefined

		if (!symbol) return null

		return {
			path,
			kind: symbol.kind,
			signature: symbol.signature || '',
			line: symbol.line,
		}
	}

	getCallers(path: string, line: number, minConfidence = 0): CallerResult[] {
		// Find the symbol at the given location
		const fileId = this.stmts.getFileByPath.get(path) as { id: number } | undefined
		if (!fileId) return []

		const symbol = this.stmts.getSymbolByFileAndLine.get(fileId.id, line) as
			| { id: number; name: string }
			| undefined

		if (!symbol) return []

		// Find all calls where this symbol is the callee - use both name and file for disambiguation
		const callers = this.db
			.prepare(`
      SELECT s.name as caller_name, f.path as caller_path, s.line as caller_line, c.line as call_line,
             c.confidence, c.tier
      FROM calls c
      JOIN symbols s ON c.caller_symbol_id = s.id
      JOIN files f ON s.file_id = f.id
      WHERE c.callee_name = ? AND (c.callee_file_id IS NULL OR c.callee_file_id = ?)
        AND c.confidence >= ?
    `)
			.all(symbol.name, fileId.id, minConfidence) as Array<{
			caller_name: string
			caller_path: string
			caller_line: number
			call_line: number
			confidence: number
			tier: EdgeConfidenceTier
		}>

		return callers.map(c => ({
			callerName: c.caller_name,
			callerPath: c.caller_path,
			callerLine: c.caller_line,
			callLine: c.call_line,
			confidence: c.confidence,
			tier: c.tier,
		}))
	}

	getCallees(path: string, line: number, minConfidence = 0): CalleeResult[] {
		// Find the symbol at the given location
		const fileId = this.stmts.getFileByPath.get(path) as { id: number } | undefined
		if (!fileId) return []

		const symbol = this.stmts.getSymbolByFileAndLine.get(fileId.id, line) as
			| { id: number; name: string }
			| undefined

		if (!symbol) return []

		// Find all calls made by this symbol - use symbol id for precise matching
		const callees = this.db
			.prepare(`
      SELECT c.callee_name, f.path as callee_file, c.line as call_line, 
             (SELECT line FROM symbols WHERE id = c.callee_symbol_id) as callee_def_line,
             c.confidence, c.tier
      FROM calls c
      JOIN files f ON c.callee_file_id = f.id
      WHERE c.caller_symbol_id = ?
        AND c.confidence >= ?
    `)
			.all(symbol.id, minConfidence) as Array<{
			callee_name: string
			callee_file: string
			call_line: number
			callee_def_line: number | undefined
			confidence: number
			tier: EdgeConfidenceTier
		}>

		return callees.map(c => ({
			calleeName: c.callee_name,
			calleeFile: c.callee_file,
			calleeLine: c.callee_def_line || c.call_line,
			callLine: c.call_line,
			confidence: c.confidence,
			tier: c.tier,
		}))
	}

	/**
	 * BFS traversal over the call graph starting from the symbol at (path, line).
	 *
	 * Budget-aware: stops on whichever of `maxDepth`, `maxNodes`, or
	 * `maxTokens` hits first. `maxTokens` is a coarse cap on the cumulative
	 * size of emitted node identifiers (`name + path`); it is not a real
	 * LLM tokenizer, just a cheap proxy to bound output size for tooling.
	 *
	 * Edges below `minConfidence` (see Etap 9b) are skipped entirely,
	 * so walking from an EXTRACTED-only perspective is just
	 * `{ minConfidence: 1.0 }`.
	 */
	traverse(opts: {
		path: string
		line: number
		direction?: 'in' | 'out' | 'both'
		maxDepth?: number
		maxTokens?: number
		minConfidence?: number
		maxNodes?: number
	}): import('./types').TraverseResult {
		const direction = opts.direction ?? 'out'
		const maxDepth = Math.max(1, opts.maxDepth ?? 3)
		const maxNodes = Math.max(1, opts.maxNodes ?? 500)
		const maxTokens = opts.maxTokens ?? Number.POSITIVE_INFINITY
		const minConfidence = opts.minConfidence ?? 0

		const fileRow = this.stmts.getFileByPath.get(opts.path) as { id: number } | undefined
		if (!fileRow) {
			return {
				root: { name: '', path: opts.path, line: opts.line },
				nodes: [],
				truncated: false,
			}
		}

		const rootSym = this.stmts.getSymbolByFileAndLine.get(fileRow.id, opts.line) as
			| { id: number; name: string }
			| undefined
		if (!rootSym) {
			return {
				root: { name: '', path: opts.path, line: opts.line },
				nodes: [],
				truncated: false,
			}
		}

		// Prepare queries lazily — avoids bloating the stmts cache for users
		// who never traverse.
		const callersStmt = this.db.prepare(`
			SELECT s.id, s.name, s.line, f.path, c.confidence, c.tier
			FROM calls c
			JOIN symbols s ON c.caller_symbol_id = s.id
			JOIN files f ON s.file_id = f.id
			WHERE c.callee_name = ? AND (c.callee_file_id IS NULL OR c.callee_file_id = ?)
			  AND c.confidence >= ?
		`)
		const calleesStmt = this.db.prepare(`
			SELECT s2.id, s2.name, s2.line, f2.path, c.confidence, c.tier
			FROM calls c
			JOIN symbols s2 ON c.callee_symbol_id = s2.id
			JOIN files f2 ON s2.file_id = f2.id
			WHERE c.caller_symbol_id = ? AND c.confidence >= ?
		`)

		interface QItem {
			symbolId: number
			symbolName: string
			symbolPath: string
			fileId: number
			depth: number
		}
		const visited = new Set<number>()
		visited.add(rootSym.id)

		const rootPathRow = this.stmts.getFileById.get(fileRow.id) as { path: string } | undefined
		const rootPath = rootPathRow?.path ?? opts.path
		const queue: QItem[] = [
			{
				symbolId: rootSym.id,
				symbolName: rootSym.name,
				symbolPath: rootPath,
				fileId: fileRow.id,
				depth: 0,
			},
		]
		const nodes: import('./types').TraverseNode[] = []
		let tokens = 0
		let truncated = false
		let stopReason: 'maxDepth' | 'maxTokens' | 'maxNodes' | undefined

		while (queue.length > 0) {
			const item = queue.shift()!
			if (item.depth >= maxDepth) {
				// Depth cap reached for this branch; other branches may still expand.
				// We still emit the boundary node if present (added when discovered).
				continue
			}

			type Neighbour = {
				id: number
				name: string
				line: number
				path: string
				confidence: number
				tier: EdgeConfidenceTier
			}
			const neighbours: Neighbour[] = []
			if (direction === 'in' || direction === 'both') {
				const rows = callersStmt.all(item.symbolName, item.fileId, minConfidence) as Neighbour[]
				neighbours.push(...rows)
			}
			if (direction === 'out' || direction === 'both') {
				const rows = calleesStmt.all(item.symbolId, minConfidence) as Neighbour[]
				neighbours.push(...rows)
			}

			for (const n of neighbours) {
				if (visited.has(n.id)) continue
				visited.add(n.id)

				const cost = n.name.length + n.path.length
				if (tokens + cost > maxTokens) {
					truncated = true
					stopReason = 'maxTokens'
					break
				}
				if (nodes.length >= maxNodes) {
					truncated = true
					stopReason = 'maxNodes'
					break
				}
				tokens += cost
				nodes.push({
					name: n.name,
					path: n.path,
					line: n.line,
					depth: item.depth + 1,
					edgeConfidence: n.confidence,
					edgeTier: n.tier,
				})

				if (item.depth + 1 < maxDepth) {
					const nFileRow = this.stmts.getFileByPath.get(n.path) as { id: number } | undefined
					queue.push({
						symbolId: n.id,
						symbolName: n.name,
						symbolPath: n.path,
						fileId: nFileRow?.id ?? 0,
						depth: item.depth + 1,
					})
				}
			}
			if (truncated) break
		}

		if (!truncated && queue.length > 0) {
			// Queue still had work but maxDepth filter kept us from emitting more.
			stopReason = 'maxDepth'
		}

		return {
			root: { name: rootSym.name, path: rootPath, line: opts.line },
			nodes,
			truncated,
			stopReason,
		}
	}

	/**
	 * Produces a compact JSON snapshot of the current graph state suitable
	 * for committing as a PR artefact or diffing against a later snapshot.
	 *
	 * The snapshot is intentionally schema-stable (see `GraphSnapshot.version`)
	 * so older snapshots remain readable after schema migrations.
	 */
	snapshot(label: string): import('./types').GraphSnapshot {
		const files = this.db
			.prepare(
				`SELECT f.id, f.path, f.language, f.pagerank, f.symbol_count
				 FROM files f ORDER BY f.path ASC`,
			)
			.all() as Array<{
			id: number
			path: string
			language: string
			pagerank: number
			symbol_count: number
		}>

		const filesOut: import('./types').GraphSnapshot['files'] = {}
		const symbolsStmt = this.db.prepare(
			`SELECT name, line FROM symbols WHERE file_id = ? ORDER BY line ASC, name ASC`,
		)
		for (const f of files) {
			const syms = symbolsStmt.all(f.id) as Array<{ name: string; line: number }>
			const payload = syms.map(s => `${s.name}:${String(s.line)}`).join('|')
			const symbolsHash = hashBytesToHex(new TextEncoder().encode(payload))
			filesOut[f.path] = {
				language: f.language,
				symbolCount: f.symbol_count,
				pagerank: f.pagerank,
				symbolsHash,
			}
		}

		const topSymbols = (
			this.db
				.prepare(
					`SELECT s.name, f.path, f.pagerank
					 FROM symbols s JOIN files f ON s.file_id = f.id
					 ORDER BY f.pagerank DESC, s.name ASC LIMIT 50`,
				)
				.all() as Array<{ name: string; path: string; pagerank: number }>
		).map(r => ({ name: r.name, path: r.path, pagerank: r.pagerank }))

		const counts = this.db
			.prepare(
				`SELECT
					(SELECT COUNT(*) FROM files) AS files,
					(SELECT COUNT(*) FROM symbols) AS symbols,
					(SELECT COUNT(*) FROM calls) AS calls`,
			)
			.get() as { files: number; symbols: number; calls: number }

		return {
			version: 1,
			label,
			createdAt: Date.now(),
			stats: counts,
			files: filesOut,
			topSymbols,
		}
	}

	/**
	 * Pure diff of two snapshots. Does not touch the DB — callers can
	 * diff snapshots loaded from disk across commits/branches.
	 */
	static diffSnapshots(
		a: import('./types').GraphSnapshot,
		b: import('./types').GraphSnapshot,
	): import('./types').GraphSnapshotDiff {
		const aFiles = new Set(Object.keys(a.files))
		const bFiles = new Set(Object.keys(b.files))

		const added: string[] = []
		const removed: string[] = []
		const changed: string[] = []
		for (const p of bFiles) if (!aFiles.has(p)) added.push(p)
		for (const p of aFiles) if (!bFiles.has(p)) removed.push(p)
		for (const p of bFiles) {
			if (!aFiles.has(p)) continue
			if (a.files[p].symbolsHash !== b.files[p].symbolsHash) changed.push(p)
		}
		added.sort()
		removed.sort()
		changed.sort()

		const aSym = new Map<string, number>()
		for (const s of a.topSymbols) aSym.set(`${s.path}::${s.name}`, s.pagerank)
		const bSym = new Map<string, number>()
		for (const s of b.topSymbols) bSym.set(`${s.path}::${s.name}`, s.pagerank)

		const allKeys = new Set<string>([...aSym.keys(), ...bSym.keys()])
		const topSymbolsDelta: import('./types').GraphSnapshotDiff['topSymbolsDelta'] = []
		for (const key of allKeys) {
			const pa = aSym.get(key) ?? null
			const pb = bSym.get(key) ?? null
			const delta = (pb ?? 0) - (pa ?? 0)
			if (pa === pb) continue
			const [path, name] = key.split('::')
			topSymbolsDelta.push({ name, path, pagerankA: pa, pagerankB: pb, delta })
		}
		topSymbolsDelta.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

		return {
			labelA: a.label,
			labelB: b.label,
			files: { added, removed, changed },
			stats: {
				filesDelta: b.stats.files - a.stats.files,
				symbolsDelta: b.stats.symbols - a.stats.symbols,
				callsDelta: b.stats.calls - a.stats.calls,
			},
			topSymbolsDelta: topSymbolsDelta.slice(0, 25),
		}
	}

	/**
	 * Loads all file-level edges into an adjacency list form and runs
	 * community detection / bridge detection / surprise-edge analysis.
	 * All three share the same in-memory edge list to avoid re-querying.
	 */
	getCommunityAnalysis(opts: { surprisePercentile?: number; maxIterations?: number } = {}): {
		communities: import('./types').CommunityResult[]
		bridges: import('./types').BridgeEdgeResult[]
		surprises: import('./types').SurpriseEdgeResult[]
	} {
		const rows = this.db
			.prepare(
				`SELECT sf.path AS source, tf.path AS target, e.weight AS weight
				 FROM edges e
				 JOIN files sf ON e.source_file_id = sf.id
				 JOIN files tf ON e.target_file_id = tf.id`,
			)
			.all() as Array<{ source: string; target: string; weight: number }>

		const { assignment, communities } = detectCommunities(rows, {
			maxIterations: opts.maxIterations,
		})
		const bridges = detectBridges(rows)
		const surprises = detectSurpriseEdges(rows, assignment, {
			percentile: opts.surprisePercentile,
		})
		return { communities, bridges, surprises }
	}

	/** Convenience: communities only (no bridges/surprises). */
	getCommunities(maxIterations?: number): import('./types').CommunityResult[] {
		return this.getCommunityAnalysis({ maxIterations }).communities
	}

	/** Convenience: bridge edges only. */
	getBridges(): import('./types').BridgeEdgeResult[] {
		return this.getCommunityAnalysis().bridges
	}

	/** Convenience: surprise cross-community edges only. */
	getSurpriseEdges(percentile?: number): import('./types').SurpriseEdgeResult[] {
		return this.getCommunityAnalysis({ surprisePercentile: percentile }).surprises
	}

	/**
	 * Heuristically picks "entry-point" symbols and walks the outgoing
	 * call graph from each one to produce an ordered execution flow.
	 *
	 * Entry-point kinds:
	 *   - `main`    — symbol named `main` or `run`
	 *   - `test`    — any symbol defined in a `*.test.*` / `*.spec.*` file
	 *   - `handler` — symbols whose name matches handler-ish patterns
	 *                 (`handle*`, `*Handler`, `GET/POST/PUT/DELETE`, `route*`)
	 *   - `export`  — exported functions (fallback when nothing else matches)
	 *
	 * Flows are sorted by the entry's file PageRank descending, so the
	 * most "load-bearing" flows surface first.
	 */
	getExecutionFlows(opts: { maxDepth?: number; maxFlows?: number } = {}): import('./types').ExecutionFlow[] {
		const maxDepth = Math.max(1, opts.maxDepth ?? 4)
		const maxFlows = Math.max(1, opts.maxFlows ?? 25)

		// Pull candidate entry points in one query. We classify inline.
		const rows = this.db
			.prepare(
				`SELECT s.id, s.name, s.line, s.is_exported, s.kind, f.id AS file_id, f.path, f.pagerank,
				       (f.path LIKE '%.test.%' OR f.path LIKE '%_test.%' OR f.path LIKE '%.spec.%') AS is_test
				 FROM symbols s JOIN files f ON s.file_id = f.id
				 WHERE s.kind IN ('function', 'method')`,
			)
			.all() as Array<{
			id: number
			name: string
			line: number
			is_exported: number
			kind: string
			file_id: number
			path: string
			pagerank: number
			is_test: number
		}>

		const handlerRe = /^(handle[A-Z_]|route|get|post|put|delete|patch)/i
		const isHandler = (name: string) => handlerRe.test(name) || name.endsWith('Handler')

		interface Candidate {
			id: number
			name: string
			path: string
			line: number
			kind: 'main' | 'test' | 'handler' | 'export'
			weight: number
		}
		const candidates: Candidate[] = []
		for (const r of rows) {
			let kind: Candidate['kind'] | null = null
			if (r.name === 'main' || r.name === 'run') kind = 'main'
			else if (r.is_test) kind = 'test'
			else if (isHandler(r.name)) kind = 'handler'
			else if (r.is_exported) kind = 'export'
			if (!kind) continue
			candidates.push({
				id: r.id,
				name: r.name,
				path: r.path,
				line: r.line,
				kind,
				weight: r.pagerank,
			})
		}
		// Order by (weight desc, kind priority, name) for deterministic output.
		const kindPriority: Record<Candidate['kind'], number> = { main: 0, handler: 1, test: 2, export: 3 }
		candidates.sort((a, b) => {
			if (b.weight !== a.weight) return b.weight - a.weight
			if (kindPriority[a.kind] !== kindPriority[b.kind]) return kindPriority[a.kind] - kindPriority[b.kind]
			return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
		})

		const calleesStmt = this.db.prepare(
			`SELECT s2.id, s2.name, s2.line, f2.path
			 FROM calls c
			 JOIN symbols s2 ON c.callee_symbol_id = s2.id
			 JOIN files f2 ON s2.file_id = f2.id
			 WHERE c.caller_symbol_id = ? AND c.confidence >= 0.7`,
		)

		const flows: import('./types').ExecutionFlow[] = []
		for (const c of candidates.slice(0, maxFlows)) {
			const visited = new Set<number>([c.id])
			const steps: import('./types').ExecutionFlow['steps'] = [
				{ depth: 0, name: c.name, path: c.path, line: c.line },
			]
			const queue: Array<{ id: number; depth: number }> = [{ id: c.id, depth: 0 }]
			let truncated = false
			while (queue.length > 0) {
				const head = queue.shift()!
				if (head.depth >= maxDepth) {
					truncated = true
					continue
				}
				const nexts = calleesStmt.all(head.id) as Array<{
					id: number
					name: string
					line: number
					path: string
				}>
				for (const n of nexts) {
					if (visited.has(n.id)) continue
					visited.add(n.id)
					steps.push({ depth: head.depth + 1, name: n.name, path: n.path, line: n.line })
					queue.push({ id: n.id, depth: head.depth + 1 })
				}
			}
			flows.push({
				entryName: c.name,
				entryPath: c.path,
				entryLine: c.line,
				entryKind: c.kind,
				weight: c.weight,
				steps,
				truncated,
			})
		}
		return flows
	}

	/**
	 * Returns high-PageRank symbols that are not covered by any test
	 * file — candidates for writing new tests. Heuristic:
	 *   1. Take all symbols whose file PageRank is at or above the `percentile`
	 *      cutoff (default p90) of the PageRank distribution across files
	 *      with at least one symbol.
	 *   2. Drop any symbol that is transitively called from a test file.
	 *   3. Sort by `pagerank desc, nonTestCallers desc`.
	 */
	getKnowledgeGaps(opts: { percentile?: number; limit?: number } = {}): import('./types').KnowledgeGapResult[] {
		const percentile = Math.min(Math.max(opts.percentile ?? 0.9, 0), 1)
		const limit = Math.max(1, opts.limit ?? 25)

		const ranks = (
			this.db.prepare('SELECT pagerank FROM files WHERE symbol_count > 0').all() as Array<{
				pagerank: number
			}>
		).map(r => r.pagerank)
		if (ranks.length === 0) return []
		ranks.sort((a, b) => a - b)
		const idx = Math.min(ranks.length - 1, Math.floor(ranks.length * percentile))
		const cutoff = ranks[idx]

		const hotSymbols = this.db
			.prepare(
				`SELECT s.id, s.name, s.line, f.path, f.pagerank
				 FROM symbols s JOIN files f ON s.file_id = f.id
				 WHERE f.pagerank >= ? AND s.kind IN ('function', 'method')`,
			)
			.all(cutoff) as Array<{ id: number; name: string; line: number; path: string; pagerank: number }>

		if (hotSymbols.length === 0) return []

		// For each hot symbol, count callers and whether any caller lives
		// in a test file. One query is cheaper than per-symbol lookups.
		const ids = hotSymbols.map(s => s.id)
		const placeholders = ids.map(() => '?').join(',')
		const callerRows = this.db
			.prepare(
				`SELECT c.callee_symbol_id AS callee_id, f.path AS caller_path
				 FROM calls c
				 JOIN symbols cs ON c.caller_symbol_id = cs.id
				 JOIN files f ON cs.file_id = f.id
				 WHERE c.callee_symbol_id IN (${placeholders}) AND c.confidence >= 0.7`,
			)
			.all(...ids) as Array<{ callee_id: number; caller_path: string }>

		const testRe = /\.test\.|_test\.|\.spec\./
		const totalByCallee = new Map<number, number>()
		const testedCallees = new Set<number>()
		for (const row of callerRows) {
			totalByCallee.set(row.callee_id, (totalByCallee.get(row.callee_id) ?? 0) + 1)
			if (testRe.test(row.caller_path)) testedCallees.add(row.callee_id)
		}

		const gaps: import('./types').KnowledgeGapResult[] = []
		for (const s of hotSymbols) {
			if (testedCallees.has(s.id)) continue
			gaps.push({
				name: s.name,
				path: s.path,
				line: s.line,
				pagerank: s.pagerank,
				nonTestCallers: totalByCallee.get(s.id) ?? 0,
			})
		}
		gaps.sort((a, b) => {
			if (b.pagerank !== a.pagerank) return b.pagerank - a.pagerank
			return b.nonTestCallers - a.nonTestCallers
		})
		return gaps.slice(0, limit)
	}

	getUnusedExports(limit = 50): UnusedExportResult[] {
		const results = this.stmts.getUnusedExportsQuery.all(limit) as Array<{
			id: number
			name: string
			kind: string
			line: number
			end_line: number
			path: string
			line_count: number
		}>

		return results.map(r => ({
			name: r.name,
			path: r.path,
			kind: r.kind,
			line: r.line,
			endLine: r.end_line,
			lineCount: r.line_count,
			usedInternally: false,
		}))
	}

	getDuplicateStructures(limit = 20): DuplicateStructureResult[] {
		const hashes = this.db
			.prepare(`
      SELECT shape_hash, kind, node_count, 
        GROUP_CONCAT(file_id || ':' || line) as members
      FROM shape_hashes
      GROUP BY shape_hash
      HAVING COUNT(*) > 1
      LIMIT ?
    `)
			.all(limit) as Array<{
			shape_hash: string
			kind: string
			node_count: number
			members: string
		}>

		return hashes.map(h => ({
			shapeHash: h.shape_hash,
			kind: h.kind,
			nodeCount: h.node_count,
			members: h.members.split(',').map(m => {
				const [fileId, line] = m.split(':')
				const file = this.stmts.getFileById.get(Number(fileId)) as IndexedFile | undefined
				return { path: file?.path || '', line: Number(line) }
			}),
		}))
	}

	getNearDuplicates(threshold = 0.8, limit = 50): NearDuplicateResult[] {
		const signatures = this.db.prepare('SELECT * FROM token_signatures').all() as Array<{
			id: number
			file_id: number
			name: string
			line: number
			end_line: number
			minhash: Buffer
		}>

		if (signatures.length === 0) return []

		// Convert BLOB minhash buffers to Uint32Array views
		const parsed = signatures.map(s => ({
			...s,
			minhashArr: new Uint32Array(s.minhash.buffer, s.minhash.byteOffset, s.minhash.byteLength / 4),
		}))

		// LSH banding: 16 bands of 8 rows each (128 total hash values)
		const LSH_BANDS = 16
		const ROWS_PER_BAND = 8
		const MAX_BUCKET_SIZE = 100

		const buckets = new Map<string, number[]>()
		for (let idx = 0; idx < parsed.length; idx++) {
			const mh = parsed[idx].minhashArr
			for (let b = 0; b < LSH_BANDS; b++) {
				const offset = b * ROWS_PER_BAND
				const slice = mh.subarray(offset, offset + ROWS_PER_BAND)
				const key = `${b}:${hashBytesToHex(new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength))}`
				let bucket = buckets.get(key)
				if (!bucket) {
					bucket = []
					buckets.set(key, bucket)
				}
				bucket.push(idx)
			}
		}

		// Collect candidate pairs from shared buckets
		const candidatePairs = new Set<string>()
		for (const members of buckets.values()) {
			if (members.length < 2 || members.length > MAX_BUCKET_SIZE) continue
			for (let i = 0; i < members.length; i++) {
				for (let j = i + 1; j < members.length; j++) {
					const a = Math.min(members[i], members[j])
					const b = Math.max(members[i], members[j])
					candidatePairs.add(`${a}:${b}`)
				}
			}
		}

		// Compare only candidate pairs
		const results: NearDuplicateResult[] = []
		for (const pairKey of candidatePairs) {
			const [ai, bi] = pairKey.split(':').map(Number)
			const a = parsed[ai]
			const b = parsed[bi]

			if (a.file_id === b.file_id) continue

			const similarity = jaccardSimilarity(a.minhashArr, b.minhashArr)

			if (similarity >= threshold) {
				const fileA = this.stmts.getFileById.get(a.file_id) as IndexedFile | undefined
				const fileB = this.stmts.getFileById.get(b.file_id) as IndexedFile | undefined

				if (fileA && fileB) {
					results.push({
						similarity,
						a: { path: fileA.path, line: a.line, name: a.name },
						b: { path: fileB.path, line: b.line, name: b.name },
					})
				}
			}
		}

		return results.sort((a, b) => b.similarity - a.similarity).slice(0, limit)
	}

	getExternalPackages(limit = 50): ExternalPackageResult[] {
		const packages = this.db
			.prepare(`
      SELECT package, COUNT(DISTINCT file_id) as file_count,
        GROUP_CONCAT(DISTINCT specifiers) as specifiers
      FROM external_imports
      GROUP BY package
      ORDER BY file_count DESC
      LIMIT ?
    `)
			.all(limit) as Array<{ package: string; file_count: number; specifiers: string }>

		return packages.map(p => ({
			package: p.package,
			fileCount: p.file_count,
			specifiers: p.specifiers ? p.specifiers.split(',').map(s => s.trim()) : [],
		}))
	}

	getOrphanFiles(limit = 50): OrphanFileResult[] {
		const results = this.stmts.getOrphanFilesQuery.all(limit) as Array<{
			path: string
			language: string
			line_count: number
			symbol_count: number
		}>

		return results.map(r => ({
			path: r.path,
			language: r.language,
			lineCount: r.line_count,
			symbolCount: r.symbol_count,
		}))
	}

	getCircularDependencies(limit = 20): CircularDependencyResult[] {
		const edges = this.stmts.getAllEdges.all() as Edge[]
		const files = this.stmts.getAllFiles.all() as IndexedFile[]

		if (files.length === 0 || edges.length === 0) return []

		// Build adjacency list
		const adj = new Map<number, number[]>()
		const selfEdges = new Set<number>()
		for (const edge of edges) {
			if (edge.source_file_id === edge.target_file_id) {
				selfEdges.add(edge.source_file_id)
				continue
			}
			let list = adj.get(edge.source_file_id)
			if (!list) {
				list = []
				adj.set(edge.source_file_id, list)
			}
			list.push(edge.target_file_id)
		}

		// Iterative Tarjan's SCC
		const index = new Map<number, number>()
		const lowlink = new Map<number, number>()
		const onStack = new Set<number>()
		const stack: number[] = []
		let idx = 0
		const sccs: number[][] = []

		const allNodeIds = files.map(f => f.id)

		for (const startNode of allNodeIds) {
			if (index.has(startNode)) continue

			// Iterative DFS with explicit call stack
			// Each frame: [node, neighborIndex, isReturning]
			const callStack: Array<{ node: number; ni: number }> = []
			index.set(startNode, idx)
			lowlink.set(startNode, idx)
			idx++
			stack.push(startNode)
			onStack.add(startNode)
			callStack.push({ node: startNode, ni: 0 })

			while (callStack.length > 0) {
				const frame = callStack[callStack.length - 1]
				const neighbors = adj.get(frame.node) || []

				if (frame.ni < neighbors.length) {
					const w = neighbors[frame.ni]
					frame.ni++

					if (!index.has(w)) {
						index.set(w, idx)
						lowlink.set(w, idx)
						idx++
						stack.push(w)
						onStack.add(w)
						callStack.push({ node: w, ni: 0 })
					} else if (onStack.has(w)) {
						lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, lowlink.get(w)!))
					}
				} else {
					// Done with this node — check if it's an SCC root
					if (lowlink.get(frame.node) === index.get(frame.node)) {
						const scc: number[] = []
						let w: number
						do {
							w = stack.pop()!
							onStack.delete(w)
							scc.push(w)
						} while (w !== frame.node)
						sccs.push(scc)
					}

					callStack.pop()
					if (callStack.length > 0) {
						const parent = callStack[callStack.length - 1]
						lowlink.set(parent.node, Math.min(lowlink.get(parent.node)!, lowlink.get(frame.node)!))
					}
				}
			}
		}

		// Resolve file IDs to paths
		const filePathMap = new Map<number, string>()
		for (const f of files) filePathMap.set(f.id, f.path)

		const results: CircularDependencyResult[] = []
		for (const scc of sccs) {
			if (scc.length > 1 || (scc.length === 1 && selfEdges.has(scc[0]))) {
				results.push({
					cycle: scc.map(id => filePathMap.get(id) || ''),
					length: scc.length,
				})
			}
		}

		return results.sort((a, b) => b.length - a.length).slice(0, limit)
	}

	getChangeImpact(paths: string[], maxDepth = 5): ChangeImpactResult {
		const startIds: number[] = []
		const validPaths: string[] = []
		for (const p of paths) {
			const file = this.stmts.getFileByPath.get(p) as IndexedFile | undefined
			if (file) {
				startIds.push(file.id)
				validPaths.push(p)
			}
		}

		if (startIds.length === 0) return { changedFiles: [], impactedFiles: [], totalAffected: 0 }

		// Multi-source BFS on reverse edge direction (who depends on changed files)
		const visited = new Map<number, number>()
		const queue: Array<{ id: number; depth: number }> = []

		for (const id of startIds) {
			visited.set(id, 0)
			queue.push({ id, depth: 0 })
		}

		while (queue.length > 0) {
			const { id, depth } = queue.shift()!
			if (depth >= maxDepth) continue

			const dependents = this.stmts.getEdgesSourceIdsByTarget.all(id) as Array<{
				source_file_id: number
			}>
			for (const dep of dependents) {
				if (!visited.has(dep.source_file_id)) {
					visited.set(dep.source_file_id, depth + 1)
					queue.push({ id: dep.source_file_id, depth: depth + 1 })
				}
			}
		}

		// Exclude seed files from results
		const seedSet = new Set(startIds)
		const impactedFiles: ImpactedFile[] = []
		for (const [fileId, depth] of visited) {
			if (seedSet.has(fileId)) continue
			const file = this.stmts.getFileById.get(fileId) as IndexedFile | undefined
			if (file) {
				impactedFiles.push({ path: file.path, depth })
			}
		}

		impactedFiles.sort((a, b) => a.depth - b.depth)

		return {
			changedFiles: validPaths,
			impactedFiles,
			totalAffected: impactedFiles.length,
		}
	}

	getSymbolReferences(name: string, limit = 50): SymbolReferenceResult[] {
		const results: SymbolReferenceResult[] = []

		// Import references
		const imports = this.stmts.getRefsByName.all(name) as Array<{
			path: string
			import_source: string
		}>
		for (const imp of imports) {
			results.push({
				kind: 'import',
				path: imp.path,
				line: 0,
				context: `import { ${name} } from '${imp.import_source}'`,
			})
		}

		// Call sites
		const calls = this.stmts.getCallsByCalleeName.all(name) as Array<{
			line: number
			caller_name: string
			path: string
		}>
		for (const call of calls) {
			results.push({
				kind: 'call',
				path: call.path,
				line: call.line,
				context: call.caller_name,
			})
		}

		// Re-exports (barrel files)
		const reexports = this.stmts.getReexportsByName.all(name) as Array<{
			path: string
			line: number
		}>
		for (const re of reexports) {
			results.push({
				kind: 'reexport',
				path: re.path,
				line: re.line,
			})
		}

		return results.slice(0, limit)
	}

	/**
	 * Symbol-level blast radius — BFS through call edges from a given symbol.
	 * Returns all symbols that are transitively reachable as callers.
	 */
	getSymbolBlastRadius(name: string, maxDepth = 5): SymbolBlastRadiusResult {
		// Find the root symbol(s)
		const roots = this.stmts.getSymbolsByName.all(name) as Array<{
			id: number
			name: string
			line: number
			file_id: number
		}>
		if (roots.length === 0) {
			return { root: { name, path: '', line: 0 }, affected: [], totalAffected: 0 }
		}

		const root = roots[0]
		const rootFile = this.stmts.getFileById.get(root.file_id) as { path: string } | undefined

		const visited = new Set<number>()
		visited.add(root.id)

		interface QueueItem {
			symbolId: number
			depth: number
		}
		const queue: QueueItem[] = [{ symbolId: root.id, depth: 0 }]
		const affected: SymbolBlastRadiusResult['affected'] = []

		while (queue.length > 0) {
			const item = queue.shift()!
			if (item.depth >= maxDepth) continue

			// Find callers of this symbol
			const sym = this.db.prepare('SELECT name FROM symbols WHERE id = ?').get(item.symbolId) as
				| { name: string }
				| undefined
			if (!sym) continue

			const callers = this.db
				.prepare(
					`SELECT s.id, s.name, s.line, f.path
					 FROM calls c
					 JOIN symbols s ON c.caller_symbol_id = s.id
					 JOIN files f ON s.file_id = f.id
					 WHERE c.callee_name = ?`,
				)
				.all(sym.name) as Array<{ id: number; name: string; line: number; path: string }>

			for (const caller of callers) {
				if (visited.has(caller.id)) continue
				visited.add(caller.id)
				affected.push({
					name: caller.name,
					path: caller.path,
					line: caller.line,
					depth: item.depth + 1,
				})
				queue.push({ symbolId: caller.id, depth: item.depth + 1 })
			}
		}

		return {
			root: { name: root.name, path: rootFile?.path ?? '', line: root.line },
			affected,
			totalAffected: affected.length,
		}
	}

	/**
	 * Detect cycles in the call graph (symbol-level).
	 * Uses iterative DFS with back-edge detection.
	 */
	getCallGraphCycles(limit = 20): CallGraphCycleResult[] {
		// Get all symbols that participate in calls
		const allCallers = this.db
			.prepare(
				`SELECT DISTINCT s.id, s.name, s.line, f.path
				 FROM calls c
				 JOIN symbols s ON c.caller_symbol_id = s.id
				 JOIN files f ON s.file_id = f.id`,
			)
			.all() as Array<{ id: number; name: string; line: number; path: string }>

		// Build adjacency list: caller → callees
		const adj = new Map<number, number[]>()
		const symbolInfo = new Map<number, { name: string; path: string; line: number }>()

		for (const s of allCallers) {
			symbolInfo.set(s.id, { name: s.name, path: s.path, line: s.line })
		}

		const allEdges = this.db
			.prepare(
				`SELECT c.caller_symbol_id, cs.id as callee_id
				 FROM calls c
				 JOIN symbols cs ON c.callee_name = cs.name AND c.callee_file_id = cs.file_id
				 WHERE c.caller_symbol_id IS NOT NULL AND cs.id IS NOT NULL`,
			)
			.all() as Array<{ caller_symbol_id: number; callee_id: number }>

		for (const edge of allEdges) {
			let arr = adj.get(edge.caller_symbol_id)
			if (!arr) {
				arr = []
				adj.set(edge.caller_symbol_id, arr)
			}
			arr.push(edge.callee_id)
			// Ensure callee info is populated
			if (!symbolInfo.has(edge.callee_id)) {
				const info = this.db
					.prepare(
						'SELECT s.name, s.line, f.path FROM symbols s JOIN files f ON s.file_id = f.id WHERE s.id = ?',
					)
					.get(edge.callee_id) as { name: string; line: number; path: string } | undefined
				if (info) symbolInfo.set(edge.callee_id, info)
			}
		}

		const cycles: CallGraphCycleResult[] = []
		const visited = new Set<number>()
		const onStack = new Set<number>()

		for (const startId of adj.keys()) {
			if (visited.has(startId) || cycles.length >= limit) break
			// Iterative DFS
			const stack: Array<{ id: number; path: number[] }> = [{ id: startId, path: [] }]
			const localVisited = new Set<number>()

			while (stack.length > 0 && cycles.length < limit) {
				const { id, path } = stack.pop()!

				if (onStack.has(id)) {
					// Found a cycle — extract it from path
					const cycleStart = path.indexOf(id)
					if (cycleStart >= 0) {
						const cyclePath = path.slice(cycleStart).concat(id)
						const cycleEntries = cyclePath
							.map(sid => symbolInfo.get(sid))
							.filter((x): x is { name: string; path: string; line: number } => !!x)
						if (cycleEntries.length >= 2) {
							cycles.push({ cycle: cycleEntries, length: cycleEntries.length })
						}
					}
					continue
				}

				if (localVisited.has(id)) continue
				localVisited.add(id)
				onStack.add(id)
				visited.add(id)

				const newPath = [...path, id]
				const neighbors = adj.get(id) ?? []
				for (const next of neighbors) {
					stack.push({ id: next, path: newPath })
				}
			}

			// Clear onStack for next component
			for (const id of localVisited) {
				onStack.delete(id)
			}
		}

		return cycles
	}

	async onFileChanged(path: string): Promise<{ status: string }> {
		const absPath = resolve(path)
		const relPath = relative(this.cwd, absPath)

		try {
			// Check if file still exists
			try {
				statSync(absPath)
			} catch {
				// File was deleted - remove from graph
				await this.removeFile(relPath)
				// Rebuild all derived state after deletion
				await this.buildEdges()
				await this.resolveUnresolvedRefs()
				await this.computePageRank()
				await this.buildCallGraph()
				return { status: 'ok' }
			}

			// Re-index the file
			await this.indexFile(relPath)

			// Rebuild all derived state for correctness
			const file = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
			if (file) {
				// Remove stale edges
				this.stmts.deleteEdgesBySource.run([file.id])
				this.stmts.deleteEdgesByTarget.run([file.id])

				// Resolve any unresolved refs after reindexing
				await this.resolveUnresolvedRefs()

				// Rebuild edges from all refs (not just this file's outgoing)
				await this.buildEdges()

				// Recompute PageRank
				await this.computePageRank()

				// Rebuild call graph
				await this.buildCallGraph()
			}

			return { status: 'ok' }
		} catch (err) {
			console.error('Error updating file:', relPath, err)
			return { status: 'error' }
		}
	}

	private async removeFile(relPath: string): Promise<void> {
		const existing = this.stmts.getFileByPath.get(relPath) as IndexedFile | undefined
		if (!existing) return

		// Delete all related data
		this.stmts.deleteRefsByFileId.run([existing.id])
		this.stmts.deleteEdgesBySource.run([existing.id])
		this.stmts.deleteEdgesByTarget.run([existing.id])
		this.stmts.deleteSymbolsByFileId.run([existing.id])
		this.stmts.deleteShapeHashesByFileId.run([existing.id])
		this.stmts.deleteTokenSignaturesByFileId.run([existing.id])
		this.stmts.deleteTokenFragmentsByFileId.run([existing.id])
		this.stmts.deleteExternalImportsByFileId.run([existing.id])
		this.stmts.deleteFile.run([existing.id])
	}

	async buildCoChanges(): Promise<void> {
		// Check if git is available
		try {
			const { execSync } = await import('child_process')
			execSync('git rev-parse --git-dir', { cwd: this.cwd, stdio: 'pipe' })
		} catch {
			return // Not a git repo
		}

		this.db.run('DELETE FROM cochanges')

		let logOutput: string
		try {
			const { execFile } = await import('child_process')
			logOutput = await new Promise<string>((resolve, reject) => {
				execFile(
					'git',
					['log', '--pretty=format:---COMMIT---', '--name-only', '-n', '300'],
					{ cwd: this.cwd, timeout: 10_000, maxBuffer: 5_000_000 },
					(err, stdout) => (err ? reject(err) : resolve(stdout)),
				)
			})
		} catch {
			return
		}

		const pathToId = new Map<string, number>()
		for (const row of this.db.prepare('SELECT id, path FROM files').all() as Array<{
			id: number
			path: string
		}>) {
			pathToId.set(row.path, row.id)
		}

		const pairCounts = new Map<string, number>()
		const commits = logOutput.split('---COMMIT---').filter(s => s.trim())

		for (const commit of commits) {
			const files = commit
				.split('\n')
				.map(l => l.trim())
				.filter(l => l && pathToId.has(l))

			if (files.length < 2 || files.length > 20) continue

			for (let i = 0; i < files.length; i++) {
				for (let j = i + 1; j < files.length; j++) {
					const a = files[i] as string
					const b = files[j] as string
					const key = a < b ? `${a}\0${b}` : `${b}\0${a}`
					pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1)
				}
			}
		}

		if (pairCounts.size === 0) return

		const insert = this.db.prepare(`
      INSERT OR REPLACE INTO cochanges (file_id_a, file_id_b, count)
      VALUES (?, ?, ?)
    `)

		const entries = [...pairCounts.entries()].filter(([, count]) => count >= 2)
		await this.txWrite(() => {
			for (const [key, count] of entries) {
				const [a, b] = key.split('\0') as [string, string]
				const idA = pathToId.get(a)
				const idB = pathToId.get(b)
				if (idA !== undefined && idB !== undefined) {
					insert.run(idA, idB, count)
				}
			}
		})
	}

	async buildCallGraph(): Promise<void> {
		const { readFileSync } = await import('fs')
		const regexCache = new Map<string, RegExp>()
		this.db.run('DELETE FROM calls')

		const filesWithImports = this.stmts.getFilesWithImports.all() as Array<{
			id: number
			path: string
		}>

		if (filesWithImports.length === 0) return

		// Pre-read all files
		const fileContents = new Map<number, string[]>()
		for (const file of filesWithImports) {
			try {
				const content = readFileSync(join(this.cwd, file.path), 'utf-8')
				fileContents.set(file.id, content.split('\n'))
			} catch {}
		}

		await this.txWrite(() => {
			for (const file of filesWithImports) {
				const lines = fileContents.get(file.id)
				if (!lines) continue

				const imports = this.stmts.getImportsForFile.all(file.id) as Array<{
					name: string
					source_file_id: number
				}>
				if (imports.length === 0) continue

				const functions = this.stmts.getFunctionsForFile.all(file.id) as Array<{
					id: number
					name: string
					line: number
					end_line: number
				}>
				if (functions.length === 0) continue

				const importPatterns = imports.map(imp => {
					const escaped = imp.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
					let re = regexCache.get(imp.name)
					if (!re) {
						re = new RegExp(`\\b${escaped}\\b`)
						regexCache.set(imp.name, re)
					}
					return { name: imp.name, sourceFileId: imp.source_file_id, re }
				})

				for (const func of functions) {
					const bodyStart = func.line
					const bodyEnd = Math.min(func.end_line, lines.length)
					const bodyText = lines.slice(bodyStart - 1, bodyEnd).join('\n')

					for (const imp of importPatterns) {
						if (imp.name === func.name) continue

						if (imp.re.test(bodyText)) {
							let callLine = func.line
							for (let i = bodyStart - 1; i < bodyEnd; i++) {
								const ln = lines[i]
								if (ln !== undefined && imp.re.test(ln)) {
									callLine = i + 1
									break
								}
							}

							const calleeRow = this.stmts.resolveCallee.get(imp.sourceFileId, imp.name) as
								| { id: number }
								| undefined
							// EXTRACTED when we resolved the callee to a concrete exported
							// symbol; INFERRED when only the source file is known (re-export
							// chain or missing export).
							const tier = calleeRow ? 'EXTRACTED' : 'INFERRED'
							const confidence = calleeRow ? 1.0 : 0.7
							this.stmts.insertCall.run(
								func.id,
								imp.name,
								calleeRow?.id ?? null,
								imp.sourceFileId,
								callLine,
								confidence,
								tier,
							)
						}
					}
				}
			}
		})
	}

	async linkTestFiles(): Promise<void> {
		const testFiles = this.stmts.getTestFiles.all() as Array<{ id: number; path: string }>

		await this.txWrite(() => {
			for (const testFile of testFiles) {
				const sourcePath = testFile.path
					.replace(/\.test\./, '.')
					.replace(/_test\./, '.')
					.replace(/\.spec\./, '.')

				const source = this.stmts.getFileByPath.get(sourcePath) as IndexedFile | undefined
				if (source) {
					this.stmts.insertEdge.run([testFile.id, source.id, 1, 1])
				}
			}
		})
	}

	async rescueOrphans(): Promise<void> {
		const orphans = this.db
			.prepare(`
      SELECT f.id, f.path
      FROM files f
      LEFT JOIN edges e ON e.target_file_id = f.id
      WHERE e.target_file_id IS NULL
        AND f.is_barrel = 0
    `)
			.all() as Array<{ id: number; path: string }>

		if (orphans.length === 0) return

		const orphanIds = new Set(orphans.map(o => o.id))

		await this.txWrite(() => {
			for (const orphan of orphans) {
				let rescued = false

				// Strategy 1: co-change evidence (count >= 2 with a non-orphan)
				const cochanges = this.stmts.getCoChanges.all(orphan.id, orphan.id, orphan.id) as Array<{
					other_id: number
					count: number
				}>
				for (const cc of cochanges) {
					if (cc.count >= 2 && !orphanIds.has(cc.other_id)) {
						this.stmts.insertEdge.run([cc.other_id, orphan.id, 0.5, 0.5])
						rescued = true
						break
					}
				}
				if (rescued) continue

				// Strategy 2: directory proximity — find a non-orphan sibling
				const dir = orphan.path.substring(0, orphan.path.lastIndexOf('/'))
				if (dir) {
					const sibling = this.db
						.prepare(`
            SELECT f.id FROM files f
            WHERE f.path LIKE ? || '/%'
              AND f.id != ?
              AND EXISTS (SELECT 1 FROM edges e WHERE e.target_file_id = f.id)
            LIMIT 1
          `)
						.get(`${dir}`, orphan.id) as { id: number } | undefined

					if (sibling) {
						this.stmts.insertEdge.run([sibling.id, orphan.id, 0.3, 0.3])
					}
				}
			}
		})
	}
}
