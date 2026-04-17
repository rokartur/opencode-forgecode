import { GraphClient } from './client'
import {
	ensureGraphDirectory,
	readGraphCacheMetadata,
	writeGraphCacheMetadata,
	openGraphDatabaseReadOnly,
} from './database'
import { join, relative, dirname, isAbsolute } from 'path'
import { watch, existsSync } from 'fs'
import type { Logger } from '../types'
import { collectIndexFingerprint } from './utils'
import { acquireLeader, type LeaderHandle } from './leader-lock'
import { graphSocketPath } from './socket-path'
import { SocketTransport } from './ipc-transport'
import { RpcServer } from './rpc'
import { startIpcServer, type IpcServer } from './ipc-server'
import { RepoMap } from './repo-map'
import type { Database } from '../runtime/sqlite'
import type {
	GraphStats,
	TopFileResult,
	FileDepResult,
	FileCoChangeResult,
	FileSymbolResult,
	SymbolSearchResult,
	SymbolSignatureResult,
	CallerResult,
	CalleeResult,
	UnusedExportResult,
	DuplicateStructureResult,
	NearDuplicateResult,
	ExternalPackageResult,
	OrphanFileResult,
	CircularDependencyResult,
	ChangeImpactResult,
	SymbolReferenceResult,
} from './types'
import { INDEXABLE_EXTENSIONS } from './constants'
import { IGNORED_DIRS, IGNORED_EXTS } from './utils'
import type { GraphState, GraphStatsPayload } from '../utils/graph-status-store'

export interface GraphService {
	/** Whether the graph service is fully initialized and ready to respond to queries. */
	readonly ready: boolean
	/**
	 * Role of this service in the leader/follower topology. `null` until
	 * `initialize()` has run. Leader owns the worker + watcher + SQLite
	 * write handle; follower forwards all RPCs over IPC to the leader.
	 */
	readonly mode: 'leader' | 'follower' | null
	/**
	 * Performs a full scan of the codebase, indexing all files and building the graph.
	 * Emits progress status updates during indexing.
	 */
	scan(): Promise<void>
	/**
	 * Closes the graph service, stopping watchers and releasing resources.
	 */
	close(): Promise<void>
	/**
	 * Returns statistics about the indexed codebase.
	 */
	getStats(): Promise<GraphStats>
	/**
	 * Returns the top N files by PageRank importance.
	 * @param limit - Maximum number of files to return. Defaults to 20.
	 */
	getTopFiles(limit?: number): Promise<TopFileResult[]>
	/**
	 * Returns files that depend on the specified file.
	 * @param relPath - Relative path to the file.
	 */
	getFileDependents(relPath: string): Promise<FileDepResult[]>
	/**
	 * Returns files that the specified file depends on.
	 * @param relPath - Relative path to the file.
	 */
	getFileDependencies(relPath: string): Promise<FileDepResult[]>
	/**
	 * Returns files that frequently change together with the specified file.
	 * @param relPath - Relative path to the file.
	 */
	getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]>
	/**
	 * Returns the blast radius (number of affected files) if this file were changed.
	 * @param relPath - Relative path to the file.
	 */
	getFileBlastRadius(relPath: string): Promise<number>
	/**
	 * Returns all symbols defined in the specified file.
	 * @param relPath - Relative path to the file.
	 */
	getFileSymbols(relPath: string): Promise<FileSymbolResult[]>
	/**
	 * Searches for symbols by exact name match.
	 * @param name - Symbol name to search for.
	 * @param limit - Maximum number of results. Defaults to 50.
	 */
	findSymbols(name: string, limit?: number): Promise<SymbolSearchResult[]>
	/**
	 * Searches for symbols using full-text search.
	 * @param query - Search query string.
	 * @param limit - Maximum number of results. Defaults to 20.
	 */
	searchSymbolsFts(query: string, limit?: number): Promise<SymbolSearchResult[]>
	/**
	 * Returns the signature of a symbol at the given location.
	 * @param path - Absolute path to the file.
	 * @param line - Line number of the symbol.
	 */
	getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null>
	/**
	 * Returns all call sites that call the symbol at the given location.
	 * @param path - Absolute path to the file.
	 * @param line - Line number of the symbol definition.
	 */
	getCallers(path: string, line: number): Promise<CallerResult[]>
	/**
	 * Returns all symbols called by the symbol at the given location.
	 * @param path - Absolute path to the file.
	 * @param line - Line number of the symbol definition.
	 */
	getCallees(path: string, line: number): Promise<CalleeResult[]>
	/**
	 * Returns exported symbols that appear unused.
	 * @param limit - Maximum number of results. Defaults to 50.
	 */
	getUnusedExports(limit?: number): Promise<UnusedExportResult[]>
	/**
	 * Returns groups of files with duplicate code structures.
	 * @param limit - Maximum number of result groups. Defaults to 20.
	 */
	getDuplicateStructures(limit?: number): Promise<DuplicateStructureResult[]>
	/**
	 * Returns pairs of similar but not identical code structures.
	 * @param threshold - Similarity threshold (0-1). Defaults to 0.8.
	 * @param limit - Maximum number of results. Defaults to 50.
	 */
	getNearDuplicates(threshold?: number, limit?: number): Promise<NearDuplicateResult[]>
	/**
	 * Returns external packages imported by the codebase.
	 * @param limit - Maximum number of results. Defaults to 50.
	 */
	getExternalPackages(limit?: number): Promise<ExternalPackageResult[]>
	/**
	 * Returns files with no incoming edges (nobody imports them).
	 * @param limit - Maximum number of results. Defaults to 50.
	 */
	getOrphanFiles(limit?: number): Promise<OrphanFileResult[]>
	/**
	 * Returns circular dependency cycles in the file dependency graph.
	 * @param limit - Maximum number of cycles. Defaults to 20.
	 */
	getCircularDependencies(limit?: number): Promise<CircularDependencyResult[]>
	/**
	 * Returns the transitive impact of changing a set of files.
	 * @param paths - Relative paths of changed files.
	 * @param maxDepth - Maximum BFS traversal depth. Defaults to 5.
	 */
	getChangeImpact(paths: string[], maxDepth?: number): Promise<ChangeImpactResult>
	/**
	 * Returns all references to a symbol (imports, calls, re-exports).
	 * @param name - Symbol name to search for.
	 * @param limit - Maximum number of results. Defaults to 50.
	 */
	getSymbolReferences(name: string, limit?: number): Promise<SymbolReferenceResult[]>
	/**
	 * Renders a text visualization of the code graph.
	 * @param opts - Rendering options.
	 */
	render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }>
	/**
	 * Notifies the service that a file has changed, triggering re-indexing.
	 * @param absPath - Absolute path to the changed file.
	 */
	onFileChanged(absPath: string): void
	/**
	 * Determines whether a full scan is needed on startup based on cache freshness.
	 * Returns a decision with reason for logging purposes.
	 */
	shouldScanOnStartup(): Promise<{ shouldScan: boolean; reason: string }>
	/**
	 * Ensures the graph index is ready for queries on startup.
	 * Scans only when cache is missing, stale, or unhealthy; otherwise skips.
	 * @returns 'scanned' if a full scan was performed, 'skipped' if cache was reused
	 */
	ensureStartupIndex(): Promise<'scanned' | 'skipped'>
}

export type GraphStatusCallback = (state: GraphState, stats?: GraphStatsPayload, message?: string) => void

/**
 * Configuration for creating a graph service instance.
 */
interface GraphServiceConfig {
	projectId: string
	dataDir: string
	cwd: string
	logger: Logger
	watch?: boolean
	debounceMs?: number
	onStatusChange?: GraphStatusCallback
}

interface PendingChange {
	absPath: string
	relPath: string
	timestamp: number
}

// Phase 6: 200 ms debounce coalesces bursts of writes from editors (save →
// format → prettier) into a single flush, reducing leader contention.
const DEFAULT_DEBOUNCE_MS = 200

/**
 * Build a read-only dispatcher that maps RPC method names to local
 * RepoMap calls. Only read methods are mapped; unknown / write methods
 * throw so GraphClient transparently falls back to the IPC path (which
 * routes to the leader's worker, the authoritative handle).
 */
function makeReadOnlyDispatcher(repoMap: RepoMap): (method: string, args: unknown[]) => Promise<unknown> {
	type Handler = (args: unknown[]) => unknown
	const handlers: Record<string, Handler> = {
		getStats: () => repoMap.getStats(),
		getTopFiles: a => repoMap.getTopFiles((a[0] as number) ?? 20),
		getFileDependents: a => repoMap.getFileDependents((a[0] as string) ?? ''),
		getFileDependencies: a => repoMap.getFileDependencies((a[0] as string) ?? ''),
		getFileCoChanges: a => repoMap.getFileCoChanges((a[0] as string) ?? ''),
		getFileBlastRadius: a => repoMap.getFileBlastRadius((a[0] as string) ?? ''),
		getFileSymbols: a => repoMap.getFileSymbols((a[0] as string) ?? ''),
		findSymbols: a => repoMap.findSymbols((a[0] as string) ?? '', (a[1] as number) ?? 50),
		searchSymbolsFts: a => repoMap.searchSymbolsFts((a[0] as string) ?? '', (a[1] as number) ?? 50),
		getSymbolSignature: a => repoMap.getSymbolSignature((a[0] as string) ?? '', (a[1] as number) ?? 0),
		getCallers: a => repoMap.getCallers((a[0] as string) ?? '', (a[1] as number) ?? 0),
		getCallees: a => repoMap.getCallees((a[0] as string) ?? '', (a[1] as number) ?? 0),
		getUnusedExports: a => repoMap.getUnusedExports((a[0] as number) ?? 50),
		getDuplicateStructures: a => repoMap.getDuplicateStructures((a[0] as number) ?? 20),
		getNearDuplicates: a => repoMap.getNearDuplicates((a[0] as number) ?? 0.8, (a[1] as number) ?? 50),
		getExternalPackages: a => repoMap.getExternalPackages((a[0] as number) ?? 50),
		getOrphanFiles: a => repoMap.getOrphanFiles((a[0] as number) ?? 50),
		getCircularDependencies: a => repoMap.getCircularDependencies((a[0] as number) ?? 20),
		getChangeImpact: a => repoMap.getChangeImpact((a[0] as string[]) ?? [], (a[1] as number) ?? 5),
		getSymbolReferences: a => repoMap.getSymbolReferences((a[0] as string) ?? '', (a[1] as number) ?? 50),
		render: a => repoMap.render(a[0] as { maxFiles?: number; maxSymbols?: number } | undefined),
	}
	return async (method, args) => {
		const h = handlers[method]
		if (!h) throw new Error(`read-only dispatcher: unsupported method '${method}'`)
		return h(args)
	}
}

/** Minimum number of files required to consider the graph for health check */
const MIN_FILES_FOR_HEALTH_CHECK = 50

/** Minimum number of symbols required to consider the graph for health check */
const MIN_SYMBOLS_FOR_HEALTH_CHECK = 500

/**
 * Evaluates graph health based on stats to detect obviously incomplete indexes.
 * Returns a description of the health issue if found, or null if healthy.
 *
 * Conservative heuristic: only treat the graph as incomplete when derived state is
 * missing for a large, symbol-dense index. Small or dependency-free repos can
 * validly have zero edges.
 */
function evaluateGraphHealth(stats: { files: number; symbols: number; edges: number; calls: number }): string | null {
	// Only flag as incomplete for large, symbol-dense indexes with zero edges.
	// Smaller repos or those with standalone files can validly have no dependencies.
	if (
		stats.files >= MIN_FILES_FOR_HEALTH_CHECK &&
		stats.symbols >= MIN_SYMBOLS_FOR_HEALTH_CHECK &&
		stats.edges === 0 &&
		stats.calls === 0
	) {
		return `${stats.files} files and ${stats.symbols} symbols indexed but 0 dependency edges or call edges generated`
	}

	return null
}

/**
 * Determines whether a startup scan is needed based on cache freshness and health.
 */
async function determineStartupScan(
	dbPath: string | null,
	cwd: string,
	client: GraphClient,
): Promise<{ shouldScan: boolean; reason: string }> {
	if (!dbPath) {
		return { shouldScan: true, reason: 'Graph database path not set' }
	}
	const graphDir = dirname(dbPath)

	// 1. Check if metadata exists
	const metadata = readGraphCacheMetadata(graphDir)
	if (!metadata) {
		return { shouldScan: true, reason: 'Graph cache metadata missing' }
	}

	// 2. Check if graph DB has any indexed files
	try {
		const stats = await client.getStats()
		const hasIndexedFiles = stats.files > 0

		// If metadata exists but graph has no files, scan is needed
		if (!hasIndexedFiles) {
			// Check if repo is non-empty
			const currentFingerprint = await collectIndexFingerprint(cwd, graphDir)
			if (currentFingerprint.fileCount > 0) {
				return { shouldScan: true, reason: 'Graph database empty but repository has files' }
			}
			// Empty repo - no scan needed
			return { shouldScan: false, reason: 'Repository is empty' }
		}

		// 3. Check persisted status for this scope
		// Note: We can't directly check KV here, so we rely on metadata and stats

		// 4. Compare current fingerprint to last successful scan
		const currentFingerprint = await collectIndexFingerprint(cwd, graphDir)

		// If fingerprint fields are missing from metadata (old format), scan to update
		if (metadata.indexedFileCount === undefined || metadata.indexedMaxMtimeMs === undefined) {
			return {
				shouldScan: true,
				reason: 'Graph metadata missing fingerprint fields - scanning to update',
			}
		}

		// If file count changed, scan is needed
		if (currentFingerprint.fileCount !== metadata.indexedFileCount) {
			return {
				shouldScan: true,
				reason: `File count changed: ${metadata.indexedFileCount} -> ${currentFingerprint.fileCount}`,
			}
		}

		// If max mtime increased (files modified), scan is needed
		if (currentFingerprint.maxMtimeMs > metadata.indexedMaxMtimeMs) {
			return {
				shouldScan: true,
				reason: `Files modified since last index (mtime: ${metadata.indexedMaxMtimeMs} -> ${currentFingerprint.maxMtimeMs})`,
			}
		}

		// 5. Check graph health - unhealthy graphs should be rescanned
		const healthIssue = evaluateGraphHealth(stats)
		if (healthIssue) {
			return {
				shouldScan: true,
				reason: `Graph cache unhealthy: ${healthIssue}`,
			}
		}

		// 6. Cache is fresh and healthy - skip scan
		return {
			shouldScan: false,
			reason: `Graph cache fresh: ${stats.files} files, fingerprint matches last scan`,
		}
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		return { shouldScan: true, reason: `Graph stats unavailable: ${msg}` }
	}
}

/**
 * Creates a graph service instance for code indexing and querying.
 *
 * @param config - Service configuration including project ID, data directory, and callbacks
 * @returns A GraphService instance for code graph operations
 */
export function createGraphService(config: GraphServiceConfig): GraphService {
	const { projectId, dataDir, cwd, logger, watch: watchEnabled, debounceMs, onStatusChange } = config
	const client = new GraphClient()
	let dbPath: string | null = null
	let initialized = false
	let closing = false
	let watcher: ReturnType<typeof watch> | null = null
	let flushTimer: ReturnType<typeof setTimeout> | null = null
	const pendingQueue = new Map<string, PendingChange>()
	let isFlushing = false
	let watcherInitialized = false
	let scanInFlight: Promise<void> | null = null
	let leaderHandle: LeaderHandle | null = null
	let ipcServer: IpcServer | null = null
	let role: 'leader' | 'follower' | null = null
	let graphDir: string | null = null
	let socketPath: string | null = null
	let ownershipTimer: ReturnType<typeof setInterval> | null = null
	let abdicated = false
	// Phase 5: follower-local read-only state. Opened once when we become a
	// follower, closed on promotion, abdication, or service close.
	let readOnlyDb: Database | null = null
	let readOnlyRepoMap: RepoMap | null = null

	const OWNERSHIP_CHECK_MS = 5_000
	const FAILOVER_BACKOFF_START_MS = 100
	const FAILOVER_BACKOFF_MAX_MS = 5_000
	const FAILOVER_MAX_ATTEMPTS = 20

	// Phase 7: follower connect retry. In stampede scenarios (N sessions
	// starting simultaneously) the leader may still be binding its UDS
	// socket when a follower tries to connect. ENOENT / ECONNREFUSED are
	// transient during this window. 2 s total budget is enough for ~200
	// attempts at 10 ms each to cover the worst observed bind delay on
	// macOS + Linux without dragging out tests or startup.
	const FOLLOWER_CONNECT_TIMEOUT_MS = 2_000

	async function connectWithRetry(leaderSocketPath: string): Promise<SocketTransport> {
		const deadline = Date.now() + FOLLOWER_CONNECT_TIMEOUT_MS
		let attempt = 0
		let lastErr: unknown
		while (Date.now() < deadline) {
			attempt += 1

			// Pre-flight: wait for the socket file to exist before asking Node
			// to connect. Some platforms (macOS/Bun) surface ENOENT synchronously
			// via the socket's error event in a way that escapes the Promise
			// executor's catch, so we avoid the call entirely when we know the
			// leader hasn't bound yet. Also prevents log spam.
			if (!existsSync(leaderSocketPath)) {
				const remaining = deadline - Date.now()
				if (remaining <= 0) break
				const wait = Math.min(10 + attempt * 5, 100, remaining)
				await new Promise(r => setTimeout(r, wait))
				lastErr = Object.assign(new Error(`leader socket not bound yet: ${leaderSocketPath}`), {
					code: 'ENOENT',
				})
				continue
			}

			// Each attempt needs a fresh SocketTransport: once connect() fails
			// internally the transport flips its handshake flag and can't be
			// reused safely.
			const transport = new SocketTransport({
				socketPath: leaderSocketPath,
				logger: { error: (m, e) => logger.error(m, e), debug: m => logger.debug(m) },
			})
			try {
				await transport.connect()
				return transport
			} catch (err) {
				lastErr = err
				const code = (err as { code?: string } | null)?.code
				const transient = code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EAGAIN'
				if (!transient) throw err
				const remaining = deadline - Date.now()
				if (remaining <= 0) break
				const wait = Math.min(10 + attempt * 5, 100, remaining)
				logger.debug(`Graph follower: leader socket ${leaderSocketPath} not ready (${code}), retry ${attempt}`)
				await new Promise(r => setTimeout(r, wait))
			}
		}
		throw lastErr instanceof Error
			? lastErr
			: new Error(
					`Graph follower: failed to connect to leader at ${leaderSocketPath} within ${FOLLOWER_CONNECT_TIMEOUT_MS}ms`,
				)
	}

	const effectiveDebounceMs = debounceMs ?? DEFAULT_DEBOUNCE_MS

	function emitStatus(state: GraphState, stats?: GraphStatsPayload, message?: string): void {
		if (onStatusChange) {
			onStatusChange(state, stats, message)
		}
	}

	function shouldIndexPath(absPath: string, relPath: string): boolean {
		// Check if path is within project root
		if (!absPath.startsWith(cwd)) {
			return false
		}

		// Check ignored directories
		const parts = relPath.split('/')
		if (parts.some(part => IGNORED_DIRS.has(part))) {
			return false
		}

		// Check extension
		const ext = '.' + relPath.split('.').pop()?.toLowerCase()
		if (ext && IGNORED_EXTS.has(ext)) {
			return false
		}

		// Check if extension is indexable
		if (ext && !(ext in INDEXABLE_EXTENSIONS)) {
			return false
		}

		return true
	}

	function normalizePath(absPath: string): { absPath: string; relPath: string } | null {
		const relPath = relative(cwd, absPath)
		if (!shouldIndexPath(absPath, relPath)) {
			return null
		}
		return { absPath, relPath }
	}

	let workerHealthy = true

	async function flushQueue(): Promise<void> {
		if (closing || isFlushing || pendingQueue.size === 0 || !workerHealthy) {
			if (!closing && !workerHealthy && pendingQueue.size > 0) {
				logger.debug('Graph flush skipped - worker unhealthy')
				pendingQueue.clear()
			}
			return
		}

		isFlushing = true
		const pathsToFlush = new Map(pendingQueue)
		pendingQueue.clear()

		try {
			for (const change of pathsToFlush.values()) {
				try {
					await client.onFileChanged(change.absPath)
					logger.debug(`Graph flushed: ${change.relPath}`)
				} catch (err) {
					logger.error(`Failed to update graph for ${change.relPath}`, err)
					workerHealthy = false
					client.markWorkerDead(err instanceof Error ? err : new Error(String(err)))
					pendingQueue.clear()
					// Persist error status to KV so TUI can display degraded state
					const errorMessage = err instanceof Error ? err.message : String(err)
					emitStatus('error', undefined, `Worker flush failed: ${errorMessage}`)
					break
				}
			}

			if (workerHealthy && initialized) {
				const stats = await client.getStats()

				// Evaluate graph health after flush
				const healthIssue = evaluateGraphHealth(stats)
				if (healthIssue) {
					const errorMsg = `Graph index incomplete: ${healthIssue}. Run graph scan again or clear the cache.`
					emitStatus(
						'error',
						{
							files: stats.files,
							symbols: stats.symbols,
							edges: stats.edges,
							calls: stats.calls,
						},
						errorMsg,
					)
					workerHealthy = false
				} else {
					emitStatus('ready', {
						files: stats.files,
						symbols: stats.symbols,
						edges: stats.edges,
						calls: stats.calls,
					})
				}
			}
		} finally {
			isFlushing = false

			// Check if new changes arrived during flush
			if (pendingQueue.size > 0 && workerHealthy) {
				scheduleFlush()
			}
		}
	}

	function scheduleFlush(): void {
		if (closing || flushTimer) {
			if (!closing && flushTimer) {
				clearTimeout(flushTimer)
				flushTimer = null // Nullify immediately to prevent race conditions
			}
		}
		if (closing) return
		flushTimer = setTimeout(() => {
			flushQueue().catch(err => {
				logger.error('Graph flush failed', err)
			})
		}, effectiveDebounceMs)
	}

	function enqueueChange(absPath: string): void {
		if (closing) {
			logger.debug(`Graph watcher: ignoring change during shutdown ${absPath}`)
			return
		}
		const normalized = normalizePath(absPath)
		if (!normalized) {
			logger.debug(`Graph watcher: ignoring non-indexable path ${absPath}`)
			return
		}

		const { absPath: normalizedAbs, relPath } = normalized
		pendingQueue.set(normalizedAbs, {
			absPath: normalizedAbs,
			relPath,
			timestamp: Date.now(),
		})

		logger.debug(`Graph watcher: enqueued ${relPath}`)
		scheduleFlush()
	}

	function startWatcher(): void {
		if (!watchEnabled || watcherInitialized || closing) {
			return
		}

		try {
			watcher = watch(cwd, { recursive: true }, (_eventType, filename) => {
				if (!filename) return

				const absPath = join(cwd, filename)
				enqueueChange(absPath)
			})

			watcherInitialized = true
			logger.log('Graph filesystem watcher started')
		} catch (err) {
			logger.error('Failed to start graph filesystem watcher', err)
		}
	}

	function stopWatcher(): void {
		if (watcher) {
			watcher.close()
			watcher = null
			watcherInitialized = false
			logger.log('Graph filesystem watcher stopped')
		}
	}

	const service: GraphService = {
		get ready(): boolean {
			return initialized && !closing && workerHealthy && client.isReady()
		},

		get mode(): 'leader' | 'follower' | null {
			return role
		},

		async scan(): Promise<void> {
			// If a scan is already in flight, return the same promise (serialize concurrent requests)
			if (scanInFlight) {
				return scanInFlight
			}

			if (!initialized) {
				await initialize()
			}

			emitStatus('indexing')

			// Capture the scan promise for concurrent request handling
			scanInFlight = (async () => {
				try {
					// Prepare scan - collect files and get batch info
					const prepResult = await client.prepareScan()

					// Process files in batches with progress updates
					let offset = 0
					let completed = false

					while (!completed) {
						const batchResult = await client.scanBatch(offset, prepResult.batchSize)
						offset = batchResult.nextOffset
						completed = batchResult.completed

						// Emit progress during indexing
						const progressMessage = `Indexing graph: ${offset}/${prepResult.totalFiles} files`
						emitStatus('indexing', undefined, progressMessage)
					}

					// Finalize - build derived state (PageRank, edges, call graph, etc.)
					await client.finalizeScan()

					const stats = await client.getStats()

					// Evaluate graph health - detect obviously incomplete indexes
					const healthIssue = evaluateGraphHealth(stats)
					if (healthIssue) {
						const errorMsg = `Graph index incomplete: ${healthIssue}. Run graph scan again or clear the cache.`
						emitStatus(
							'error',
							{
								files: stats.files,
								symbols: stats.symbols,
								edges: stats.edges,
								calls: stats.calls,
							},
							errorMsg,
						)
						workerHealthy = false
						throw new Error(errorMsg)
					}

					// Persist fingerprint metadata for future startup freshness checks
					if (dbPath) {
						const graphDir = dirname(dbPath)
						const currentFingerprint = await collectIndexFingerprint(cwd, graphDir)
						writeGraphCacheMetadata(graphDir, {
							lastIndexedAt: Date.now(),
							indexedFileCount: currentFingerprint.fileCount,
							indexedMaxMtimeMs: currentFingerprint.maxMtimeMs,
						})
					}

					workerHealthy = true
					emitStatus('ready', {
						files: stats.files,
						symbols: stats.symbols,
						edges: stats.edges,
						calls: stats.calls,
					})
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err)
					emitStatus('error', undefined, msg)
					workerHealthy = false
					throw err
				} finally {
					scanInFlight = null
				}
			})()

			return scanInFlight
		},

		async close(): Promise<void> {
			// Mark as closing to prevent new work from being queued
			closing = true

			// Stop ownership watchdog first so abdication doesn't race with close
			stopOwnershipWatchdog()

			// Close follower read-only fast path before tearing down the client.
			closeReadOnlyFastPath()

			// Clear flush timer immediately
			if (flushTimer) {
				clearTimeout(flushTimer)
				flushTimer = null
			}

			// Discard pending queue rather than flushing during shutdown
			pendingQueue.clear()

			// Stop watcher before more paths can be enqueued
			stopWatcher()

			// Close IPC server (leader only) before releasing the lock so late
			// followers don't race onto a dead socket.
			if (ipcServer) {
				try {
					await ipcServer.close()
				} catch (err) {
					logger.error('Graph service: ipc server close failed', err)
				}
				ipcServer = null
			}

			// Close client (and its worker in leader mode) — worker owns the DB handle
			await client.close()

			// Release the leader lock LAST so a waiting follower can safely
			// re-acquire without colliding with a live worker.
			if (leaderHandle) {
				try {
					leaderHandle.release()
				} catch (err) {
					logger.error('Graph service: leader release failed', err)
				}
				leaderHandle = null
			}

			role = null
			initialized = false
			workerHealthy = false
		},

		async getStats(): Promise<GraphStats> {
			if (!initialized) await initialize()
			return client.getStats()
		},

		async getTopFiles(limit = 20): Promise<TopFileResult[]> {
			if (!initialized) await initialize()
			return client.getTopFiles(limit)
		},

		async getFileDependents(relPath: string): Promise<FileDepResult[]> {
			if (!initialized) await initialize()
			const validatedPath = validateRelativePath(relPath)
			if (!validatedPath) {
				throw new Error(`Invalid path for getFileDependents: ${relPath}`)
			}
			return client.getFileDependents(validatedPath)
		},

		async getFileDependencies(relPath: string): Promise<FileDepResult[]> {
			if (!initialized) await initialize()
			const validatedPath = validateRelativePath(relPath)
			return client.getFileDependencies(validatedPath)
		},

		async getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]> {
			if (!initialized) await initialize()
			const validatedPath = validateRelativePath(relPath)
			return client.getFileCoChanges(validatedPath)
		},

		async getFileBlastRadius(relPath: string): Promise<number> {
			if (!initialized) await initialize()
			const validatedPath = validateRelativePath(relPath)
			return client.getFileBlastRadius(validatedPath)
		},

		async getFileSymbols(relPath: string): Promise<FileSymbolResult[]> {
			if (!initialized) await initialize()
			const validatedPath = validateRelativePath(relPath)
			return client.getFileSymbols(validatedPath)
		},

		async findSymbols(name: string, limit = 50): Promise<SymbolSearchResult[]> {
			if (!initialized) await initialize()
			return client.findSymbols(name, limit)
		},

		async searchSymbolsFts(query: string, limit = 20): Promise<SymbolSearchResult[]> {
			if (!initialized) await initialize()
			return client.searchSymbolsFts(query, limit)
		},

		async getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null> {
			if (!initialized) await initialize()
			return client.getSymbolSignature(path, line)
		},

		async getCallers(path: string, line: number): Promise<CallerResult[]> {
			if (!initialized) await initialize()
			return client.getCallers(path, line)
		},

		async getCallees(path: string, line: number): Promise<CalleeResult[]> {
			if (!initialized) await initialize()
			return client.getCallees(path, line)
		},

		async getUnusedExports(limit = 50): Promise<UnusedExportResult[]> {
			if (!initialized) await initialize()
			return client.getUnusedExports(limit)
		},

		async getDuplicateStructures(limit = 20): Promise<DuplicateStructureResult[]> {
			if (!initialized) await initialize()
			return client.getDuplicateStructures(limit)
		},

		async getNearDuplicates(threshold = 0.8, limit = 50): Promise<NearDuplicateResult[]> {
			if (!initialized) await initialize()
			return client.getNearDuplicates(threshold, limit)
		},

		async getExternalPackages(limit = 50): Promise<ExternalPackageResult[]> {
			if (!initialized) await initialize()
			return client.getExternalPackages(limit)
		},

		async getOrphanFiles(limit = 50): Promise<OrphanFileResult[]> {
			if (!initialized) await initialize()
			return client.getOrphanFiles(limit)
		},

		async getCircularDependencies(limit = 20): Promise<CircularDependencyResult[]> {
			if (!initialized) await initialize()
			return client.getCircularDependencies(limit)
		},

		async getChangeImpact(paths: string[], maxDepth = 5): Promise<ChangeImpactResult> {
			if (!initialized) await initialize()
			return client.getChangeImpact(paths, maxDepth)
		},

		async getSymbolReferences(name: string, limit = 50): Promise<SymbolReferenceResult[]> {
			if (!initialized) await initialize()
			return client.getSymbolReferences(name, limit)
		},

		async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
			if (!initialized) await initialize()
			return client.render(opts)
		},

		onFileChanged(absPath: string): void {
			if (closing) {
				logger.debug(`Graph service: ignoring file change during shutdown ${absPath}`)
				return
			}
			enqueueChange(absPath)
		},

		async shouldScanOnStartup(): Promise<{ shouldScan: boolean; reason: string }> {
			// Ensure initialization first (needed for client.getStats())
			if (!initialized) {
				await initialize()
			}

			if (!dbPath) {
				return { shouldScan: true, reason: 'Graph database path not set' }
			}
			return determineStartupScan(dbPath, cwd, client)
		},

		async ensureStartupIndex(): Promise<'scanned' | 'skipped'> {
			// Ensure initialization first (sets dbPath and initializes client)
			if (!initialized) {
				await initialize()
			}

			// Client is already initialized by this point (initialize() called at line 666-671 or 677-682)
			const decision = await determineStartupScan(dbPath, cwd, client)

			if (decision.shouldScan) {
				logger.log(`Graph startup: ${decision.reason} - performing full scan`)
				await service.scan()
				return 'scanned'
			} else {
				logger.log(`Graph startup: ${decision.reason} - skipping scan`)
				// Refresh ready status with current stats
				const stats = await client.getStats()
				emitStatus(
					'ready',
					{
						files: stats.files,
						symbols: stats.symbols,
						edges: stats.edges,
						calls: stats.calls,
					},
					decision.reason,
				)
				return 'skipped'
			}
		},
	}

	function resolveWorkerPath(): string {
		const isDev = import.meta.url.endsWith('.ts')
		const workerFile = isDev ? 'worker.ts' : 'worker.js'
		// Try sibling location first (src/graph/worker.ts when running TS; dist/graph/worker.js when bundled from src/graph/service.ts)
		const siblingUrl = new URL(`./${workerFile}`, import.meta.url)
		if (existsSync(siblingUrl.pathname)) {
			return siblingUrl.pathname
		}
		// Fallback: bundler flattened to dist/index.js — look in ./graph/ subdir
		const bundledUrl = new URL(`./graph/${workerFile}`, import.meta.url)
		if (existsSync(bundledUrl.pathname)) {
			return bundledUrl.pathname
		}
		throw new Error(`Graph worker file not found: ${siblingUrl.pathname} or ${bundledUrl.pathname}`)
	}

	function validateRelativePath(relPath: string): string {
		const normalized = relPath.trim().replace(/\\/g, '/')
		if (!normalized) {
			throw new Error('Graph file path must be non-empty')
		}
		if (isAbsolute(normalized)) {
			throw new Error(`Graph file path must be relative: ${relPath}`)
		}
		if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
			throw new Error(`Graph file path must stay within project root: ${relPath}`)
		}
		return normalized
	}

	async function initialize(): Promise<void> {
		if (initialized) return

		try {
			// Emit initializing status
			emitStatus('initializing')

			// Ensure graph directory exists; worker thread is the sole DB owner
			dbPath = ensureGraphDirectory(projectId, dataDir, cwd)
			graphDir = dirname(dbPath)
			socketPath = graphSocketPath(graphDir)

			// Leader election: atomic lockfile decides who owns the worker.
			const acquired = acquireLeader(graphDir, { socketPath })
			role = acquired.role

			if (acquired.role === 'leader') {
				leaderHandle = acquired
				await setupLeader()
			} else {
				await setupFollower(acquired.info.socketPath, acquired.info.pid)
			}

			// Install failover hook (read-only calls retry once, writes surface
			// LeaderLostError). The provider handles both follower → new leader
			// reconnect and follower → leader promotion.
			client.setFailoverProvider(runFailover)

			initialized = true
			workerHealthy = true
		} catch (error) {
			initialized = false
			workerHealthy = false
			// Best-effort cleanup of partial state.
			if (ipcServer) {
				try {
					await ipcServer.close()
				} catch {
					/* ignore */
				}
				ipcServer = null
			}
			if (leaderHandle) {
				try {
					leaderHandle.release()
				} catch {
					/* ignore */
				}
				leaderHandle = null
			}
			role = null
			const msg = error instanceof Error ? error.message : String(error)
			logger.error('Failed to initialize graph service', error)
			emitStatus('error', undefined, msg)
			const err = new Error(`Graph service initialization failed: ${msg}`)
			err.cause = error
			throw err
		}
	}

	async function setupLeader(): Promise<void> {
		if (!dbPath || !socketPath) throw new Error('setupLeader: dbPath/socketPath not set')

		// Create worker with explicit path resolution (leader owns the DB).
		const workerPath = resolveWorkerPath()
		logger.debug(`Graph worker path: ${workerPath}`)

		const worker = new globalThis.Worker(workerPath, {
			env: {
				GRAPH_DB_PATH: dbPath,
				GRAPH_CWD: cwd,
			},
		})

		// Install worker on client. For fresh initialize() this is setWorker;
		// for promotion during failover we use promoteToLeader (which keeps
		// failover hook attached).
		if (client.getMode() === null) {
			client.setWorker(worker, logger)
		} else {
			client.promoteToLeader(worker, logger)
		}
		await client.initialize({ cwd, dbPath, logger })

		// Bring up the IPC server so followers can reach us. The server uses
		// a forwarding RpcServer: every follower RPC is proxied into the
		// local worker via GraphClient.forward(), which multiplexes callIds.
		const proxyServer = new RpcServer()
		;(
			proxyServer as unknown as {
				handle: (message: unknown, postResponse: (response: unknown) => void) => Promise<void>
			}
		).handle = async (message, postResponse) => {
			if (!message || typeof message !== 'object') return
			const msg = message as { callId: number; method: string; args: unknown[] }
			try {
				const result = await client.forward(msg.method, msg.args)
				postResponse({ callId: msg.callId, result })
			} catch (err) {
				postResponse({
					callId: msg.callId,
					error: err instanceof Error ? err.message : String(err),
				})
			}
		}
		ipcServer = await startIpcServer({
			socketPath,
			rpcServer: proxyServer,
			logger: { error: (m, e) => logger.error(m, e), debug: m => logger.debug(m) },
		})

		// Start watcher after successful initialization (leader only —
		// followers must not double-watch, leader fans changes out via RPC).
		if (watchEnabled) {
			startWatcher()
		}

		// Start split-brain watchdog: if we lose lockfile ownership (e.g. our
		// lockfile gets replaced because it was considered stale), we abdicate
		// immediately so we don't keep writing to a DB we no longer own.
		startOwnershipWatchdog()

		role = 'leader'
		workerHealthy = true
		logger.log(`Graph service: leader ready (pid=${process.pid}, socket=${socketPath})`)
	}

	async function setupFollower(leaderSocketPath: string, leaderPid: number): Promise<void> {
		// Follower mode: connect to the leader. No worker, no watcher,
		// no DB write handle in this process.
		//
		// Phase 7: connect with retry. In concurrent clean-start scenarios
		// (10 sessions opening at once) the follower can race ahead of the
		// leader's IPC server. ENOENT / ECONNREFUSED are expected for a few
		// ms while the leader is binding the socket, so we back off and
		// retry instead of failing initialization.
		const transport = await connectWithRetry(leaderSocketPath)
		client.setTransport(transport, logger, 'follower')
		await client.initialize({ cwd, dbPath: dbPath ?? '', logger })

		// Phase 5 fast path: open a local read-only SQLite handle. WAL mode
		// lets us read concurrently with the leader's writer without locks.
		// If this fails for any reason, log and continue — the follower will
		// just serve every read over IPC instead, which is still correct.
		openReadOnlyFastPath()

		role = 'follower'
		workerHealthy = true
		logger.log(`Graph service: follower connected (leader pid=${leaderPid}, socket=${leaderSocketPath})`)
	}

	/**
	 * Opens the local read-only SQLite handle and installs a dispatcher on
	 * GraphClient so read-only RPC methods short-circuit to local SELECTs
	 * instead of going over IPC. The leader's WAL writes are visible on
	 * each new statement thanks to WAL's read snapshot isolation.
	 */
	function openReadOnlyFastPath(): void {
		if (!dbPath) return
		closeReadOnlyFastPath()
		try {
			readOnlyDb = openGraphDatabaseReadOnly(dbPath)
			readOnlyRepoMap = new RepoMap({ cwd, db: readOnlyDb })
			const dispatcher = makeReadOnlyDispatcher(readOnlyRepoMap)
			client.setReadOnlyDispatcher(dispatcher)
			logger.debug('Graph follower: read-only fast path active')
		} catch (err) {
			logger.debug(
				`Graph follower: read-only fast path unavailable, falling back to IPC: ${
					err instanceof Error ? err.message : String(err)
				}`,
			)
			closeReadOnlyFastPath()
		}
	}

	function closeReadOnlyFastPath(): void {
		client.clearReadOnlyDispatcher()
		readOnlyRepoMap = null
		if (readOnlyDb) {
			try {
				readOnlyDb.close()
			} catch {
				/* ignore */
			}
			readOnlyDb = null
		}
	}

	function startOwnershipWatchdog(): void {
		if (ownershipTimer) clearInterval(ownershipTimer)
		ownershipTimer = setInterval(() => {
			if (closing || !leaderHandle) return
			try {
				if (!leaderHandle.validateOwnership()) {
					logger.error('Graph leader lost lockfile ownership — abdicating to avoid split-brain')
					abdicate().catch(err => logger.error('Graph leader abdication failed', err))
				}
			} catch (err) {
				logger.error('Graph ownership watchdog error', err)
			}
		}, OWNERSHIP_CHECK_MS)
		if (typeof ownershipTimer.unref === 'function') {
			ownershipTimer.unref()
		}
	}

	function stopOwnershipWatchdog(): void {
		if (ownershipTimer) {
			clearInterval(ownershipTimer)
			ownershipTimer = null
		}
	}

	/**
	 * Called when the leader detects it lost lockfile ownership (split-brain
	 * recovery). Tears down leader infrastructure so write RPCs surface
	 * LeaderLostError. Does NOT re-acquire — a parent agent decides whether
	 * to restart the service.
	 */
	async function abdicate(): Promise<void> {
		if (abdicated) return
		abdicated = true
		stopOwnershipWatchdog()
		stopWatcher()
		closeReadOnlyFastPath()
		if (ipcServer) {
			try {
				await ipcServer.close()
			} catch {
				/* ignore */
			}
			ipcServer = null
		}
		try {
			await client.close()
		} catch {
			/* ignore */
		}
		// NOTE: do NOT release leaderHandle — we already lost ownership.
		leaderHandle = null
		workerHealthy = false
		role = null
		initialized = false
		emitStatus('error', undefined, 'Graph leader lost lockfile ownership')
	}

	/**
	 * Failover provider wired into GraphClient. Called when an RPC fails
	 * with a transport error. Walks an exponential-backoff loop trying to
	 * reconnect to a leader; on each attempt:
	 *   - acquireLeader() decides whether we take over or another process
	 *     already has the lock;
	 *   - if we win: promote this process to leader (spin up worker, IPC
	 *     server, watcher);
	 *   - if we lose: reconnect follower SocketTransport to the new leader.
	 */
	async function runFailover(): Promise<void> {
		if (closing) throw new Error('graph service closing')
		if (!graphDir || !socketPath) throw new Error('service not initialized')
		let delay = FAILOVER_BACKOFF_START_MS
		let lastError: unknown = null
		for (let attempt = 0; attempt < FAILOVER_MAX_ATTEMPTS; attempt++) {
			if (closing) throw new Error('graph service closing')
			try {
				const acquired = acquireLeader(graphDir, { socketPath })
				if (acquired.role === 'leader') {
					// Promotion: we won the lock. Close the read-only handle before
					// we start the worker — the worker will open the DB read/write,
					// and keeping an extra RO fd around on Windows would block it.
					closeReadOnlyFastPath()
					logger.log(`Graph failover: promoted to leader (attempt ${attempt + 1}, pid=${process.pid})`)
					leaderHandle = acquired
					await setupLeader()
					return
				}
				// Still follower — reconnect to the (possibly new) leader.
				const transport = await connectWithRetry(acquired.info.socketPath)
				client.setTransport(transport, logger, 'follower')
				// Re-open the RO fast path against the (possibly new) leader's DB.
				// The DB path itself is stable for a (projectId, cwd) scope.
				openReadOnlyFastPath()
				role = 'follower'
				workerHealthy = true
				logger.log(
					`Graph failover: reconnected as follower (attempt ${attempt + 1}, leader pid=${acquired.info.pid})`,
				)
				return
			} catch (err) {
				lastError = err
				logger.debug(
					`Graph failover attempt ${attempt + 1} failed: ${err instanceof Error ? err.message : String(err)}`,
				)
				await sleep(delay)
				delay = Math.min(delay * 2, FAILOVER_BACKOFF_MAX_MS)
			}
		}
		throw new Error(
			`graph failover exhausted after ${FAILOVER_MAX_ATTEMPTS} attempts: ${
				lastError instanceof Error ? lastError.message : String(lastError)
			}`,
		)
	}

	function sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms))
	}

	return service
}
