import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService, type GraphService } from '../src/graph/service'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'

/**
 * Phase 7 — Stress / integration tests.
 *
 * These tests spin up N GraphService instances against the same
 * `(projectId, cwd)` and assert that the leader-election + IPC
 * machinery scales to ~10 parallel sessions without user-visible
 * SQLITE_BUSY errors.
 *
 * Each `createGraphService()` call takes an independent lock attempt
 * so — even within one Bun process — the filesystem lockfile and the
 * UDS IPC server exercise the real cross-session code path. This is
 * the same stack a real user with 10 concurrent opencode sessions
 * would hit; the only difference is the PID.
 */

function silentLogger(): Logger {
	return { log: () => {}, error: () => {}, debug: () => {} }
}

const ROOT = '/tmp/opencode-graph-stress-' + Date.now()

describe('GraphService stress — 10 concurrent sessions (Phase 7)', () => {
	let cwd: string
	let dataDir: string
	let projectId: string
	const services: GraphService[] = []

	beforeEach(() => {
		const suffix = Math.random().toString(36).slice(2)
		cwd = join(ROOT, suffix, 'repo')
		dataDir = join(ROOT, suffix, 'data')
		projectId = 'stress-' + suffix
		mkdirSync(cwd, { recursive: true })
		mkdirSync(dataDir, { recursive: true })
		// Enough files that initial scan is non-trivial but still fast.
		for (let i = 0; i < 8; i++) {
			writeFileSync(
				join(cwd, `file${i}.ts`),
				`export const v${i} = ${i}\nexport function f${i}() { return v${i} }\n`,
			)
		}
	})

	afterEach(async () => {
		await Promise.allSettled(services.splice(0).map(s => s.close()))
		if (existsSync(ROOT)) rmSync(ROOT, { recursive: true, force: true })
	})

	test('10 concurrent clean starts → exactly one leader, nine followers, all queries succeed', async () => {
		const N = 10
		const instances = Array.from({ length: N }, () =>
			createGraphService({
				projectId,
				dataDir,
				cwd,
				logger: silentLogger(),
				watch: false,
			}),
		)
		services.push(...instances)

		// All initialize concurrently — stampede the lockfile and IPC server.
		const stats = await Promise.all(instances.map(s => s.getStats()))

		// Exactly one leader.
		const leaderCount = instances.filter(s => s.mode === 'leader').length
		const followerCount = instances.filter(s => s.mode === 'follower').length
		expect(leaderCount).toBe(1)
		expect(followerCount).toBe(N - 1)

		// All followers see the leader's stats (byte-identical shape).
		for (const st of stats) {
			expect(st).toBeDefined()
			expect(st.files).toBe(stats[0].files)
		}
	})

	test('concurrent query burst across 10 sessions — no error leaks', async () => {
		const N = 10
		const instances = Array.from({ length: N }, () =>
			createGraphService({
				projectId,
				dataDir,
				cwd,
				logger: silentLogger(),
				watch: false,
			}),
		)
		services.push(...instances)

		// Warm up: ensure leader is elected and initial scan done.
		await Promise.all(instances.map(s => s.getStats()))

		// Now fire 100 read queries across all 10 services in parallel.
		const queries: Promise<unknown>[] = []
		for (let i = 0; i < 10; i++) {
			for (const s of instances) {
				queries.push(s.getStats())
				queries.push(s.getTopFiles(5))
			}
		}
		const results = await Promise.allSettled(queries)
		const failures = results.filter(r => r.status === 'rejected')
		expect(failures).toHaveLength(0)
	})

	test('leader kill under load → surviving followers fail over, one promotes, no SQLITE_BUSY surfaces', async () => {
		const N = 10
		const instances = Array.from({ length: N }, () =>
			createGraphService({
				projectId,
				dataDir,
				cwd,
				logger: silentLogger(),
				watch: false,
			}),
		)
		services.push(...instances)
		await Promise.all(instances.map(s => s.getStats()))

		const leader = instances.find(s => s.mode === 'leader')
		expect(leader).toBeDefined()
		const followers = instances.filter(s => s !== leader)

		// Start a burst of concurrent queries, then kill the leader mid-flight.
		const inflight: Promise<unknown>[] = []
		for (let i = 0; i < 5; i++) {
			for (const f of followers) {
				inflight.push(f.getStats().catch(e => ({ __error: String(e) })))
			}
		}

		// Small delay so at least a few queries have been dispatched over IPC
		// before we pull the leader out from under them.
		await new Promise(r => setTimeout(r, 10))
		await leader!.close()
		services.splice(services.indexOf(leader!), 1)

		// Issue a second burst after the leader is gone — this must trigger
		// failover in exactly one follower and be served by all.
		for (let i = 0; i < 5; i++) {
			for (const f of followers) {
				inflight.push(f.getStats())
			}
		}

		const results = await Promise.all(inflight)
		// No SQLITE_BUSY strings in the aggregated results.
		const busyLeaks = results.filter(
			r =>
				r &&
				typeof r === 'object' &&
				'__error' in r &&
				typeof (r as { __error: string }).__error === 'string' &&
				/sqlite_busy|database is locked/i.test((r as { __error: string }).__error),
		)
		expect(busyLeaks).toHaveLength(0)

		// Exactly one new leader among the survivors.
		const newLeaderCount = followers.filter(s => s.mode === 'leader').length
		expect(newLeaderCount).toBe(1)

		// All followers can still serve queries.
		const final = await Promise.all(followers.map(s => s.getStats()))
		expect(final).toHaveLength(N - 1)
		for (const st of final) expect(st).toBeDefined()
	})

	test('write burst via re-open: sequential close+open cycles do not leak locks', async () => {
		// Simulates a user rapidly restarting sessions. Each cycle must
		// release the lockfile cleanly and let the next process acquire it.
		for (let i = 0; i < 5; i++) {
			const s = createGraphService({
				projectId,
				dataDir,
				cwd,
				logger: silentLogger(),
				watch: false,
			})
			await s.getStats()
			expect(s.mode).toBe('leader')
			await s.close()
		}
	})
})
