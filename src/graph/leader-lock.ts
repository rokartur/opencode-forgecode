/**
 * Leader election via atomic lockfile on the graph directory.
 *
 * Exactly one process per `graphDir` owns `graph.lock` and is the "leader".
 * Other processes observe the lockfile and act as "followers" that will
 * connect to the leader over IPC (see Phase 2).
 *
 * Locking strategy:
 *   - `openSync(path, 'wx')` is atomic on POSIX and Windows: exactly one
 *     caller wins the create race.
 *   - The winner writes metadata (pid, socketPath, startedAt, heartbeatAt,
 *     version) and periodically refreshes `heartbeatAt`.
 *   - Losers parse the file and decide if the lock is stale:
 *       * `process.kill(pid, 0)` → dead pid is always stale,
 *       * `now - heartbeatAt > staleMs` → stale even if pid survives,
 *       * malformed/missing fields → stale.
 *   - When stale, we unlink and retry acquire once. This is safe because the
 *     unlink+create pair is still governed by the atomic `wx` — two racing
 *     followers that both observe staleness will only let one create.
 */

import {
	openSync,
	writeSync,
	fsyncSync,
	closeSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
	renameSync,
	existsSync,
} from 'fs'
import { join } from 'path'

export const LEADER_LOCK_VERSION = 1
export const LEADER_LOCK_FILENAME = 'graph.lock'

/** Default heartbeat refresh interval (ms). */
export const DEFAULT_HEARTBEAT_MS = 5_000
/** Default staleness threshold (ms). Heartbeat older than this is considered stale. */
export const DEFAULT_STALE_MS = 15_000

export interface LeaderInfo {
	version: number
	pid: number
	socketPath: string
	startedAt: number
	heartbeatAt: number
}

export interface AcquireOptions {
	/** Path of the IPC endpoint this process will listen on if it becomes leader. */
	socketPath: string
	/** Milliseconds between automatic heartbeat refreshes. */
	heartbeatMs?: number
	/** Milliseconds after which a lockfile without fresh heartbeat is stale. */
	staleMs?: number
	/** If true, do not install process exit handlers (useful for tests). */
	skipExitHandlers?: boolean
	/** Injectable clock for tests. */
	now?: () => number
	/** Injectable pid check for tests. Return true if pid is alive. */
	isAlive?: (pid: number) => boolean
}

export interface LeaderHandle {
	readonly role: 'leader'
	readonly info: LeaderInfo
	readonly lockPath: string
	/** Rewrite the lockfile with a bumped heartbeat. Safe to call repeatedly. */
	refresh(): void
	/** Validate that the on-disk lockfile still belongs to this process. */
	validateOwnership(): boolean
	/** Stop heartbeat timer, unlink the lockfile if we still own it. */
	release(): void
}

export interface FollowerObservation {
	readonly role: 'follower'
	readonly info: LeaderInfo
	readonly lockPath: string
}

export type AcquireResult = LeaderHandle | FollowerObservation

function defaultIsAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false
	try {
		// Signal 0 does not send a signal but performs error checking.
		process.kill(pid, 0)
		return true
	} catch (err: any) {
		if (err && err.code === 'EPERM') {
			// Process exists but we can't signal it — treat as alive.
			return true
		}
		return false
	}
}

function parseLeaderFile(raw: string): LeaderInfo | null {
	try {
		const parsed = JSON.parse(raw)
		if (
			parsed &&
			typeof parsed === 'object' &&
			typeof parsed.pid === 'number' &&
			typeof parsed.socketPath === 'string' &&
			typeof parsed.startedAt === 'number' &&
			typeof parsed.heartbeatAt === 'number' &&
			typeof parsed.version === 'number'
		) {
			return parsed as LeaderInfo
		}
		return null
	} catch {
		return null
	}
}

export function readLeaderInfo(graphDir: string): LeaderInfo | null {
	const lockPath = join(graphDir, LEADER_LOCK_FILENAME)
	if (!existsSync(lockPath)) return null
	try {
		return parseLeaderFile(readFileSync(lockPath, 'utf8'))
	} catch {
		return null
	}
}

function isStale(info: LeaderInfo | null, now: number, staleMs: number, isAlive: (pid: number) => boolean): boolean {
	if (!info) return true
	if (info.version !== LEADER_LOCK_VERSION) return true
	if (!isAlive(info.pid)) return true
	if (now - info.heartbeatAt > staleMs) return true
	return false
}

function writeLeaderFile(lockPath: string, info: LeaderInfo): void {
	// Write+rename for atomic replace; plain writeFileSync is acceptable because
	// only the leader ever rewrites this file.
	const tmp = lockPath + '.tmp'
	writeFileSync(tmp, JSON.stringify(info))
	renameSync(tmp, lockPath)
}

function tryCreateLock(lockPath: string, info: LeaderInfo): boolean {
	let fd: number
	try {
		fd = openSync(lockPath, 'wx')
	} catch (err: any) {
		if (err && err.code === 'EEXIST') return false
		throw err
	}
	try {
		const payload = Buffer.from(JSON.stringify(info))
		writeSync(fd, payload, 0, payload.length, 0)
		fsyncSync(fd)
	} finally {
		closeSync(fd)
	}
	return true
}

export function acquireLeader(graphDir: string, options: AcquireOptions): AcquireResult {
	const lockPath = join(graphDir, LEADER_LOCK_FILENAME)
	const now = options.now ?? Date.now
	const isAlive = options.isAlive ?? defaultIsAlive
	const staleMs = options.staleMs ?? DEFAULT_STALE_MS
	const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

	// Up to two passes: initial attempt, and a single retry after clearing a stale lock.
	for (let attempt = 0; attempt < 2; attempt++) {
		const startedAt = now()
		const info: LeaderInfo = {
			version: LEADER_LOCK_VERSION,
			pid: process.pid,
			socketPath: options.socketPath,
			startedAt,
			heartbeatAt: startedAt,
		}

		if (tryCreateLock(lockPath, info)) {
			return buildLeaderHandle(lockPath, info, heartbeatMs, options, now)
		}

		// Lock exists — inspect.
		const existing = readLeaderInfo(graphDir)
		if (!isStale(existing, now(), staleMs, isAlive)) {
			// Valid leader — we are a follower.
			return { role: 'follower', info: existing!, lockPath }
		}

		// Stale: try to unlink and retry acquire. If unlink fails because another
		// racing process already cleaned it up, fall through to the next attempt.
		try {
			unlinkSync(lockPath)
		} catch (err: any) {
			if (err && err.code !== 'ENOENT') throw err
		}
	}

	// After two attempts we still lost the race — treat the current winner as
	// the leader, even if its heartbeat is still catching up.
	const final = readLeaderInfo(graphDir)
	if (final) {
		return { role: 'follower', info: final, lockPath }
	}
	// Extremely unlikely: lockfile vanished between retry and read. One last try.
	const startedAt = now()
	const info: LeaderInfo = {
		version: LEADER_LOCK_VERSION,
		pid: process.pid,
		socketPath: options.socketPath,
		startedAt,
		heartbeatAt: startedAt,
	}
	if (tryCreateLock(lockPath, info)) {
		return buildLeaderHandle(lockPath, info, heartbeatMs, options, now)
	}
	const last = readLeaderInfo(graphDir)
	if (last) return { role: 'follower', info: last, lockPath }
	throw new Error(`acquireLeader: failed to resolve leader for ${graphDir}`)
}

function buildLeaderHandle(
	lockPath: string,
	info: LeaderInfo,
	heartbeatMs: number,
	options: AcquireOptions,
	now: () => number,
): LeaderHandle {
	let released = false
	let timer: ReturnType<typeof setInterval> | null = null
	// Capture startedAt for ownership validation — any rewrite must preserve it.
	const ownStartedAt = info.startedAt
	const currentInfo: LeaderInfo = { ...info }

	const validateOwnership = (): boolean => {
		try {
			const raw = readFileSync(lockPath, 'utf8')
			const parsed = parseLeaderFile(raw)
			if (!parsed) return false
			return parsed.pid === process.pid && parsed.startedAt === ownStartedAt
		} catch {
			return false
		}
	}

	const refresh = () => {
		if (released) return
		// If another process has claimed the lock (our entry got overwritten
		// because we were considered stale), stop refreshing — re-writing our
		// info would race and could cause split-brain. The service-level
		// ownership watchdog will abdicate on its next tick.
		if (!validateOwnership()) {
			if (timer) {
				clearInterval(timer)
				timer = null
			}
			return
		}
		currentInfo.heartbeatAt = now()
		try {
			writeLeaderFile(lockPath, currentInfo)
		} catch {
			// Refresh is best-effort; next heartbeat will retry. Do not throw from a timer.
		}
	}

	const release = () => {
		if (released) return
		released = true
		if (timer) {
			clearInterval(timer)
			timer = null
		}
		if (validateOwnership()) {
			try {
				unlinkSync(lockPath)
			} catch {
				// ignore
			}
		}
	}

	if (heartbeatMs > 0) {
		timer = setInterval(refresh, heartbeatMs)
		// Unref so the heartbeat never keeps the process alive on its own.
		;(timer as any).unref?.()
	}

	if (!options.skipExitHandlers) {
		const onExit = () => release()
		process.once('exit', onExit)
		// For signals, release and then re-raise so the process exits with the
		// OS-expected status and any other handlers observe the signal.
		const makeSignalHandler = (signal: NodeJS.Signals) => {
			const handler = () => {
				release()
				process.removeListener(signal, handler)
				try {
					process.kill(process.pid, signal)
				} catch {
					process.exit(1)
				}
			}
			process.once(signal, handler)
		}
		makeSignalHandler('SIGINT')
		makeSignalHandler('SIGTERM')
		makeSignalHandler('SIGHUP')
	}

	return {
		role: 'leader',
		info: currentInfo,
		lockPath,
		refresh,
		validateOwnership,
		release,
	}
}
