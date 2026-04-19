/**
 * Local-only telemetry — SQLite-backed event tracking for observability.
 *
 * Tracks events like doom-loop detections, undo operations, fallback
 * transitions, background task outcomes, loop outcomes, and audit findings.
 *
 * All data stays local. Opt-in via config. Batched writes for performance.
 * Configurable retention window for automatic cleanup.
 */

import type { Logger, TelemetryConfig } from '../types'

export type TelemetryEventType =
	| 'doom_loop'
	| 'undo'
	| 'fallback'
	| 'background_task'
	| 'loop_outcome'
	| 'audit_finding'
	| 'budget_warning'
	| 'budget_violation'
	| 'recovery'
	| 'shell_blocked'
	| 'intent_routed'
	| 'context_injected'
	| 'custom'

export interface TelemetryEvent {
	id?: number
	type: TelemetryEventType
	sessionId?: string
	projectId?: string
	timestamp: number
	data: Record<string, unknown>
}

export interface TelemetryStats {
	totalEvents: number
	byType: Record<string, number>
	oldestEvent?: number
	newestEvent?: number
}

export interface TelemetryQueryOptions {
	type?: TelemetryEventType
	sessionId?: string
	projectId?: string
	since?: number
	until?: number
	limit?: number
}

/** Default retention: 30 days */
const DEFAULT_RETENTION_DAYS = 30
/** Batch size for writes. */
const BATCH_SIZE = 50
/** Flush interval in ms. */
const FLUSH_INTERVAL_MS = 5000

type Database = {
	run: (sql: string, ...params: unknown[]) => void
	prepare: (sql: string) => {
		run: (...params: unknown[]) => void
		all: (...params: unknown[]) => unknown[]
		get: (...params: unknown[]) => unknown
	}
}

export class TelemetryCollector {
	private logger: Logger
	private config: TelemetryConfig
	private db: Database | null = null
	private buffer: TelemetryEvent[] = []
	private flushTimer: ReturnType<typeof setInterval> | null = null
	private initialized = false

	constructor(logger: Logger, config?: TelemetryConfig) {
		this.logger = logger
		this.config = config ?? { enabled: false }
	}

	/**
	 * Whether telemetry is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled ?? false
	}

	/**
	 * Initialize the telemetry database.
	 */
	init(db: Database): void {
		if (!this.isEnabled() || this.initialized) return

		this.db = db
		try {
			db.run(`
				CREATE TABLE IF NOT EXISTS telemetry_events (
					id INTEGER PRIMARY KEY AUTOINCREMENT,
					type TEXT NOT NULL,
					session_id TEXT,
					project_id TEXT,
					timestamp INTEGER NOT NULL,
					data TEXT NOT NULL DEFAULT '{}'
				)
			`)
			db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_type ON telemetry_events(type)`)
			db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_timestamp ON telemetry_events(timestamp)`)
			db.run(`CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_events(session_id)`)

			this.initialized = true
			this.startFlushTimer()
			this.logger.log('[telemetry] initialized')

			// Run retention cleanup on init
			this.cleanup()
		} catch (err) {
			this.logger.error('[telemetry] failed to initialize', err)
		}
	}

	/**
	 * Record a telemetry event.
	 */
	record(event: Omit<TelemetryEvent, 'timestamp'> & { timestamp?: number }): void {
		if (!this.isEnabled()) return

		const fullEvent: TelemetryEvent = {
			...event,
			timestamp: event.timestamp ?? Date.now(),
		}

		this.buffer.push(fullEvent)

		if (this.buffer.length >= BATCH_SIZE) {
			this.flush()
		}
	}

	/**
	 * Flush buffered events to the database.
	 */
	flush(): void {
		if (!this.db || this.buffer.length === 0) return

		try {
			const stmt = this.db.prepare(
				'INSERT INTO telemetry_events (type, session_id, project_id, timestamp, data) VALUES (?, ?, ?, ?, ?)',
			)

			for (const event of this.buffer) {
				stmt.run(
					event.type,
					event.sessionId ?? null,
					event.projectId ?? null,
					event.timestamp,
					JSON.stringify(event.data),
				)
			}

			this.buffer = []
		} catch (err) {
			this.logger.error('[telemetry] flush failed', err)
		}
	}

	/**
	 * Query telemetry events.
	 */
	query(options: TelemetryQueryOptions = {}): TelemetryEvent[] {
		if (!this.db || !this.initialized) return []

		// Flush before querying to include recent events
		this.flush()

		const conditions: string[] = []
		const params: unknown[] = []

		if (options.type) {
			conditions.push('type = ?')
			params.push(options.type)
		}
		if (options.sessionId) {
			conditions.push('session_id = ?')
			params.push(options.sessionId)
		}
		if (options.projectId) {
			conditions.push('project_id = ?')
			params.push(options.projectId)
		}
		if (options.since) {
			conditions.push('timestamp >= ?')
			params.push(options.since)
		}
		if (options.until) {
			conditions.push('timestamp <= ?')
			params.push(options.until)
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
		const limit = options.limit ? `LIMIT ${options.limit}` : ''

		try {
			const rows = this.db
				.prepare(
					`SELECT id, type, session_id, project_id, timestamp, data FROM telemetry_events ${where} ORDER BY timestamp DESC ${limit}`,
				)
				.all(...params) as Array<{
				id: number
				type: string
				session_id: string | null
				project_id: string | null
				timestamp: number
				data: string
			}>

			return rows.map(row => ({
				id: row.id,
				type: row.type as TelemetryEventType,
				sessionId: row.session_id ?? undefined,
				projectId: row.project_id ?? undefined,
				timestamp: row.timestamp,
				data: JSON.parse(row.data) as Record<string, unknown>,
			}))
		} catch (err) {
			this.logger.error('[telemetry] query failed', err)
			return []
		}
	}

	/**
	 * Get aggregate statistics.
	 */
	getStats(projectId?: string): TelemetryStats {
		if (!this.db || !this.initialized) {
			return { totalEvents: 0, byType: {} }
		}

		this.flush()

		try {
			const whereClause = projectId ? 'WHERE project_id = ?' : ''
			const params = projectId ? [projectId] : []

			const countRow = this.db
				.prepare(`SELECT COUNT(*) as count FROM telemetry_events ${whereClause}`)
				.get(...params) as { count: number } | undefined

			const typeRows = this.db
				.prepare(`SELECT type, COUNT(*) as count FROM telemetry_events ${whereClause} GROUP BY type`)
				.all(...params) as Array<{ type: string; count: number }>

			const rangeRow = this.db
				.prepare(
					`SELECT MIN(timestamp) as oldest, MAX(timestamp) as newest FROM telemetry_events ${whereClause}`,
				)
				.get(...params) as { oldest: number | null; newest: number | null } | undefined

			const byType: Record<string, number> = {}
			for (const row of typeRows) {
				byType[row.type] = row.count
			}

			return {
				totalEvents: countRow?.count ?? 0,
				byType,
				oldestEvent: rangeRow?.oldest ?? undefined,
				newestEvent: rangeRow?.newest ?? undefined,
			}
		} catch (err) {
			this.logger.error('[telemetry] getStats failed', err)
			return { totalEvents: 0, byType: {} }
		}
	}

	/**
	 * Run retention cleanup — removes events older than the configured retention window.
	 */
	cleanup(): number {
		if (!this.db || !this.initialized) return 0

		const retentionDays = this.config.retentionDays ?? DEFAULT_RETENTION_DAYS
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

		try {
			const countRow = this.db
				.prepare('SELECT COUNT(*) as count FROM telemetry_events WHERE timestamp < ?')
				.get(cutoff) as { count: number } | undefined

			const count = countRow?.count ?? 0
			if (count > 0) {
				this.db.run('DELETE FROM telemetry_events WHERE timestamp < ?', cutoff)
				this.logger.log(`[telemetry] cleaned up ${count} events older than ${retentionDays} days`)
			}
			return count
		} catch (err) {
			this.logger.error('[telemetry] cleanup failed', err)
			return 0
		}
	}

	/**
	 * Shutdown — flush remaining events and stop the timer.
	 */
	close(): void {
		this.flush()
		if (this.flushTimer) {
			clearInterval(this.flushTimer)
			this.flushTimer = null
		}
	}

	private startFlushTimer(): void {
		if (this.flushTimer) return
		this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS)
		// Don't block process exit
		if (typeof this.flushTimer === 'object' && 'unref' in this.flushTimer) {
			this.flushTimer.unref()
		}
	}
}
