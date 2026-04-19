// Multi-repo registry (Etap 9i).
//
// Keeps a small SQLite table listing repositories that the user has
// opted into for cross-repo semantic search. The registry is stored
// per-user (default `~/.forge/registry.db`) so it spans workspaces.
//
// Scope intentionally tight: register / get / list / unregister /
// touch. Querying *across* repos lives in the search layer —
// this module only owns the catalogue.

import { Database } from '../runtime/sqlite'
import { existsSync, mkdirSync } from 'fs'
import { dirname, resolve } from 'path'

export interface RegisteredRepo {
	/** Stable short identifier (user-visible). Unique. */
	name: string
	/** Absolute filesystem path to the repo root. Unique. */
	path: string
	/** Milliseconds since epoch — when the repo was registered. */
	registeredAt: number
	/** Milliseconds since epoch — last successful index run; null if never. */
	lastIndexedAt: number | null
}

export interface RegistryOptions {
	/** Override on-disk location (primarily for tests). */
	dbPath?: string
}

/**
 * Minimal catalogue of repositories. All operations are synchronous
 * because SQLite is synchronous in `bun:sqlite` and there's no I/O
 * outside the DB — keeps call sites simple.
 */
export class Registry {
	private readonly db: Database
	private readonly now: () => number

	constructor(opts: RegistryOptions = {}, now: () => number = Date.now) {
		const path = opts.dbPath ?? defaultRegistryPath()
		mkdirSync(dirname(path), { recursive: true })
		this.db = new Database(path)
		this.now = now
		this.migrate()
	}

	private migrate(): void {
		// `name` is the primary key so callers can use stable short
		// identifiers in CLI/tool invocations. `path` has its own
		// uniqueness constraint to prevent accidental double-registration
		// of the same directory under different names.
		this.db.run(`
			CREATE TABLE IF NOT EXISTS repos (
				name TEXT PRIMARY KEY,
				path TEXT NOT NULL UNIQUE,
				registered_at INTEGER NOT NULL,
				last_indexed_at INTEGER
			)
		`)
	}

	/**
	 * Adds a repository. Throws if either the name or path is already
	 * registered — callers should either `get()` first or catch and
	 * translate into a user-friendly error.
	 */
	register(name: string, path: string): RegisteredRepo {
		const trimmedName = name.trim()
		if (trimmedName.length === 0) throw new Error('registry: name must not be empty')
		const abs = resolve(path)
		if (!existsSync(abs)) throw new Error(`registry: path does not exist: ${abs}`)
		if (this.getByName(trimmedName)) {
			throw new Error(`registry: name already registered: ${trimmedName}`)
		}
		if (this.getByPath(abs)) {
			throw new Error(`registry: path already registered: ${abs}`)
		}
		const registeredAt = this.now()
		this.db
			.prepare('INSERT INTO repos (name, path, registered_at, last_indexed_at) VALUES (?, ?, ?, NULL)')
			.run(trimmedName, abs, registeredAt)
		return { name: trimmedName, path: abs, registeredAt, lastIndexedAt: null }
	}

	/** Removes a repository by name. Returns true if a row was deleted. */
	unregister(name: string): boolean {
		const res = this.db.prepare('DELETE FROM repos WHERE name = ?').run(name)
		return Number(res.changes) > 0
	}

	/** Returns registered repos sorted by name for deterministic output. */
	list(): RegisteredRepo[] {
		const rows = this.db
			.prepare('SELECT name, path, registered_at, last_indexed_at FROM repos ORDER BY name ASC')
			.all() as Array<{
			name: string
			path: string
			registered_at: number
			last_indexed_at: number | null
		}>
		return rows.map(r => ({
			name: r.name,
			path: r.path,
			registeredAt: r.registered_at,
			lastIndexedAt: r.last_indexed_at,
		}))
	}

	getByName(name: string): RegisteredRepo | null {
		const row = this.db
			.prepare('SELECT name, path, registered_at, last_indexed_at FROM repos WHERE name = ?')
			.get(name) as
			| { name: string; path: string; registered_at: number; last_indexed_at: number | null }
			| undefined
		if (!row) return null
		return {
			name: row.name,
			path: row.path,
			registeredAt: row.registered_at,
			lastIndexedAt: row.last_indexed_at,
		}
	}

	getByPath(path: string): RegisteredRepo | null {
		const abs = resolve(path)
		const row = this.db
			.prepare('SELECT name, path, registered_at, last_indexed_at FROM repos WHERE path = ?')
			.get(abs) as
			| { name: string; path: string; registered_at: number; last_indexed_at: number | null }
			| undefined
		if (!row) return null
		return {
			name: row.name,
			path: row.path,
			registeredAt: row.registered_at,
			lastIndexedAt: row.last_indexed_at,
		}
	}

	/**
	 * Resolves a set of selectors (names or paths) to registered repos,
	 * preserving selector order and de-duplicating. `'all'` as a sole
	 * selector expands to `list()`. Unknown selectors raise — better to
	 * fail loud than silently skip repos in a multi-repo search.
	 */
	resolve(selectors: readonly string[]): RegisteredRepo[] {
		if (selectors.length === 1 && selectors[0] === 'all') return this.list()
		const seen = new Set<string>()
		const out: RegisteredRepo[] = []
		for (const sel of selectors) {
			const repo = this.getByName(sel) ?? this.getByPath(sel)
			if (!repo) throw new Error(`registry: unknown repo: ${sel}`)
			if (seen.has(repo.name)) continue
			seen.add(repo.name)
			out.push(repo)
		}
		return out
	}

	/** Records a successful index run. No-op if the repo is unknown. */
	touchIndexed(name: string, ts: number = this.now()): void {
		this.db.prepare('UPDATE repos SET last_indexed_at = ? WHERE name = ?').run(ts, name)
	}

	close(): void {
		this.db.close()
	}
}

/** Default on-disk location: `~/.forge/registry.db`. */
export function defaultRegistryPath(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? '.'
	return resolve(home, '.forge', 'registry.db')
}
