import { test, expect, beforeEach, afterEach } from 'bun:test'
import { RepoMap } from '../src/graph/repo-map'
import { initializeGraphDatabase } from '../src/graph/database'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

let testDir: string
let repoMap: RepoMap

beforeEach(async () => {
	testDir = join('/tmp', `graph-timeout-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
	mkdirSync(testDir, { recursive: true })

	const { execSync } = await import('child_process')
	execSync('git init', { cwd: testDir })
	execSync('git config user.email "test@test.com"', { cwd: testDir })
	execSync('git config user.name "Test"', { cwd: testDir })

	const db = initializeGraphDatabase('test-project', testDir)

	repoMap = new RepoMap({ cwd: testDir, db })
	await repoMap.initialize()
})

afterEach(() => {
	rmSync(testDir, { recursive: true, force: true })
})

test('scanBatch reports elapsedMs and processed count', async () => {
	writeFileSync(join(testDir, 'a.ts'), 'export const a = 1\n')
	writeFileSync(join(testDir, 'b.ts'), 'export const b = 2\n')
	writeFileSync(join(testDir, 'c.ts'), 'export const c = 3\n')

	const { execSync } = await import('child_process')
	execSync('git add .', { cwd: testDir })

	const prep = await repoMap.prepareScan()
	expect(prep.totalFiles).toBeGreaterThanOrEqual(3)
	expect(prep.batchSize).toBeGreaterThan(0)

	const result = await repoMap.scanBatch(0, 100)
	expect(result.processed).toBe(prep.totalFiles)
	expect(result.completed).toBe(true)
	expect(result.nextOffset).toBe(prep.totalFiles)
	expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
	expect(result.skippedTimeouts).toBe(0)
})

test('scanBatch skips files that exceed per-file timeout, continues the rest', async () => {
	// Three normal files + one whose indexFile we stub to hang.
	writeFileSync(join(testDir, 'a.ts'), 'export const a = 1\n')
	writeFileSync(join(testDir, 'slow.ts'), 'export const slow = 2\n')
	writeFileSync(join(testDir, 'b.ts'), 'export const b = 3\n')

	const { execSync } = await import('child_process')
	execSync('git add .', { cwd: testDir })

	const prep = await repoMap.prepareScan()

	// Monkey-patch indexFile to hang on slow.ts.
	const origIndexFile = (repoMap as any).indexFile.bind(repoMap)
	;(repoMap as any).indexFile = async (filePath: string) => {
		if (filePath.endsWith('slow.ts')) {
			await new Promise(resolve => setTimeout(resolve, 5_000))
			return
		}
		return origIndexFile(filePath)
	}
	// Shrink timeout for this test.
	;(repoMap as any).indexFileWithTimeout = async function (filePath: string) {
		let timer: ReturnType<typeof setTimeout> | null = null
		const indexingPromise = (this as any).indexFile(filePath) as Promise<void>
		indexingPromise.catch(() => {})
		try {
			await Promise.race([
				indexingPromise,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error(`__indexFileTimeout__:${filePath}`)), 200)
				}),
			])
		} finally {
			if (timer) clearTimeout(timer)
		}
	}

	const result = await repoMap.scanBatch(0, 100)
	expect(result.processed).toBe(prep.totalFiles)
	expect(result.completed).toBe(true)
	expect(result.skippedTimeouts).toBe(1)
})
