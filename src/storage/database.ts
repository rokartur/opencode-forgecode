import { Database } from '../runtime/sqlite'
import { mkdirSync, existsSync, unlinkSync } from 'fs'
import { homedir, platform } from 'os'
import { join, dirname } from 'path'

interface Migration {
	id: string
	description: string
	apply: (db: Database) => void
}

const migrations: Migration[] = [
	{
		id: '001',
		description: 'Remove status column from memories table',
		apply: (db: Database) => {
			const tableInfo = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>
			const hasStatusColumn = tableInfo.some(col => col.name === 'status')

			if (!hasStatusColumn) {
				return
			}

			try {
				db.run('ALTER TABLE memories DROP COLUMN status')
			} catch {
				const indexes = db
					.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='memories'")
					.all() as Array<{ name: string }>
				for (const idx of indexes) {
					if (idx.name.includes('status')) {
						db.run(`DROP INDEX IF EXISTS ${idx.name}`)
					}
				}
				db.run('ALTER TABLE memories DROP COLUMN status')
			}
		},
	},
]

function runMigrations(db: Database): void {
	db.run(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)

	for (const migration of migrations) {
		const existing = db.prepare('SELECT id FROM migrations WHERE id = ?').get(migration.id)
		if (!existing) {
			migration.apply(db)
			db.prepare('INSERT INTO migrations (id, description, applied_at) VALUES (?, ?, ?)').run(
				migration.id,
				migration.description,
				Date.now(),
			)
		}
	}
}

/**
 * Delete the main database file plus WAL and SHM siblings.
 * Used for recovery when integrity checks fail.
 */
function deleteDatabaseFiles(dbPath: string): void {
	try {
		unlinkSync(dbPath)
	} catch {}
	try {
		unlinkSync(dbPath + '-wal')
	} catch {}
	try {
		unlinkSync(dbPath + '-shm')
	} catch {}
}

/**
 * Opens a managed Forge database with integrity verification.
 * If integrity check fails, deletes the corrupted DB files and recreates a fresh database.
 *
 * Transient SQLITE_BUSY / SQLITE_LOCKED errors from concurrent sessions
 * opening the same DB are retried with bounded backoff before surfacing.
 *
 * @param dbPath - Path to the database file
 * @param bootstrap - Function to run schema initialization on the fresh/recovered DB
 * @returns A fresh or recovered Database instance
 */
function openManagedForgeDatabase(dbPath: string, bootstrap: (db: Database) => void): Database {
	const maxAttempts = 5
	let lastErr: unknown
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		try {
			return openManagedForgeDatabaseOnce(dbPath, bootstrap)
		} catch (err) {
			lastErr = err
			const msg = err instanceof Error ? err.message : String(err)
			const isTransient =
				msg.includes('SQLITE_BUSY') || msg.includes('SQLITE_LOCKED') || msg.includes('database is locked')
			if (!isTransient || attempt === maxAttempts - 1) {
				throw err
			}
			// Bounded backoff: 100ms, 200ms, 400ms, 800ms
			const waitMs = 100 * Math.pow(2, attempt)
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
		}
	}
	throw lastErr
}

function openManagedForgeDatabaseOnce(dbPath: string, bootstrap: (db: Database) => void): Database {
	let db: Database | null = null
	let needsBootstrap = false

	try {
		db = new Database(dbPath)
		db.run('PRAGMA journal_mode=WAL')
		db.run('PRAGMA busy_timeout=5000')
		db.run('PRAGMA synchronous=NORMAL')

		// Run integrity check
		const integrityResult = db.prepare('PRAGMA integrity_check').get() as {
			integrity_check: string
		}
		if (integrityResult.integrity_check !== 'ok') {
			db.close()
			console.error(`Forge database corruption detected at ${dbPath}: ${integrityResult.integrity_check}`)
			deleteDatabaseFiles(dbPath)
			needsBootstrap = true
			db = null
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err)
		console.error(`Forge database open failed at ${dbPath}: ${errorMsg}`)

		// Close db handle if it was opened before attempting deletion
		if (db) {
			try {
				db.close()
			} catch {}
			db = null
		}

		// Only delete database files if the error indicates corruption or invalid format
		// Don't delete for transient issues like SQLITE_BUSY (lock timeout)
		const isCorruptionError =
			errorMsg.includes('database disk image is malformed') ||
			errorMsg.includes('corrupt') ||
			errorMsg.includes('SQLITE_CORRUPT') ||
			errorMsg.includes('file is not a database')

		if (isCorruptionError) {
			deleteDatabaseFiles(dbPath)
			needsBootstrap = true
		} else {
			// Re-throw transient errors so callers can handle retry/backoff logic
			throw err
		}
	}

	if (needsBootstrap || db === null) {
		return createFreshDatabase(dbPath, bootstrap)
	}

	// Bootstrap schema on first open (idempotent - uses IF NOT EXISTS)
	bootstrap(db)
	return db
}

/**
 * Creates a fresh database and runs the bootstrap function.
 */
function createFreshDatabase(dbPath: string, bootstrap: (db: Database) => void): Database {
	// Ensure parent directory exists (skip if dbPath has no directory component)
	const parentDir = dirname(dbPath)
	if (parentDir && parentDir !== '.' && parentDir !== '/') {
		mkdirSync(parentDir, { recursive: true })
	}

	const freshDb = new Database(dbPath)
	freshDb.run('PRAGMA journal_mode=WAL')
	freshDb.run('PRAGMA busy_timeout=5000')
	freshDb.run('PRAGMA synchronous=NORMAL')
	bootstrap(freshDb)
	return freshDb
}

export function resolveDataDir(): string {
	const defaultBase = join(homedir(), platform() === 'win32' ? 'AppData' : '.local', 'share')
	const xdgDataHome = process.env['XDG_DATA_HOME'] || defaultBase
	const forgeDir = join(xdgDataHome, 'opencode', 'forge')
	const legacyGraphDir = join(xdgDataHome, 'opencode', 'graph')
	return existsSync(legacyGraphDir) && !existsSync(forgeDir) ? legacyGraphDir : forgeDir
}

export function resolveLogPath(): string {
	return join(resolveDataDir(), 'logs', 'forge.log')
}

function bootstrapForgeSchema(db: Database): void {
	runMigrations(db)

	db.run(`
    CREATE TABLE IF NOT EXISTS plugin_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)

	db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)

	db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
}

export function openForgeDatabase(dbPath: string): Database {
	return openManagedForgeDatabase(dbPath, bootstrapForgeSchema)
}

export function initializeDatabase(dataDir: string): Database {
	if (!existsSync(dataDir)) {
		mkdirSync(dataDir, { recursive: true })
	}

	const dbPath = `${dataDir}/graph.db`

	return openForgeDatabase(dbPath)
}

export function closeDatabase(db: Database): void {
	db.close()
}
