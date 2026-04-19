/**
 * Embedding index store — in-memory HNSW-like nearest-neighbor search.
 *
 * Stores embedding vectors alongside chunk metadata for semantic retrieval.
 * Uses brute-force cosine similarity for simplicity and correctness.
 * For large codebases, a future version can swap in SQLite vss or HNSW.
 *
 * Design: all in-memory, rebuilt on startup from indexed chunks.
 */

import type { CodeChunk } from './chunker'
import type { EmbeddingProvider } from './provider'

export interface IndexedChunk {
	chunk: CodeChunk
	embedding: Float32Array
}

export interface SearchResult {
	chunk: CodeChunk
	score: number // Cosine similarity (0 to 1, higher = more similar)
}

export interface IndexStore {
	/** Number of indexed chunks. */
	readonly size: number
	/** Add chunks with their embeddings. */
	add(items: IndexedChunk[]): void
	/** Remove all chunks for a given file path. */
	removeFile(filePath: string): void
	/** Search for the top-k most similar chunks to a query embedding. */
	search(queryEmbedding: Float32Array, topK?: number): SearchResult[]
	/** Clear the entire index. */
	clear(): void
	/** Get all indexed file paths. */
	indexedFiles(): string[]
	/**
	 * Optional BM25 keyword search. Stores that do not support keyword search
	 * omit this method; callers must check before invoking.
	 */
	keywordSearch?(query: string, topK?: number): SearchResult[]
}

/**
 * Create an in-memory index store.
 */
export function createIndexStore(): IndexStore {
	let items: IndexedChunk[] = []

	return {
		get size() {
			return items.length
		},

		add(newItems: IndexedChunk[]): void {
			items.push(...newItems)
		},

		removeFile(filePath: string): void {
			items = items.filter(i => i.chunk.filePath !== filePath)
		},

		search(queryEmbedding: Float32Array, topK = 10): SearchResult[] {
			if (items.length === 0) return []

			const scored: SearchResult[] = items.map(item => ({
				chunk: item.chunk,
				score: cosineSimilarity(queryEmbedding, item.embedding),
			}))

			scored.sort((a, b) => b.score - a.score)
			return scored.slice(0, topK)
		},

		clear(): void {
			items = []
		},

		indexedFiles(): string[] {
			const files = new Set(items.map(i => i.chunk.filePath))
			return [...files]
		},
	}
}

/**
 * Cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical direction).
 */
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

// ── High-level indexing pipeline ──────────────────────────────

export interface IndexingResult {
	chunksIndexed: number
	filesIndexed: number
	durationMs: number
}

/**
 * Index a set of code chunks using the given embedding provider.
 * Processes in batches for efficiency.
 */
export async function indexChunks(
	chunks: CodeChunk[],
	provider: EmbeddingProvider,
	store: IndexStore,
	batchSize = 50,
): Promise<IndexingResult> {
	const start = Date.now()

	// Remove existing entries for files we're re-indexing
	const files = new Set(chunks.map(c => c.filePath))
	for (const f of files) {
		store.removeFile(f)
	}

	// Batch embed
	for (let i = 0; i < chunks.length; i += batchSize) {
		const batch = chunks.slice(i, i + batchSize)
		const texts = batch.map(c => c.content)
		const embeddings = await provider.embed(texts)

		const indexed: IndexedChunk[] = batch.map((chunk, idx) => ({
			chunk,
			embedding: embeddings[idx],
		}))

		store.add(indexed)
	}

	return {
		chunksIndexed: chunks.length,
		filesIndexed: files.size,
		durationMs: Date.now() - start,
	}
}

/**
 * Search the index with a natural language query.
 *
 * Modes:
 *   - `semantic` (default): cosine similarity over dense embeddings.
 *   - `keyword`: BM25 via the store's `keywordSearch` (FTS5). Requires a store
 *     that implements `keywordSearch` (e.g., `createSqliteIndexStore`).
 *   - `hybrid`: fuse semantic + keyword rankings with Reciprocal Rank Fusion.
 *     Falls back to `semantic` if the store has no `keywordSearch`.
 */
export async function semanticSearch(
	query: string,
	provider: EmbeddingProvider,
	store: IndexStore,
	topK = 10,
	mode: 'semantic' | 'keyword' | 'hybrid' = 'semantic',
): Promise<SearchResult[]> {
	if (mode === 'keyword') {
		if (!store.keywordSearch) {
			throw new Error('keyword search requires a store with keywordSearch (e.g., SqliteIndexStore)')
		}
		return store.keywordSearch(query, topK)
	}

	if (mode === 'hybrid' && store.keywordSearch) {
		const { reciprocalRankFusion } = await import('./rrf')
		// Over-fetch each list so RRF has headroom to re-order.
		const overFetch = topK * 3
		const [queryEmbedding] = await provider.embed([query])
		const semantic = store.search(queryEmbedding, overFetch)
		const keyword = store.keywordSearch(query, overFetch)
		const fused = reciprocalRankFusion(
			{
				semantic: semantic.map(r => ({ id: r.chunk.id, item: r })),
				keyword: keyword.map(r => ({ id: r.chunk.id, item: r })),
			},
			{ topK },
		)
		return fused.map(f => ({ chunk: f.item.chunk, score: f.score }))
	}

	// semantic, or hybrid without keyword support → pure vector
	const [queryEmbedding] = await provider.embed([query])
	return store.search(queryEmbedding, topK)
}
