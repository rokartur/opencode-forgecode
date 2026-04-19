/**
 * Embeddings module — public API.
 *
 * Re-exports the provider, chunker, and index store for convenient import.
 */

export { createEmbeddingProvider, type EmbeddingProvider, type EmbeddingConfig } from './provider'
export { chunkFile, chunkFiles, type CodeChunk, type ChunkerConfig, type SymbolInfo } from './chunker'
export {
	createIndexStore,
	indexChunks,
	semanticSearch,
	type IndexStore,
	type IndexedChunk,
	type SearchResult,
	type IndexingResult,
} from './index-store'
export { createSqliteIndexStore, type SqliteIndexStore } from './fts-store'
export { reciprocalRankFusion, type RankedItem, type FusedResult } from './rrf'
