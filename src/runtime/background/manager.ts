/**
 * BackgroundManager — lifecycle management for background agent tasks.
 *
 * Each task transitions: pending → running → completed | error | cancelled.
 * Tasks are persisted to SQLite so they survive plugin restarts.
 * The manager itself does NOT spawn sessions — that's the Spawner's job.
 */

import type { Database } from '../sqlite'
import type { BackgroundTaskStatus } from '../../constants/background'

export interface BackgroundTask {
	id: string
	/** Agent that requested the spawn. */
	parentAgent: string
	/** Agent to run in the background session. */
	targetAgent: string
	/** The prompt to send. */
	prompt: string
	/** Optional additional context. */
	context?: string
	/** Session ID once spawned (null while pending). */
	sessionId: string | null
	/** Current lifecycle state. */
	status: BackgroundTaskStatus
	/** Model identifier used for concurrency accounting. */
	model: string
	/** Short summary or last output snippet. */
	summary: string
	/** When the task was created. */
	createdAt: number
	/** When the task last changed state or output. */
	updatedAt: number
	/** Error message if status === 'error'. */
	error?: string
}

/** Row shape from the SQLite table. */
interface TaskRow {
	id: string
	parent_agent: string
	target_agent: string
	prompt: string
	context: string | null
	session_id: string | null
	status: string
	model: string
	summary: string
	created_at: number
	updated_at: number
	error: string | null
}

function rowToTask(row: TaskRow): BackgroundTask {
	return {
		id: row.id,
		parentAgent: row.parent_agent,
		targetAgent: row.target_agent,
		prompt: row.prompt,
		context: row.context ?? undefined,
		sessionId: row.session_id,
		status: row.status as BackgroundTaskStatus,
		model: row.model,
		summary: row.summary,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		error: row.error ?? undefined,
	}
}

export class BackgroundManager {
	private stmts!: {
		insert: ReturnType<Database['prepare']>
		update: ReturnType<Database['prepare']>
		getById: ReturnType<Database['prepare']>
		getByStatus: ReturnType<Database['prepare']>
		getAll: ReturnType<Database['prepare']>
		countByStatusAndModel: ReturnType<Database['prepare']>
		countByStatus: ReturnType<Database['prepare']>
	}

	constructor(private readonly db: Database) {
		this.bootstrap()
	}

	// ---- schema ----

	private bootstrap(): void {
		this.db.run(`
			CREATE TABLE IF NOT EXISTS background_tasks (
				id TEXT PRIMARY KEY,
				parent_agent TEXT NOT NULL,
				target_agent TEXT NOT NULL,
				prompt TEXT NOT NULL,
				context TEXT,
				session_id TEXT,
				status TEXT NOT NULL DEFAULT 'pending',
				model TEXT NOT NULL,
				summary TEXT NOT NULL DEFAULT '',
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				error TEXT
			)
		`)
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_bg_status ON background_tasks(status)`)
		this.db.run(`CREATE INDEX IF NOT EXISTS idx_bg_model ON background_tasks(model)`)

		this.stmts = {
			insert: this.db.prepare(`
				INSERT INTO background_tasks (id, parent_agent, target_agent, prompt, context, session_id, status, model, summary, created_at, updated_at, error)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`),
			update: this.db.prepare(`
				UPDATE background_tasks SET session_id = ?, status = ?, summary = ?, updated_at = ?, error = ?
				WHERE id = ?
			`),
			getById: this.db.prepare(`SELECT * FROM background_tasks WHERE id = ?`),
			getByStatus: this.db.prepare(`SELECT * FROM background_tasks WHERE status = ? ORDER BY created_at ASC`),
			getAll: this.db.prepare(`SELECT * FROM background_tasks ORDER BY created_at DESC LIMIT ?`),
			countByStatusAndModel: this.db.prepare(
				`SELECT COUNT(*) as cnt FROM background_tasks WHERE status = ? AND model = ?`,
			),
			countByStatus: this.db.prepare(`SELECT COUNT(*) as cnt FROM background_tasks WHERE status = ?`),
		}
	}

	// ---- mutations ----

	/** Enqueue a new task in pending state. Returns the task. */
	enqueue(params: {
		id: string
		parentAgent: string
		targetAgent: string
		prompt: string
		context?: string
		model: string
	}): BackgroundTask {
		const now = Date.now()
		this.stmts.insert.run(
			params.id,
			params.parentAgent,
			params.targetAgent,
			params.prompt,
			params.context ?? null,
			null,
			'pending',
			params.model,
			'',
			now,
			now,
			null,
		)
		return this.getById(params.id)!
	}

	/** Transition a task to running with a session ID.
	 * Works from pending (initial start) and from completed/error (continuation). */
	markRunning(id: string, sessionId: string): void {
		const task = this.getById(id)
		if (!task) return
		if (task.status !== 'pending' && task.status !== 'completed' && task.status !== 'error') return
		this.stmts.update.run(sessionId, 'running', task.summary, Date.now(), null, id)
	}

	/** Transition a task to completed with optional summary. */
	markCompleted(id: string, summary?: string): void {
		const task = this.getById(id)
		if (!task || (task.status !== 'running' && task.status !== 'pending')) return
		this.stmts.update.run(task.sessionId, 'completed', summary ?? task.summary, Date.now(), null, id)
	}

	/** Transition a task to error. */
	markError(id: string, error: string): void {
		const task = this.getById(id)
		if (!task) return
		this.stmts.update.run(task.sessionId, 'error', task.summary, Date.now(), error, id)
	}

	/** Cancel a task. */
	cancel(id: string): boolean {
		const task = this.getById(id)
		if (!task || task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') return false
		this.stmts.update.run(task.sessionId, 'cancelled', task.summary, Date.now(), null, id)
		return true
	}

	/** Update a task's summary (for polling output snapshots). */
	updateSummary(id: string, summary: string): void {
		const task = this.getById(id)
		if (!task || task.status !== 'running') return
		this.stmts.update.run(task.sessionId, task.status, summary, Date.now(), null, id)
	}

	// ---- queries ----

	getById(id: string): BackgroundTask | null {
		const row = this.stmts.getById.get(id) as TaskRow | undefined
		return row ? rowToTask(row) : null
	}

	getByStatus(status: BackgroundTaskStatus): BackgroundTask[] {
		return (this.stmts.getByStatus.all(status) as TaskRow[]).map(rowToTask)
	}

	getAll(limit = 50): BackgroundTask[] {
		return (this.stmts.getAll.all(limit) as TaskRow[]).map(rowToTask)
	}

	countRunning(): number {
		return (this.stmts.countByStatus.get('running') as { cnt: number }).cnt
	}

	countRunningForModel(model: string): number {
		return (this.stmts.countByStatusAndModel.get('running', model) as { cnt: number }).cnt
	}

	countPending(): number {
		return (this.stmts.countByStatus.get('pending') as { cnt: number }).cnt
	}
}
