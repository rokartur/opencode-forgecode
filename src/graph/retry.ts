/**
 * SQLITE_BUSY retry helpers.
 *
 * Even with `PRAGMA busy_timeout=30000` configured on the leader connection,
 * rare write/write collisions can still surface (e.g. during WAL checkpoints
 * or when the busy_timeout is exhausted). Wrapping writes with
 * `withSqliteBusyRetry` absorbs those transient failures with a bounded
 * exponential backoff so callers never see `SQLITE_BUSY` / `SQLITE_LOCKED`.
 *
 * Reads don't need this helper: under WAL they never block.
 */

export const SQLITE_BUSY_RETRY_DELAYS_MS = [10, 25, 50, 100, 250] as const;

export function isSqliteBusyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;

  const message = "message" in error ? (error as { message?: unknown }).message : undefined;
  if (typeof message !== "string") return false;

  const lower = message.toLowerCase();
  return (
    lower.includes("database is locked") ||
    lower.includes("database table is locked") ||
    lower.includes("sqlite_busy") ||
    lower.includes("sqlite_locked")
  );
}

export async function withSqliteBusyRetry<T>(
  fn: () => T | Promise<T>,
  delaysMs: readonly number[] = SQLITE_BUSY_RETRY_DELAYS_MS,
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt >= delaysMs.length) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delaysMs[attempt]));
      attempt += 1;
    }
  }
}
