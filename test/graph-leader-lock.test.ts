import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
	acquireLeader,
	readLeaderInfo,
	LEADER_LOCK_FILENAME,
	LEADER_LOCK_VERSION,
	type LeaderHandle,
} from '../src/graph/leader-lock'

function makeTempDir(): string {
	const dir = join(tmpdir(), 'leader-lock-' + Date.now() + '-' + Math.random().toString(36).slice(2))
	mkdirSync(dir, { recursive: true })
	return dir
}

describe('leader-lock', () => {
	let dir: string

	beforeEach(() => {
		dir = makeTempDir()
	})

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
	})

	test('first caller becomes leader and writes lockfile', () => {
		const result = acquireLeader(dir, {
			socketPath: '/tmp/sock-a',
			skipExitHandlers: true,
			heartbeatMs: 0,
		})
		expect(result.role).toBe('leader')
		const lockPath = join(dir, LEADER_LOCK_FILENAME)
		expect(existsSync(lockPath)).toBe(true)
		const info = readLeaderInfo(dir)!
		expect(info.version).toBe(LEADER_LOCK_VERSION)
		expect(info.pid).toBe(process.pid)
		expect(info.socketPath).toBe('/tmp/sock-a')
		expect(typeof info.startedAt).toBe('number')
		expect(info.heartbeatAt).toBe(info.startedAt)
		;(result as LeaderHandle).release()
		expect(existsSync(lockPath)).toBe(false)
	})

	test('second caller in same process becomes follower and sees leader info', () => {
		const leader = acquireLeader(dir, {
			socketPath: '/tmp/sock-a',
			skipExitHandlers: true,
			heartbeatMs: 0,
		}) as LeaderHandle
		expect(leader.role).toBe('leader')

		const follower = acquireLeader(dir, {
			socketPath: '/tmp/sock-b',
			skipExitHandlers: true,
			heartbeatMs: 0,
		})
		expect(follower.role).toBe('follower')
		if (follower.role === 'follower') {
			expect(follower.info.socketPath).toBe('/tmp/sock-a')
			expect(follower.info.pid).toBe(process.pid)
		}
		leader.release()
	})

	test('stale lockfile (dead pid) is reclaimed', () => {
		const lockPath = join(dir, LEADER_LOCK_FILENAME)
		writeFileSync(
			lockPath,
			JSON.stringify({
				version: LEADER_LOCK_VERSION,
				pid: 999_999_999, // implausible pid
				socketPath: '/tmp/old',
				startedAt: Date.now() - 1000,
				heartbeatAt: Date.now() - 500,
			}),
		)

		const result = acquireLeader(dir, {
			socketPath: '/tmp/new',
			skipExitHandlers: true,
			heartbeatMs: 0,
			isAlive: pid => pid === process.pid, // everything else is dead
		})
		expect(result.role).toBe('leader')
		const info = readLeaderInfo(dir)!
		expect(info.socketPath).toBe('/tmp/new')
		;(result as LeaderHandle).release()
	})

	test('stale lockfile (old heartbeat) is reclaimed even if pid is alive', () => {
		const lockPath = join(dir, LEADER_LOCK_FILENAME)
		const now = Date.now()
		writeFileSync(
			lockPath,
			JSON.stringify({
				version: LEADER_LOCK_VERSION,
				pid: process.pid,
				socketPath: '/tmp/zombie',
				startedAt: now - 60_000,
				heartbeatAt: now - 60_000,
			}),
		)

		const result = acquireLeader(dir, {
			socketPath: '/tmp/fresh',
			skipExitHandlers: true,
			heartbeatMs: 0,
			staleMs: 10_000,
			isAlive: () => true,
		})
		expect(result.role).toBe('leader')
		const info = readLeaderInfo(dir)!
		expect(info.socketPath).toBe('/tmp/fresh')
		;(result as LeaderHandle).release()
	})

	test('malformed lockfile is reclaimed', () => {
		const lockPath = join(dir, LEADER_LOCK_FILENAME)
		writeFileSync(lockPath, 'not-json-at-all')

		const result = acquireLeader(dir, {
			socketPath: '/tmp/a',
			skipExitHandlers: true,
			heartbeatMs: 0,
		})
		expect(result.role).toBe('leader')
		;(result as LeaderHandle).release()
	})

	test('fresh lockfile held by live pid with alive heartbeat is respected', () => {
		const lockPath = join(dir, LEADER_LOCK_FILENAME)
		const now = Date.now()
		writeFileSync(
			lockPath,
			JSON.stringify({
				version: LEADER_LOCK_VERSION,
				pid: 12345,
				socketPath: '/tmp/held',
				startedAt: now - 1000,
				heartbeatAt: now - 500,
			}),
		)

		const result = acquireLeader(dir, {
			socketPath: '/tmp/other',
			skipExitHandlers: true,
			heartbeatMs: 0,
			staleMs: 10_000,
			isAlive: pid => pid === 12345,
		})
		expect(result.role).toBe('follower')
		if (result.role === 'follower') {
			expect(result.info.socketPath).toBe('/tmp/held')
			expect(result.info.pid).toBe(12345)
		}
	})

	test('refresh updates heartbeatAt on disk', () => {
		let fakeNow = 1_000_000
		const clock = () => fakeNow
		const leader = acquireLeader(dir, {
			socketPath: '/tmp/a',
			skipExitHandlers: true,
			heartbeatMs: 0,
			now: clock,
		}) as LeaderHandle
		expect(leader.role).toBe('leader')
		const before = readLeaderInfo(dir)!
		expect(before.heartbeatAt).toBe(1_000_000)

		fakeNow = 1_005_000
		leader.refresh()
		const after = readLeaderInfo(dir)!
		expect(after.heartbeatAt).toBe(1_005_000)
		expect(after.startedAt).toBe(before.startedAt)

		leader.release()
	})

	test('validateOwnership returns false when lockfile is overwritten by another pid', () => {
		const leader = acquireLeader(dir, {
			socketPath: '/tmp/a',
			skipExitHandlers: true,
			heartbeatMs: 0,
		}) as LeaderHandle
		expect(leader.validateOwnership()).toBe(true)

		// Overwrite lockfile with foreign pid → ownership lost.
		const lockPath = join(dir, LEADER_LOCK_FILENAME)
		const foreign = {
			version: LEADER_LOCK_VERSION,
			pid: 999_999_000,
			socketPath: '/tmp/foreign',
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
		}
		writeFileSync(lockPath, JSON.stringify(foreign))

		expect(leader.validateOwnership()).toBe(false)
		// release() must NOT delete the foreign lockfile.
		leader.release()
		expect(existsSync(lockPath)).toBe(true)
		const still = JSON.parse(readFileSync(lockPath, 'utf8'))
		expect(still.pid).toBe(999_999_000)
	})

	test('release() is idempotent', () => {
		const leader = acquireLeader(dir, {
			socketPath: '/tmp/a',
			skipExitHandlers: true,
			heartbeatMs: 0,
		}) as LeaderHandle
		leader.release()
		leader.release() // must not throw
		expect(existsSync(join(dir, LEADER_LOCK_FILENAME))).toBe(false)
	})

	test('readLeaderInfo returns null when lockfile is missing', () => {
		expect(readLeaderInfo(dir)).toBeNull()
	})
})
