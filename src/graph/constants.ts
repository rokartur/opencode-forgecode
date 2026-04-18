import { EXT_TO_LANGUAGE, type Language } from './types'

// Re-export from types.ts for backward compatibility
export const INDEXABLE_EXTENSIONS: Readonly<Record<string, Language>> = EXT_TO_LANGUAGE

export const PAGERANK_ITERATIONS = 20

export const PAGERANK_DAMPING = 0.85

/**
 * Default files per scanBatch RPC call.
 * Small default so a single batch stays well under RPC timeout even on slow
 * machines or patologically large files. The service layer adapts this up/down
 * between GRAPH_SCAN_BATCH_SIZE_MIN and GRAPH_SCAN_BATCH_SIZE_MAX based on
 * measured per-batch elapsed time.
 */
export const GRAPH_SCAN_BATCH_SIZE = 50

export const GRAPH_SCAN_BATCH_SIZE_MIN = 16

export const GRAPH_SCAN_BATCH_SIZE_MAX = 500

/**
 * Adaptive batch sizing target. Service aims for batches that take roughly
 * this long; if faster → grow batch, if slower → shrink.
 */
export const GRAPH_SCAN_BATCH_TARGET_MS = 8_000

/**
 * Per-file indexing timeout in the worker. A single pathological file cannot
 * stall a whole batch beyond this; on timeout the file is skipped and the
 * scan continues.
 */
export const GRAPH_SCAN_PER_FILE_TIMEOUT_MS = parseInt(process.env.GRAPH_SCAN_PER_FILE_TIMEOUT_MS ?? '10000', 10)
