import type { Database } from '../runtime/sqlite'
import { createKvQuery } from '../storage/kv-queries'
import type { Logger } from '../types'

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface KvEntry {
	key: string
	data: unknown
	updatedAt: number
	expiresAt: number
}

export interface KvService {
	get<T = unknown>(projectId: string, key: string): T | null
	set<T = unknown>(projectId: string, key: string, data: T): void
	delete(projectId: string, key: string): void
	list(projectId: string): KvEntry[]
	listByPrefix(projectId: string, prefix: string): KvEntry[]
}

export function createKvService(db: Database, _logger?: Logger, defaultTtlMs?: number): KvService {
	const queries = createKvQuery(db)
	const ttlMs = defaultTtlMs ?? DEFAULT_TTL_MS

	return {
		get<T = unknown>(projectId: string, key: string): T | null {
			const row = queries.get(projectId, key)
			if (!row) return null
			try {
				return JSON.parse(row.data) as T
			} catch {
				return null
			}
		},

		set<T = unknown>(projectId: string, key: string, data: T): void {
			const expiresAt = Date.now() + ttlMs
			const jsonData = JSON.stringify(data)
			queries.set(projectId, key, jsonData, expiresAt)
		},

		delete(projectId: string, key: string): void {
			queries.delete(projectId, key)
		},

		list(projectId: string): KvEntry[] {
			const rows = queries.list(projectId)
			return rows.map(row => {
				let data: unknown = null
				try {
					data = JSON.parse(row.data)
				} catch {}
				return {
					key: row.key,
					data,
					updatedAt: row.updatedAt,
					expiresAt: row.expiresAt,
				}
			})
		},

		listByPrefix(projectId: string, prefix: string): KvEntry[] {
			const rows = queries.listByPrefix(projectId, prefix)
			return rows.map(row => {
				let data: unknown = null
				try {
					data = JSON.parse(row.data)
				} catch {}
				return {
					key: row.key,
					data,
					updatedAt: row.updatedAt,
					expiresAt: row.expiresAt,
				}
			})
		},
	}
}

interface MemRow {
	data: string
	updatedAt: number
	expiresAt: number
}

/**
 * Degraded-mode KvService backed by an in-process Map. Used when
 * `initializeDatabase` fails (corruption, EACCES, read-only FS, etc.) so
 * plugin init can still complete and agents (forge/muse/sage) are registered.
 *
 * Contract is identical to `createKvService`. Data is NOT persisted across
 * process restarts. TTL semantics match the DB-backed implementation
 * (lazy expiry on read).
 */
export function createInMemoryKvService(logger?: Logger, defaultTtlMs?: number): KvService {
	const ttlMs = defaultTtlMs ?? DEFAULT_TTL_MS
	const store = new Map<string, MemRow>()
	let warned = false
	const warnOnce = () => {
		if (warned) return
		warned = true
		logger?.log?.('KV in-memory fallback active: data will not persist across sessions')
	}

	const compositeKey = (projectId: string, key: string) => `${projectId}\u0000${key}`
	const projectPrefix = (projectId: string) => `${projectId}\u0000`

	const readRow = (projectId: string, key: string): MemRow | null => {
		const row = store.get(compositeKey(projectId, key))
		if (!row) return null
		if (row.expiresAt <= Date.now()) {
			store.delete(compositeKey(projectId, key))
			return null
		}
		return row
	}

	const parseData = (raw: string): unknown => {
		try {
			return JSON.parse(raw)
		} catch {
			return null
		}
	}

	return {
		get<T = unknown>(projectId: string, key: string): T | null {
			const row = readRow(projectId, key)
			if (!row) return null
			try {
				return JSON.parse(row.data) as T
			} catch {
				return null
			}
		},

		set<T = unknown>(projectId: string, key: string, data: T): void {
			warnOnce()
			const now = Date.now()
			store.set(compositeKey(projectId, key), {
				data: JSON.stringify(data),
				updatedAt: now,
				expiresAt: now + ttlMs,
			})
		},

		delete(projectId: string, key: string): void {
			store.delete(compositeKey(projectId, key))
		},

		list(projectId: string): KvEntry[] {
			const prefix = projectPrefix(projectId)
			const now = Date.now()
			const out: KvEntry[] = []
			for (const [composite, row] of store) {
				if (!composite.startsWith(prefix)) continue
				if (row.expiresAt <= now) {
					store.delete(composite)
					continue
				}
				out.push({
					key: composite.slice(prefix.length),
					data: parseData(row.data),
					updatedAt: row.updatedAt,
					expiresAt: row.expiresAt,
				})
			}
			return out
		},

		listByPrefix(projectId: string, prefix: string): KvEntry[] {
			const cPrefix = compositeKey(projectId, prefix)
			const pPrefix = projectPrefix(projectId)
			const now = Date.now()
			const out: KvEntry[] = []
			for (const [composite, row] of store) {
				if (!composite.startsWith(cPrefix)) continue
				if (row.expiresAt <= now) {
					store.delete(composite)
					continue
				}
				out.push({
					key: composite.slice(pPrefix.length),
					data: parseData(row.data),
					updatedAt: row.updatedAt,
					expiresAt: row.expiresAt,
				})
			}
			return out
		},
	}
}
