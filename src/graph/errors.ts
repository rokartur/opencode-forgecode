/**
 * Thrown when a write-mode graph RPC cannot complete because the leader has
 * gone away (e.g. lockfile lost, socket closed, heartbeat timeout). The
 * caller is expected to surface this to the user — writes are not silently
 * retried across a failover because their effect on the DB is not known.
 */
export class LeaderLostError extends Error {
	readonly method: string
	constructor(method: string, cause?: Error) {
		super(`leader lost while calling '${method}'${cause ? `: ${cause.message}` : ''}`)
		this.name = 'LeaderLostError'
		this.method = method
		if (cause) (this as any).cause = cause
	}
}

const TRANSPORT_FAIL_PATTERN =
	/Transport closed|Transport error|Transport swapped|Worker has been terminated|Worker terminated|Worker error|heartbeat timeout|ECONNRESET|EPIPE/i

export function isTransportFailure(err: unknown): boolean {
	const msg = err instanceof Error ? err.message : String(err)
	return TRANSPORT_FAIL_PATTERN.test(msg)
}
