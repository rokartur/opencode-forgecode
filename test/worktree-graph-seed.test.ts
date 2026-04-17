import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { Database } from 'bun:sqlite'
import { seedWorktreeGraphScope } from '../src/utils/worktree-graph-seed'
import { resolveGraphCacheDir } from '../src/storage/graph-projects'
import { readGraphCacheMetadata } from '../src/graph/database'
import { initializeDatabase, closeDatabase } from '../src/storage'
import { createKvService } from '../src/services/kv'
import type { Logger } from '../src/types'

const TEST_DATA_DIR = '/tmp/opencode-worktree-seed-test-' + Date.now()

interface TestContext {
	testDataDir: string
	sourceCwd: string
	targetCwd: string
	projectId: string
	dataDir: string
	kvService: ReturnType<typeof createKvService>
	dbPath: string
}

function createTestContext(): TestContext {
	const testDataDir = join(TEST_DATA_DIR, Math.random().toString(36).slice(2))
	mkdirSync(testDataDir, { recursive: true })

	const dataDir = join(testDataDir, 'data')
	mkdirSync(dataDir, { recursive: true })

	const sourceCwd = join(testDataDir, 'source-repo')
	mkdirSync(sourceCwd, { recursive: true })

	const targetCwd = join(testDataDir, 'target-worktree')
	mkdirSync(targetCwd, { recursive: true })

	const projectId = 'test-project-' + Date.now()

	// Initialize database first
	const db = initializeDatabase(dataDir)
	const dbPath = join(dataDir, 'graph.db')

	// Create KV service with the database instance
	const kvService = createKvService(db, { log: () => {}, error: () => {}, debug: () => {} })

	return {
		testDataDir,
		sourceCwd,
		targetCwd,
		projectId,
		dataDir,
		kvService,
		dbPath,
	}
}

function cleanupTestContext(ctx: TestContext) {
	try {
		closeDatabase()
	} catch {}
	if (existsSync(ctx.testDataDir)) {
		rmSync(ctx.testDataDir, { recursive: true, force: true })
	}
}

function createSourceGraphCache(ctx: TestContext, fileCount: number, maxMtimeMs: number) {
	const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
	mkdirSync(sourceCacheDir, { recursive: true })

	// Create graph.db with actual indexed data
	const dbPath = join(sourceCacheDir, 'graph.db')
	const db = new Database(dbPath)
	db.run('PRAGMA journal_mode=WAL')
	db.run('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT, mtimeMs INTEGER)')
	// Insert actual data rows to make the graph healthy
	for (let i = 0; i < fileCount; i++) {
		db.run('INSERT OR REPLACE INTO files (id, path, mtimeMs) VALUES (?, ?, ?)', [
			`file-${i}`,
			`file${i}.ts`,
			maxMtimeMs,
		])
	}
	db.close()

	// Write metadata with fingerprint
	const metadataPath = join(sourceCacheDir, 'graph-metadata.json')
	writeFileSync(
		metadataPath,
		JSON.stringify({
			projectId: ctx.projectId,
			cwd: ctx.sourceCwd,
			createdAt: Date.now() - 1000,
			lastIndexedAt: Date.now() - 500,
			indexedFileCount: fileCount,
			indexedMaxMtimeMs: maxMtimeMs,
		}),
	)

	return sourceCacheDir
}

function createTestFiles(cwd: string, count: number, baseMtimeMs: number) {
	for (let i = 0; i < count; i++) {
		const filePath = join(cwd, `file${i}.ts`)
		writeFileSync(filePath, `// Test file ${i}\n`)
		// Set mtime to match
		const fd = require('fs').openSync(filePath, 'r+')
		require('fs').futimesSync(fd, new Date(baseMtimeMs), new Date(baseMtimeMs))
		require('fs').closeSync(fd)
	}
}

describe('seedWorktreeGraphScope', () => {
	let ctx: TestContext

	beforeEach(() => {
		ctx = createTestContext()
	})

	afterEach(() => {
		cleanupTestContext(ctx)
	})

	test('should seed successfully when source cache exists and fingerprints match', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Seed
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(true)
		expect(result.reason).toContain('seeded successfully')

		// Verify target cache exists
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		expect(existsSync(targetCacheDir)).toBe(true)
		expect(existsSync(join(targetCacheDir, 'graph.db'))).toBe(true)

		// Verify metadata is rewritten with target cwd
		const targetMetadata = readGraphCacheMetadata(targetCacheDir)
		expect(targetMetadata).not.toBeNull()
		expect(targetMetadata?.cwd).toBe(ctx.targetCwd)
		expect(targetMetadata?.projectId).toBe(ctx.projectId)
		expect(targetMetadata?.indexedFileCount).toBe(fileCount)
		expect(targetMetadata?.indexedMaxMtimeMs).toBe(maxMtimeMs)
	})

	test('should skip when source cache directory is missing', async () => {
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source cache directory missing')

		// Verify target cache was not created
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		expect(existsSync(targetCacheDir)).toBe(false)
	})

	test('should skip when source metadata is missing', async () => {
		// Create source cache directory but no metadata
		const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
		mkdirSync(sourceCacheDir, { recursive: true })

		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source metadata file missing')
	})

	test('should skip when source graph.db is missing but metadata exists', async () => {
		// Create source cache directory with metadata but no graph.db
		const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
		mkdirSync(sourceCacheDir, { recursive: true })

		// Write metadata
		const metadataPath = join(sourceCacheDir, 'graph-metadata.json')
		writeFileSync(
			metadataPath,
			JSON.stringify({
				projectId: ctx.projectId,
				cwd: ctx.sourceCwd,
				createdAt: Date.now(),
				indexedFileCount: 10,
				indexedMaxMtimeMs: Date.now(),
			}),
		)

		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source graph.db missing')

		// Verify target cache was not created
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		expect(existsSync(targetCacheDir)).toBe(false)
	})

	test('should skip when source metadata lacks fingerprint fields', async () => {
		// Create source cache with incomplete metadata (has graph.db but no fingerprints)
		const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
		mkdirSync(sourceCacheDir, { recursive: true })

		// Create graph.db
		const dbPath = join(sourceCacheDir, 'graph.db')
		const db = new Database(dbPath)
		db.run('PRAGMA journal_mode=WAL')
		db.close()

		const metadataPath = join(sourceCacheDir, 'graph-metadata.json')
		writeFileSync(
			metadataPath,
			JSON.stringify({
				projectId: ctx.projectId,
				cwd: ctx.sourceCwd,
				createdAt: Date.now(),
				// Missing indexedFileCount and indexedMaxMtimeMs
			}),
		)

		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source metadata incomplete (missing fingerprint fields)')
	})

	test('should skip when target fingerprint does not match source', async () => {
		const sourceFileCount = 10
		const sourceMaxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, sourceFileCount, sourceMaxMtimeMs)

		// Create different target files (mismatch)
		createTestFiles(ctx.targetCwd, 5, Date.now() - 1000)

		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('worktree fingerprint mismatch')
	})

	test('should skip when target cache already exists', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Pre-create target cache
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		mkdirSync(targetCacheDir, { recursive: true })
		writeFileSync(join(targetCacheDir, 'graph.db'), '')

		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('target cache already exists')
	})

	test('should copy ready status when source status is ready', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Write ready status to source scope
		const { writeGraphStatus, getGraphStatusKey } = await import('../src/utils/graph-status-store')
		const sourceStatus = {
			state: 'ready' as const,
			ready: true,
			stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
			updatedAt: Date.now() - 1000,
		}
		writeGraphStatus(ctx.kvService, ctx.projectId, sourceStatus, ctx.sourceCwd)

		// Seed
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(true)

		// Verify status was copied to target scope
		const { readGraphStatus } = await import('../src/utils/graph-status-store')
		const targetStatus = readGraphStatus(ctx.kvService, ctx.projectId, ctx.targetCwd)
		expect(targetStatus).not.toBeNull()
		expect(targetStatus?.state).toBe('ready')
		expect(targetStatus?.updatedAt).toBeGreaterThan(sourceStatus.updatedAt)

		// Verify root/unrelated scope was not affected
		const rootStatus = readGraphStatus(ctx.kvService, ctx.projectId)
		expect(rootStatus).toBeNull()
	})

	test('should not copy status when source status is not ready', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Write indexing status to source scope
		const { writeGraphStatus } = await import('../src/utils/graph-status-store')
		const sourceStatus = {
			state: 'indexing' as const,
			ready: false,
			updatedAt: Date.now(),
		}
		writeGraphStatus(ctx.kvService, ctx.projectId, sourceStatus, ctx.sourceCwd)

		// Seed
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		expect(result.seeded).toBe(true)

		// Verify status was NOT copied to target scope
		const { readGraphStatus } = await import('../src/utils/graph-status-store')
		const targetStatus = readGraphStatus(ctx.kvService, ctx.projectId, ctx.targetCwd)
		expect(targetStatus).toBeNull()
	})

	test('should not copy ready status when source graph database is unhealthy', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Write ready status to source scope
		const { writeGraphStatus } = await import('../src/utils/graph-status-store')
		const sourceStatus = {
			state: 'ready' as const,
			ready: true,
			stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
			updatedAt: Date.now() - 1000,
		}
		writeGraphStatus(ctx.kvService, ctx.projectId, sourceStatus, ctx.sourceCwd)

		// Corrupt the source graph database by overwriting with garbage
		const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
		const sourceGraphDbPath = join(sourceCacheDir, 'graph.db')
		writeFileSync(sourceGraphDbPath, 'corrupted data')

		// Seed
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		// Seeding should fail when source graph is unhealthy (corrupt)
		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source graph database unhealthy or empty')

		// Verify target cache was NOT created (because seeding was skipped)
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		expect(existsSync(targetCacheDir)).toBe(false)
	})

	test('should not copy ready status when source graph database is empty (schema only)', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Write ready status to source scope
		const { writeGraphStatus } = await import('../src/utils/graph-status-store')
		const sourceStatus = {
			state: 'ready' as const,
			ready: true,
			stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
			updatedAt: Date.now() - 1000,
		}
		writeGraphStatus(ctx.kvService, ctx.projectId, sourceStatus, ctx.sourceCwd)

		// Replace source graph database with empty schema-only database
		const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
		const sourceGraphDbPath = join(sourceCacheDir, 'graph.db')
		const { Database } = await import('bun:sqlite')
		// Delete existing DB and recreate with schema only
		rmSync(sourceGraphDbPath)
		const emptyDb = new Database(sourceGraphDbPath)
		// Create schema but no data
		emptyDb.run('CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, path TEXT, mtimeMs INTEGER)')
		emptyDb.close()

		// Seed
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		// Seeding should fail when source graph is empty (schema only)
		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source graph database unhealthy or empty')

		// Verify target cache was NOT created (because seeding was skipped)
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		expect(existsSync(targetCacheDir)).toBe(false)
	})

	test('should not seed when source graph has partial data (row count mismatch with metadata)', async () => {
		const fileCount = 10
		const maxMtimeMs = Date.now()

		// Create source graph cache with metadata claiming 10 files
		createSourceGraphCache(ctx, fileCount, maxMtimeMs)

		// Create matching target files
		createTestFiles(ctx.targetCwd, fileCount, maxMtimeMs)

		// Write ready status to source scope
		const { writeGraphStatus } = await import('../src/utils/graph-status-store')
		const sourceStatus = {
			state: 'ready' as const,
			ready: true,
			stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
			updatedAt: Date.now() - 1000,
		}
		writeGraphStatus(ctx.kvService, ctx.projectId, sourceStatus, ctx.sourceCwd)

		// Truncate the source graph to only have 5 rows (mismatch with metadata)
		const sourceCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.sourceCwd, ctx.dataDir)
		const sourceGraphDbPath = join(sourceCacheDir, 'graph.db')
		const { Database } = await import('bun:sqlite')
		const db = new Database(sourceGraphDbPath)
		db.run('DELETE FROM files LIMIT 5') // Delete 5 rows, leaving only 5
		db.close()

		// Seed
		const result = await seedWorktreeGraphScope({
			projectId: ctx.projectId,
			sourceCwd: ctx.sourceCwd,
			targetCwd: ctx.targetCwd,
			dataDir: ctx.dataDir,
			kvService: ctx.kvService,
			logger: { log: () => {}, error: () => {}, debug: () => {} },
		})

		// Seeding should fail when source graph row count doesn't match metadata
		expect(result.seeded).toBe(false)
		expect(result.reason).toBe('source graph database unhealthy or empty')

		// Verify target cache was NOT created (because seeding was skipped)
		const targetCacheDir = resolveGraphCacheDir(ctx.projectId, ctx.targetCwd, ctx.dataDir)
		expect(existsSync(targetCacheDir)).toBe(false)
	})
})
