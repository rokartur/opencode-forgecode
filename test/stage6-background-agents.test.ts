/**
 * Stage 6 — Background agents + multi-agent orchestration tests.
 *
 * Tests cover:
 *  - BackgroundManager: CRUD lifecycle (enqueue, status transitions, queries)
 *  - ConcurrencyManager: global + per-model limits, drainPending
 *  - Agent registry: all 9 agents present, toolSupported flags correct
 *  - Agent-as-tool: correct tools are generated for toolSupported agents
 *  - Feature-support: background descriptor now 'implemented'
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BackgroundManager } from '../src/runtime/background/manager'
import { ConcurrencyManager } from '../src/runtime/background/concurrency'
import { agents, type AgentRole } from '../src/agents'
import { getCapabilityDescriptors, collectUnsupportedConfigIssues } from '../src/runtime/feature-support'
import type { PluginConfig } from '../src/types'

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

/** Minimal in-memory SQLite compatible with BackgroundManager */
function createMemoryDb(): Database {
	return new Database(':memory:')
}

function makeTask(overrides?: Record<string, unknown>) {
	return {
		id: `t-${Math.random().toString(36).slice(2, 8)}`,
		parentAgent: 'forge',
		targetAgent: 'librarian',
		prompt: 'find all usages of foo',
		model: 'default',
		...overrides,
	}
}

// ────────────────────────────────────────────────────────────
// BackgroundManager CRUD
// ────────────────────────────────────────────────────────────

describe('BackgroundManager', () => {
	let db: Database
	let mgr: BackgroundManager

	beforeEach(() => {
		db = createMemoryDb()
		mgr = new BackgroundManager(db as any)
	})

	afterEach(() => {
		db.close()
	})

	test('enqueue creates a pending task', () => {
		const task = mgr.enqueue(makeTask({ id: 'test-1' }))
		expect(task.id).toBe('test-1')
		expect(task.status).toBe('pending')
		expect(task.sessionId).toBeNull()
		expect(task.createdAt).toBeGreaterThan(0)
	})

	test('markRunning transitions pending → running', () => {
		mgr.enqueue(makeTask({ id: 'r-1' }))
		mgr.markRunning('r-1', 'session-abc')
		const task = mgr.getById('r-1')!
		expect(task.status).toBe('running')
		expect(task.sessionId).toBe('session-abc')
	})

	test('markRunning re-activates completed/error tasks for continuation', () => {
		mgr.enqueue(makeTask({ id: 'r-2' }))
		mgr.markRunning('r-2', 'sess-1')
		mgr.markCompleted('r-2', 'done')
		// re-mark as running for continuation (per bg_continue support)
		mgr.markRunning('r-2', 'sess-2')
		expect(mgr.getById('r-2')!.status).toBe('running')
		expect(mgr.getById('r-2')!.sessionId).toBe('sess-2')
	})

	test('markRunning ignores cancelled tasks', () => {
		mgr.enqueue(makeTask({ id: 'r-3' }))
		mgr.cancel('r-3')
		mgr.markRunning('r-3', 'sess-3')
		expect(mgr.getById('r-3')!.status).toBe('cancelled')
	})

	test('markCompleted transitions running → completed', () => {
		mgr.enqueue(makeTask({ id: 'c-1' }))
		mgr.markRunning('c-1', 'sess')
		mgr.markCompleted('c-1', 'summary text')
		const task = mgr.getById('c-1')!
		expect(task.status).toBe('completed')
		expect(task.summary).toBe('summary text')
	})

	test('markError transitions to error with message', () => {
		mgr.enqueue(makeTask({ id: 'e-1' }))
		mgr.markRunning('e-1', 'sess')
		mgr.markError('e-1', 'timeout')
		const task = mgr.getById('e-1')!
		expect(task.status).toBe('error')
		expect(task.error).toBe('timeout')
	})

	test('cancel works on pending and running, not on terminal', () => {
		mgr.enqueue(makeTask({ id: 'x-1' }))
		expect(mgr.cancel('x-1')).toBe(true)
		expect(mgr.getById('x-1')!.status).toBe('cancelled')

		mgr.enqueue(makeTask({ id: 'x-2' }))
		mgr.markRunning('x-2', 'sess')
		expect(mgr.cancel('x-2')).toBe(true)

		mgr.enqueue(makeTask({ id: 'x-3' }))
		mgr.markRunning('x-3', 'sess')
		mgr.markCompleted('x-3')
		expect(mgr.cancel('x-3')).toBe(false)
	})

	test('updateSummary only updates running tasks', () => {
		mgr.enqueue(makeTask({ id: 's-1' }))
		mgr.markRunning('s-1', 'sess')
		mgr.updateSummary('s-1', 'progress...')
		expect(mgr.getById('s-1')!.summary).toBe('progress...')

		// pending task should not get summary updated
		mgr.enqueue(makeTask({ id: 's-2' }))
		mgr.updateSummary('s-2', 'nope')
		expect(mgr.getById('s-2')!.summary).toBe('')
	})

	test('getByStatus returns tasks in correct order', () => {
		mgr.enqueue(makeTask({ id: 'a', model: 'm1' }))
		mgr.enqueue(makeTask({ id: 'b', model: 'm1' }))
		mgr.enqueue(makeTask({ id: 'c', model: 'm2' }))
		mgr.markRunning('a', 'sess-a')
		const pending = mgr.getByStatus('pending')
		expect(pending.length).toBe(2)
		expect(pending[0].id).toBe('b')
		expect(pending[1].id).toBe('c')
		const running = mgr.getByStatus('running')
		expect(running.length).toBe(1)
		expect(running[0].id).toBe('a')
	})

	test('getAll returns all tasks respecting limit', () => {
		mgr.enqueue(makeTask({ id: 'z1' }))
		mgr.enqueue(makeTask({ id: 'z2' }))
		mgr.enqueue(makeTask({ id: 'z3' }))
		const all = mgr.getAll()
		expect(all.length).toBe(3)
		const ids = all.map(t => t.id).sort()
		expect(ids).toEqual(['z1', 'z2', 'z3'])
		// respect limit
		const limited = mgr.getAll(2)
		expect(limited.length).toBe(2)
	})

	test('countRunning and countRunningForModel', () => {
		mgr.enqueue(makeTask({ id: 'cnt-1', model: 'gpt4' }))
		mgr.enqueue(makeTask({ id: 'cnt-2', model: 'gpt4' }))
		mgr.enqueue(makeTask({ id: 'cnt-3', model: 'claude' }))
		mgr.markRunning('cnt-1', 'sess')
		mgr.markRunning('cnt-3', 'sess')
		expect(mgr.countRunning()).toBe(2)
		expect(mgr.countRunningForModel('gpt4')).toBe(1)
		expect(mgr.countRunningForModel('claude')).toBe(1)
		expect(mgr.countPending()).toBe(1)
	})

	test('getById returns null for unknown id', () => {
		expect(mgr.getById('nonexistent')).toBeNull()
	})
})

// ────────────────────────────────────────────────────────────
// ConcurrencyManager
// ────────────────────────────────────────────────────────────

describe('ConcurrencyManager', () => {
	let db: Database
	let bgMgr: BackgroundManager
	let cm: ConcurrencyManager

	beforeEach(() => {
		db = createMemoryDb()
		bgMgr = new BackgroundManager(db as any)
	})

	afterEach(() => {
		db.close()
	})

	test('canStart respects global limit', () => {
		cm = new ConcurrencyManager(bgMgr, { maxConcurrent: 2, perModelLimit: 10 })
		bgMgr.enqueue(makeTask({ id: 'a', model: 'm1' }))
		bgMgr.enqueue(makeTask({ id: 'b', model: 'm2' }))
		bgMgr.enqueue(makeTask({ id: 'c', model: 'm3' }))
		bgMgr.markRunning('a', 'sess')
		bgMgr.markRunning('b', 'sess')
		// 2 running, limit is 2 → cannot start
		expect(cm.canStart('m3')).toBe(false)
		// complete one → can start
		bgMgr.markCompleted('a')
		expect(cm.canStart('m3')).toBe(true)
	})

	test('canStart respects per-model limit', () => {
		cm = new ConcurrencyManager(bgMgr, { maxConcurrent: 10, perModelLimit: 1 })
		bgMgr.enqueue(makeTask({ id: 'a', model: 'gpt4' }))
		bgMgr.markRunning('a', 'sess')
		expect(cm.canStart('gpt4')).toBe(false)
		expect(cm.canStart('claude')).toBe(true)
	})

	test('drainPending promotes tasks within limits', () => {
		cm = new ConcurrencyManager(bgMgr, { maxConcurrent: 2, perModelLimit: 1 })
		bgMgr.enqueue(makeTask({ id: 'p1', model: 'gpt4' }))
		bgMgr.enqueue(makeTask({ id: 'p2', model: 'claude' }))
		bgMgr.enqueue(makeTask({ id: 'p3', model: 'gpt4' })) // blocked by per-model
		bgMgr.enqueue(makeTask({ id: 'p4', model: 'gemini' })) // blocked by global

		const ids = cm.drainPending()
		expect(ids).toContain('p1')
		expect(ids).toContain('p2')
		// p3 cannot start because gpt4 per-model limit of 1 is hit by p1
		expect(ids).not.toContain('p3')
		// p4 cannot start because global limit of 2 is hit
		expect(ids).not.toContain('p4')
		expect(ids.length).toBe(2)
	})

	test('utilisation returns correct snapshot', () => {
		cm = new ConcurrencyManager(bgMgr, { maxConcurrent: 5, perModelLimit: 2 })
		bgMgr.enqueue(makeTask({ id: 'u1', model: 'a' }))
		bgMgr.enqueue(makeTask({ id: 'u2', model: 'a' }))
		bgMgr.markRunning('u1', 'sess')
		const util = cm.utilisation()
		expect(util.running).toBe(1)
		expect(util.pending).toBe(1)
		expect(util.maxConcurrent).toBe(5)
		expect(util.perModelLimit).toBe(2)
	})
})

// ────────────────────────────────────────────────────────────
// BackgroundSpawner event emission
// ────────────────────────────────────────────────────────────

describe('BackgroundSpawner onTaskEvent', () => {
	test('fires "cancelled" event when a pending task is cancelled', async () => {
		const { BackgroundSpawner } = await import('../src/runtime/background/spawner')
		const db = createMemoryDb()
		const bgMgr = new BackgroundManager(db as any)
		const cm = new ConcurrencyManager(bgMgr, { maxConcurrent: 1, perModelLimit: 1 })

		// Fake v2 client — session.abort is called on cancel
		const v2 = {
			session: {
				abort: async () => ({ data: null, error: null }),
				create: async () => ({ data: null, error: 'no-spawn' }),
				get: async () => ({ data: null, error: null }),
				promptAsync: async () => ({ data: null, error: null }),
			},
			tui: {},
		}

		const events: Array<{ type: string; taskId: string }> = []
		const spawner = new BackgroundSpawner(
			v2 as unknown as ConstructorParameters<typeof BackgroundSpawner>[0],
			bgMgr,
			cm,
			'/tmp',
			{ log: () => {} },
			{
				pollIntervalMs: 1_000_000, // effectively disable poller
				idleTimeoutMs: 1_000_000,
				onTaskEvent: ({ type, task }) => {
					events.push({ type, taskId: task.id })
				},
			},
		)

		// Fill the one slot with a different running task so spawner keeps new one pending
		bgMgr.enqueue(makeTask({ id: 'occupy', model: 'm1' }))
		bgMgr.markRunning('occupy', 'sess-occupy')

		// Enqueue the task we'll cancel — cannot start (global limit = 1 already taken)
		await spawner.spawn({
			id: 'cancel-me',
			parentAgent: 'forge',
			targetAgent: 'librarian',
			prompt: 'noop',
			model: 'm1',
		})

		const ok = await spawner.cancel('cancel-me')
		expect(ok).toBe(true)
		expect(events).toEqual([{ type: 'cancelled', taskId: 'cancel-me' }])

		await spawner.shutdown()
		db.close()
	})

	test('fires "error" event when session.create fails', async () => {
		const { BackgroundSpawner } = await import('../src/runtime/background/spawner')
		const db = createMemoryDb()
		const bgMgr = new BackgroundManager(db as any)
		const cm = new ConcurrencyManager(bgMgr, { maxConcurrent: 10, perModelLimit: 10 })

		const v2 = {
			session: {
				abort: async () => ({ data: null, error: null }),
				create: async () => ({ data: null, error: { message: 'boom' } }),
				get: async () => ({ data: null, error: null }),
				promptAsync: async () => ({ data: null, error: null }),
			},
			tui: {},
		}

		const events: Array<{ type: string }> = []
		const spawner = new BackgroundSpawner(
			v2 as unknown as ConstructorParameters<typeof BackgroundSpawner>[0],
			bgMgr,
			cm,
			'/tmp',
			{ log: () => {} },
			{
				pollIntervalMs: 1_000_000,
				idleTimeoutMs: 1_000_000,
				onTaskEvent: ({ type }) => events.push({ type }),
			},
		)

		await spawner.spawn({
			id: 'err-task',
			parentAgent: 'forge',
			targetAgent: 'librarian',
			prompt: 'noop',
			model: 'm1',
		})

		expect(events).toEqual([{ type: 'error' }])

		await spawner.shutdown()
		db.close()
	})
})

// ────────────────────────────────────────────────────────────
// Agent registry
// ────────────────────────────────────────────────────────────

describe('Agent registry', () => {
	const EXPECTED_ROLES: AgentRole[] = [
		'forge',
		'muse',
		'sage',
		'librarian',
		'explore',
		'oracle',
		'prometheus',
		'metis',
	]

	test('all 8 agents are registered', () => {
		expect(Object.keys(agents)).toEqual(expect.arrayContaining(EXPECTED_ROLES))
		expect(Object.keys(agents).length).toBe(8)
	})

	test('toolSupported flags are correct', () => {
		const supportedRoles = ['librarian', 'explore', 'oracle', 'prometheus', 'metis']
		for (const role of supportedRoles) {
			expect(agents[role as AgentRole].toolSupported).toBe(true)
		}
		// primary agents are NOT tool-supported
		expect(agents.forge.toolSupported).toBeFalsy()
	})

	test('subagent roles have hidden flag', () => {
		const subagentRoles = ['librarian', 'explore', 'oracle', 'prometheus', 'metis']
		for (const role of subagentRoles) {
			expect(agents[role as AgentRole].hidden).toBe(true)
		}
	})
})

// ────────────────────────────────────────────────────────────
// Feature support
// ────────────────────────────────────────────────────────────

describe('Feature support — Stage 6', () => {
	test('background descriptor is implemented', () => {
		const descriptors = getCapabilityDescriptors()
		const bg = descriptors.find(d => d.id === 'background')
		expect(bg).toBeDefined()
		expect(bg!.status).toBe('implemented')
	})

	test('background.enabled no longer produces config issue', () => {
		const config: PluginConfig = {
			background: {
				enabled: true,
				maxConcurrent: 5,
				perModelLimit: 2,
				pollIntervalMs: 3000,
				idleTimeoutMs: 10000,
			},
		} as unknown as PluginConfig
		const issues = collectUnsupportedConfigIssues(config)
		const bgIssue = issues.find(i => i.id === 'background')
		expect(bgIssue).toBeUndefined()
	})
})
