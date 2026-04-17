import type { Database } from '../runtime/sqlite'

const SQLITE_BUSY_RETRY_DELAYS_MS = [10, 25, 50, 100, 250] as const

export interface KvRow {
	projectId: string
	key: string
	data: string
	expiresAt: number
	createdAt: number
	updatedAt: number
}

interface KvRowRaw {
	project_id: string
	key: string
	data: string
	expires_at: number
	created_at: number
	updated_at: number
}

function mapRow(row: KvRowRaw): KvRow {
	return {
		projectId: row.project_id,
		key: row.key,
		data: row.data,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

const CLEANUP_INTERVAL_MS = 300_000
let lastCleanupAt = 0

function isSqliteBusyError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false

	const code = 'code' in error ? error.code : undefined
	if (code === 'SQLITE_BUSY') return true

	const message = 'message' in error ? error.message : undefined
	if (typeof message !== 'string') return false

	return message.includes('database is locked') || message.includes('SQLITE_BUSY')
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withSqliteBusyRetry<T>(fn: () => T): T {
	let attempt = 0

	while (true) {
		try {
			return fn()
		} catch (error) {
			if (!isSqliteBusyError(error) || attempt >= SQLITE_BUSY_RETRY_DELAYS_MS.length) {
				throw error
			}

			sleepSync(SQLITE_BUSY_RETRY_DELAYS_MS[attempt])
			attempt += 1
		}
	}
}

export function createKvQuery(db: Database) {
	const getStmt = db.prepare(
		`SELECT project_id, key, data, expires_at, created_at, updated_at
     FROM project_kv
     WHERE project_id = ? AND key = ? AND expires_at > ?`,
	)

	const setStmt = db.prepare(
		`INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, key) DO UPDATE SET
       data = excluded.data,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
	)

	const deleteStmt = db.prepare(`DELETE FROM project_kv WHERE project_id = ? AND key = ?`)

	const listStmt = db.prepare(
		`SELECT project_id, key, data, expires_at, created_at, updated_at
     FROM project_kv
     WHERE project_id = ? AND expires_at > ?
     ORDER BY updated_at DESC`,
	)

	const listByPrefixStmt = db.prepare(
		`SELECT project_id, key, data, expires_at, created_at, updated_at
     FROM project_kv
     WHERE project_id = ? AND key LIKE ? AND expires_at > ?
     ORDER BY updated_at DESC`,
	)

	const deleteExpiredStmt = db.prepare(`DELETE FROM project_kv WHERE expires_at < ?`)

	return {
		get(projectId: string, key: string): KvRow | undefined {
			const row = getStmt.get(projectId, key, Date.now()) as KvRowRaw | null
			return row ? mapRow(row) : undefined
		},

		set(projectId: string, key: string, data: string, expiresAt: number): void {
			const now = Date.now()
			withSqliteBusyRetry(() => setStmt.run(projectId, key, data, expiresAt, now, now))

			if (now - lastCleanupAt > CLEANUP_INTERVAL_MS) {
				lastCleanupAt = now
				setImmediate(() => {
					try {
						withSqliteBusyRetry(() => deleteExpiredStmt.run(now))
					} catch {
						// Ignore errors from cleanup (e.g., if db is closed)
					}
				})
			}
		},

		delete(projectId: string, key: string): void {
			withSqliteBusyRetry(() => deleteStmt.run(projectId, key))
		},

		list(projectId: string): KvRow[] {
			const rows = listStmt.all(projectId, Date.now()) as KvRowRaw[]
			return rows.map(mapRow)
		},

		listByPrefix(projectId: string, prefix: string): KvRow[] {
			const rows = listByPrefixStmt.all(projectId, `${prefix}%`, Date.now()) as KvRowRaw[]
			return rows.map(mapRow)
		},

		deleteExpired(): number {
			const result = withSqliteBusyRetry(() => deleteExpiredStmt.run(Date.now()))
			return result.changes
		},
	}
}
