/**
 * Phase 5 — Read-only fast path tests.
 *
 * Verifies that a follower GraphService opens its own read-only SQLite
 * handle against the leader's graph.db and short-circuits read-only RPC
 * methods through a local dispatcher instead of going over IPC.
 *
 * NOTE: these tests deliberately avoid asserting on actual file index
 * counts. The scan pipeline depends on tree-sitter WASM which isn't
 * guaranteed to load in every test environment (pre-existing pattern
 * observed in graph-service.test.ts). What we DO assert is the wiring:
 * follower returns stats consistent with the leader, RO calls are
 * local (latency-bounded), and promotion tears down the RO handle.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService, type GraphService } from '../src/graph/service'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'

function silentLogger(): Logger {
	return { log: () => {}, error: () => {}, debug: () => {} }
}

const ROOT = '/tmp/opencode-graph-ro-fastpath-' + Date.now()

describe('GraphService read-only fast path (Phase 5)', () => {
	let cwd: string
	let dataDir: string
	let projectId: string
	const services: GraphService[] = []

	beforeEach(() => {
		const suffix = Math.random().toString(36).slice(2)
		cwd = join(ROOT, suffix, 'repo')
		dataDir = join(ROOT, suffix, 'data')
		projectId = 'ro-fastpath-' + suffix
		mkdirSync(cwd, { recursive: true })
		mkdirSync(dataDir, { recursive: true })
		writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
	})

	afterEach(async () => {
		for (const s of services.splice(0)) {
			try {
				await s.close()
			} catch {
				/* ignore */
			}
		}
		if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
	})

	test('follower RO call returns same shape/values as leader (local dispatch)', async () => {
		const leader = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(leader)
		const leaderStats = await leader.getStats()
		expect(leader.mode).toBe('leader')
		expect(leaderStats).toHaveProperty('files')
		expect(leaderStats).toHaveProperty('symbols')
		expect(leaderStats).toHaveProperty('edges')

		const follower = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(follower)
		const followerStats = await follower.getStats()
		expect(follower.mode).toBe('follower')

		// Both processes read the same committed WAL snapshot — the follower
		// via its local RO dispatcher, the leader via its worker. Values must
		// be equal because they're reading the same DB file.
		expect(followerStats.files).toBe(leaderStats.files)
		expect(followerStats.symbols).toBe(leaderStats.symbols)
		expect(followerStats.edges).toBe(leaderStats.edges)
		expect(followerStats.summaries).toBe(leaderStats.summaries)
		expect(followerStats.calls).toBe(leaderStats.calls)
	})

	test('follower burst of RO calls is served locally (latency bound)', async () => {
		const leader = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(leader)
		await leader.getStats()

		const follower = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(follower)
		await follower.getStats()
		expect(follower.mode).toBe('follower')

		// 100 RO calls should complete quickly when served from the local
		// bun:sqlite handle (no IPC, no worker hop). If the fast path breaks
		// and we fall back to RPC, this typically takes several hundred ms
		// from socket round-trips + JSON framing.
		const start = performance.now()
		const calls: Promise<unknown>[] = []
		for (let i = 0; i < 100; i++) calls.push(follower.getStats())
		const results = await Promise.all(calls)
		const elapsed = performance.now() - start
		expect(results).toHaveLength(100)
		for (const r of results) expect(r).toBeDefined()
		// Loose bound: 100 local SELECTs complete in <500ms on any sane box.
		expect(elapsed).toBeLessThan(500)
	})

	test("promotion closes the follower's RO handle before worker takes over", async () => {
		const leader = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(leader)
		await leader.getStats()

		const follower = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(follower)
		await follower.getStats()
		expect(follower.mode).toBe('follower')

		// Kill the leader. The follower's RO handle is currently open on the
		// same DB file. Promotion must close that RO handle before the worker
		// opens the DB in read/write mode. On POSIX this is harmless, on
		// Windows it would block the reopen — the contract is the same both
		// ways: the promoted process must not hold any stale handles.
		await leader.close()
		services.splice(services.indexOf(leader), 1)
		await new Promise(r => setTimeout(r, 50))

		// This call triggers failover. Once it returns, the follower is the
		// new leader; the worker must have opened the DB successfully — if
		// the RO handle hadn't been released, this would fail on Windows and
		// leak the handle on POSIX.
		const stats = await follower.getStats()
		expect(stats).toBeDefined()
		expect(follower.mode).toBe('leader')

		// Writes via the new leader should work — this also proves the
		// worker holds an authoritative r/w handle, not a degraded one.
		await follower.onFileChanged(join(cwd, 'a.ts'))
	})
})
