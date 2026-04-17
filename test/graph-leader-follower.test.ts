import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService, type GraphService } from '../src/graph/service'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'

function silentLogger(): Logger {
	return { log: () => {}, error: () => {}, debug: () => {} }
}

const ROOT = '/tmp/opencode-graph-leader-follower-' + Date.now()

describe('GraphService leader/follower mode', () => {
	let cwd: string
	let dataDir: string
	let projectId: string
	const services: GraphService[] = []

	beforeEach(() => {
		const suffix = Math.random().toString(36).slice(2)
		cwd = join(ROOT, suffix, 'repo')
		dataDir = join(ROOT, suffix, 'data')
		projectId = 'leader-follower-' + suffix
		mkdirSync(cwd, { recursive: true })
		mkdirSync(dataDir, { recursive: true })
		writeFileSync(join(cwd, 'a.ts'), 'export const a = 1\n')
		writeFileSync(join(cwd, 'b.ts'), "import { a } from './a'\nexport const b = a + 1\n")
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

	test("first service becomes leader, second becomes follower; queries go through the leader's worker", async () => {
		const leader = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(leader)
		// Trigger initialize (via any query) so the worker is up and the lock
		// is held before the follower tries to connect.
		const leaderStats = await leader.getStats()
		expect(leader.mode).toBe('leader')

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

		// Both callers see byte-identical stats because the follower's query is
		// proxied into the leader's worker over IPC.
		expect(followerStats).toEqual(leaderStats)

		// A second query on the follower should keep routing through the socket.
		const followerStats2 = await follower.getStats()
		expect(followerStats2).toEqual(leaderStats)
		expect(follower.mode).toBe('follower')
	})

	test('after leader close, next service reclaims leader role', async () => {
		const leader = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(leader)
		await leader.getStats()
		expect(leader.mode).toBe('leader')
		await leader.close()
		services.splice(services.indexOf(leader), 1)

		// Now a new service should grab leader again (lockfile was released).
		const second = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(second)
		await second.getStats()
		expect(second.mode).toBe('leader')
	})

	test('three services: one leader, two followers, all see the same stats', async () => {
		const a = createGraphService({ projectId, dataDir, cwd, logger: silentLogger(), watch: false })
		services.push(a)
		const statsA = await a.getStats()
		expect(a.mode).toBe('leader')

		const b = createGraphService({ projectId, dataDir, cwd, logger: silentLogger(), watch: false })
		const c = createGraphService({ projectId, dataDir, cwd, logger: silentLogger(), watch: false })
		services.push(b, c)
		const [statsB, statsC] = await Promise.all([b.getStats(), c.getStats()])
		expect(b.mode).toBe('follower')
		expect(c.mode).toBe('follower')
		expect(statsB).toEqual(statsA)
		expect(statsC).toEqual(statsA)
	})
})
