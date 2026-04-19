/**
 * Constants for the background task subsystem.
 */

/** Maximum number of tasks running concurrently (global). */
export const DEFAULT_MAX_CONCURRENT = 5

/** Maximum concurrent tasks per model/provider. */
export const DEFAULT_PER_MODEL_LIMIT = 2

/** How often (ms) to poll running tasks for status updates. */
export const DEFAULT_POLL_INTERVAL_MS = 3_000

/** If a running task's output doesn't change for this long, mark it completed. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000

/** Task lifecycle states. */
export type BackgroundTaskStatus = 'pending' | 'running' | 'completed' | 'error' | 'cancelled'
