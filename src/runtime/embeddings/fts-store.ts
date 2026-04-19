/**
 * SQLite-backed embedding index with FTS5 keyword search.
 *
 * Implements the `IndexStore` interface plus an optional `keywordSearch()`
 * for hybrid retrieval. Vectors are stored as Float32 BLOBs; cosine similarity
 * is computed in-process over all rows (brute force). FTS5 provides BM25-ranked
 * keyword search over chunk content, symbol name, and file path.
 *
 * Design notes:
 *   - One DB per project at `.forge/embeddings.db`, isolated from graph.db.
 *   - Schema is created idempotently on open.
 *   - All writes run inside transactions for durability and speed.
 *   - Cosine search remains O(N); acceptable up to ~100k chunks. If needed,
 *     swap in an ANN index later without changing the public interface.
 */

import { Database } from '../sqlite'
import type { CodeChunk } from './chunker'
import type { IndexStore, IndexedChunk, SearchResult } from './index-store'

const SCHEMA_VERSION = 1

function float32ToBlob(vec: Float32Array): Buffer {
	return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength)
}

function blobToFloat32(blob: Buffer): Float32Array {
	// Copy into a freshly-owned ArrayBuffer so the Float32Array is independent
	// of the underlying Buffer pool (better-sqlite3 may reuse buffers).
	const copy = new ArrayBuffer(blob.byteLength)
	new Uint8Array(copy).set(blob)
	return new Float32Array(copy)
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	if (a.length !== b.length) return 0
	let dot = 0
	let normA = 0
	let normB = 0
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i]
		normA += a[i] * a[i]
		normB += b[i] * b[i]
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB)
	return denom === 0 ? 0 : dot / denom
}

/**
 * Sanitize a user query for FTS5 MATCH. Splits on whitespace, drops tokens
 * containing FTS metacharacters, and wraps each token in double quotes so
 * punctuation in code identifiers (dots, hyphens) does not break parsing.
 */
function toFtsQuery(input: string): string {
	const tokens = input
		.split(/\s+/)
		.map(t => t.replace(/["'()*]/g, '').trim())
		.filter(t => t.length > 0)
	if (tokens.length === 0) return ''
	return tokens.map(t => `"${t}"`).join(' OR ')
}

export interface SqliteIndexStore extends IndexStore {
	/** Keyword (BM25) search via FTS5. Empty query returns []. */
	keywordSearch(query: string, topK?: number): SearchResult[]
	/** Close the underlying database. */
	close(): void
}

export function createSqliteIndexStore(dbPath: string): SqliteIndexStore {
	const db = new Database(dbPath)
	db.run('PRAGMA journal_mode=WAL')
	db.run('PRAGMA synchronous=NORMAL')
	db.run('PRAGMA foreign_keys=ON')

	db.run(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY
		)
	`)
	db.run(`INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION})`)

	db.run(`
		CREATE TABLE IF NOT EXISTS chunks (
			id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL,
			start_line INTEGER NOT NULL,
			end_line INTEGER NOT NULL,
			content TEXT NOT NULL,
			symbol_name TEXT,
			symbol_kind TEXT,
			embedding BLOB NOT NULL
		)
	`)
	db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path)`)

	db.run(`
		CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
			content, symbol_name, file_path,
			content='chunks', content_rowid='rowid'
		)
	`)

	db.run(`
		CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
			INSERT INTO chunks_fts(rowid, content, symbol_name, file_path)
			VALUES (new.rowid, new.content, COALESCE(new.symbol_name, ''), new.file_path);
		END
	`)
	db.run(`
		CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
			INSERT INTO chunks_fts(chunks_fts, rowid, content, symbol_name, file_path)
			VALUES('delete', old.rowid, old.content, COALESCE(old.symbol_name, ''), old.file_path);
		END
	`)

	const insertStmt = db.prepare<[string, string, number, number, string, string | null, string | null, Buffer]>(`
		INSERT OR REPLACE INTO chunks
			(id, file_path, start_line, end_line, content, symbol_name, symbol_kind, embedding)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`)

	const deleteFileStmt = db.prepare<[string]>(`DELETE FROM chunks WHERE file_path = ?`)
	const clearStmt = db.prepare(`DELETE FROM chunks`)
	const countStmt = db.prepare<[], { c: number }>(`SELECT COUNT(*) as c FROM chunks`)
	const filesStmt = db.prepare<[], { file_path: string }>(`SELECT DISTINCT file_path FROM chunks`)

	const allChunksStmt = db.prepare<
		[],
		{
			id: string
			file_path: string
			start_line: number
			end_line: number
			content: string
			symbol_name: string | null
			symbol_kind: string | null
			embedding: Buffer
		}
	>(`SELECT id, file_path, start_line, end_line, content, symbol_name, symbol_kind, embedding FROM chunks`)

	// FTS5 returns bm25() ordered best-first when we ORDER BY rank.
	const ftsStmt = db.prepare<
		[string, number],
		{
			id: string
			file_path: string
			start_line: number
			end_line: number
			content: string
			symbol_name: string | null
			symbol_kind: string | null
			score: number
		}
	>(`
		SELECT c.id, c.file_path, c.start_line, c.end_line, c.content,
		       c.symbol_name, c.symbol_kind, bm25(chunks_fts) AS score
		FROM chunks_fts
		JOIN chunks c ON c.rowid = chunks_fts.rowid
		WHERE chunks_fts MATCH ?
		ORDER BY rank
		LIMIT ?
	`)

	function rowToChunk(row: {
		id: string
		file_path: string
		start_line: number
		end_line: number
		content: string
		symbol_name: string | null
		symbol_kind: string | null
	}): CodeChunk {
		const c: CodeChunk = {
			id: row.id,
			filePath: row.file_path,
			startLine: row.start_line,
			endLine: row.end_line,
			content: row.content,
		}
		if (row.symbol_name) c.symbolName = row.symbol_name
		if (row.symbol_kind) c.symbolKind = row.symbol_kind
		return c
	}

	return {
		get size(): number {
			return countStmt.get()?.c ?? 0
		},

		add(items: IndexedChunk[]): void {
			if (items.length === 0) return
			const insertMany = db.transaction((...args: unknown[]) => {
				const batch = args[0] as IndexedChunk[]
				for (const { chunk, embedding } of batch) {
					insertStmt.run(
						chunk.id,
						chunk.filePath,
						chunk.startLine,
						chunk.endLine,
						chunk.content,
						chunk.symbolName ?? null,
						chunk.symbolKind ?? null,
						float32ToBlob(embedding),
					)
				}
			})
			insertMany(items)
		},

		removeFile(filePath: string): void {
			deleteFileStmt.run(filePath)
		},

		search(queryEmbedding: Float32Array, topK = 10): SearchResult[] {
			const rows = allChunksStmt.all()
			if (rows.length === 0) return []
			const scored: SearchResult[] = rows.map(row => ({
				chunk: rowToChunk(row),
				score: cosineSimilarity(queryEmbedding, blobToFloat32(row.embedding)),
			}))
			scored.sort((a, b) => b.score - a.score)
			return scored.slice(0, topK)
		},

		keywordSearch(query: string, topK = 10): SearchResult[] {
			const q = toFtsQuery(query)
			if (q === '') return []
			const rows = ftsStmt.all(q, topK)
			// bm25() returns negative scores (lower = better in SQLite's impl);
			// normalize to "higher = better" by negating so downstream code
			// (and RRF, which only cares about rank order) stays consistent.
			return rows.map(row => ({
				chunk: rowToChunk(row),
				score: -row.score,
			}))
		},

		clear(): void {
			clearStmt.run()
		},

		indexedFiles(): string[] {
			return filesStmt.all().map(r => r.file_path)
		},

		close(): void {
			db.close()
		},
	}
}
