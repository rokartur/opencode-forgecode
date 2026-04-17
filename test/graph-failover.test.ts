import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createGraphService, type GraphService } from '../src/graph/service'
import { LeaderLostError } from '../src/graph/errors'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Logger } from '../src/types'

function silentLogger(): Logger {
	return { log: () => {}, error: () => {}, debug: () => {} }
}

const ROOT = '/tmp/opencode-graph-failover-' + Date.now()

describe('GraphService failover (Phase 4)', () => {
	let cwd: string
	let dataDir: string
	let projectId: string
	const services: GraphService[] = []

	beforeEach(() => {
		const suffix = Math.random().toString(36).slice(2)
		cwd = join(ROOT, suffix, 'repo')
		dataDir = join(ROOT, suffix, 'data')
		projectId = 'failover-' + suffix
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

	test('follower promotes to leader after leader.close() — read-only retries transparently', async () => {
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

		// Kill the leader. The goodbye frame propagates asynchronously to the
		// follower's socket; wait one event-loop tick so SocketTransport has
		// a chance to process it and emit 'exit', which kicks off eager
		// failover in GraphClient. With Phase 5's RO fast path, without this
		// wait a read-only call could otherwise be served locally and never
		// trigger promotion.
		await leader.close()
		services.splice(services.indexOf(leader), 1)
		await new Promise(r => setTimeout(r, 50))

		// Read-only call should succeed via promotion (follower → leader).
		// The invoke() gate awaits any in-flight failover before dispatch.
		const stats = await follower.getStats()
		expect(stats).toBeDefined()
		expect(follower.mode).toBe('leader')
	})

	test('write-mode RPC throws LeaderLostError when leader disappears mid-call', async () => {
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

		// Kill the leader.
		await leader.close()
		services.splice(services.indexOf(leader), 1)

		// Write-mode call (scan) should throw LeaderLostError — writes are not
		// auto-retried. The background failover still runs.
		let caught: unknown = null
		try {
			await follower.scan()
		} catch (err) {
			caught = err
		}
		expect(caught).toBeInstanceOf(LeaderLostError)
		expect((caught as LeaderLostError).method).toBeDefined()
	})

	test('three followers + leader: killing leader lets exactly one follower promote, others reconnect', async () => {
		const leader = createGraphService({
			projectId,
			dataDir,
			cwd,
			logger: silentLogger(),
			watch: false,
		})
		services.push(leader)
		await leader.getStats()

		const followers: GraphService[] = []
		for (let i = 0; i < 3; i++) {
			const f = createGraphService({
				projectId,
				dataDir,
				cwd,
				logger: silentLogger(),
				watch: false,
			})
			services.push(f)
			followers.push(f)
			await f.getStats()
			expect(f.mode).toBe('follower')
		}

		await leader.close()
		services.splice(services.indexOf(leader), 1)
		// See Phase 5 note above — let goodbye propagate + eager failover kick in.
		await new Promise(r => setTimeout(r, 50))

		// All followers issue a read-only call; after failover, exactly one
		// is now leader and the others are followers pointing at it. The
		// invoke() gate awaits activeFailover so the call blocks until the
		// cluster has converged.
		const results = await Promise.all(followers.map(f => f.getStats()))
		for (const r of results) {
			expect(r).toBeDefined()
		}
		const newLeaderCount = followers.filter(f => f.mode === 'leader').length
		const newFollowerCount = followers.filter(f => f.mode === 'follower').length
		expect(newLeaderCount).toBe(1)
		expect(newFollowerCount).toBe(2)
	})

	test('split-brain: if lockfile is externally replaced, leader abdicates on watchdog tick', async () => {
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

		// Locate graph dir via data layout: we don't export it; instead find
		// the graph.lock under dataDir recursively.
		const lockPath = findLockfile(dataDir)
		expect(lockPath).toBeTruthy()

		// Externally overwrite the lockfile so validateOwnership() returns
		// false on the next tick. Use a different pid / startedAt.
		const original = JSON.parse(readFileSync(lockPath!, 'utf8'))
		const tampered = {
			...original,
			pid: 999999,
			startedAt: original.startedAt + 1000,
			heartbeatAt: Date.now(),
		}
		writeFileSync(lockPath!, JSON.stringify(tampered), 'utf8')

		// Wait for watchdog tick (5s + slack). We'll poll mode.
		const deadline = Date.now() + 8000
		while (Date.now() < deadline && leader.mode === 'leader') {
			await new Promise(r => setTimeout(r, 200))
		}
		expect(leader.mode).toBe(null)
	}, 15000)
})

function findLockfile(root: string): string | null {
	const fs = require('fs')
	const path = require('path')
	const stack = [root]
	while (stack.length) {
		const dir = stack.pop()!
		let entries: string[] = []
		try {
			entries = fs.readdirSync(dir)
		} catch {
			continue
		}
		for (const name of entries) {
			const full = path.join(dir, name)
			let st: { isDirectory: () => boolean } | null = null
			try {
				st = fs.statSync(full)
			} catch {
				continue
			}
			if (st.isDirectory()) {
				stack.push(full)
			} else if (name === 'graph.lock') {
				return full
			}
		}
	}
	return null
}
