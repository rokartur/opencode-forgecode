import { describe, test, expect } from 'bun:test'
import { PendingTodosTracker } from '../src/harness/pending-todos'
import type { ForgePendingTodo } from '../src/harness/types'

const todo = (status: ForgePendingTodo['status'], content: string): ForgePendingTodo => ({
	status,
	content,
})

describe('PendingTodosTracker', () => {
	test('no reminder with empty list', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [])
		expect(await t.buildReminder('s1')).toBeNull()
	})

	test('no reminder when only completed todos', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('completed', 'done task')])
		expect(await t.buildReminder('s1')).toBeNull()
	})

	test('renders reminder when pending todos present', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('pending', 'do the thing')])
		const msg = await t.buildReminder('s1')
		expect(msg).not.toBeNull()
		expect(typeof msg).toBe('string')
		expect(msg!.length).toBeGreaterThan(0)
	})

	test('renders reminder when in_progress todos present', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('in_progress', 'actively working')])
		const msg = await t.buildReminder('s1')
		expect(msg).not.toBeNull()
	})

	test('deduplicates consecutive identical todo sets', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('pending', 'A'), todo('pending', 'B')])
		expect(await t.buildReminder('s1')).not.toBeNull()
		// Second call same set -> null
		expect(await t.buildReminder('s1')).toBeNull()
	})

	test('new pending item bypasses dedup', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('pending', 'A')])
		expect(await t.buildReminder('s1')).not.toBeNull()
		t.update('s1', [todo('pending', 'A'), todo('pending', 'B')])
		expect(await t.buildReminder('s1')).not.toBeNull()
	})

	test('status change bypasses dedup', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('pending', 'A')])
		expect(await t.buildReminder('s1')).not.toBeNull()
		t.update('s1', [todo('in_progress', 'A')])
		expect(await t.buildReminder('s1')).not.toBeNull()
	})

	test('reset clears state and dedup key', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('pending', 'A')])
		expect(await t.buildReminder('s1')).not.toBeNull()
		expect(await t.buildReminder('s1')).toBeNull()
		t.reset('s1')
		t.update('s1', [todo('pending', 'A')])
		expect(await t.buildReminder('s1')).not.toBeNull()
	})

	test('sessions are isolated', async () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('pending', 'A')])
		t.update('s2', [todo('pending', 'B')])
		expect(await t.buildReminder('s1')).not.toBeNull()
		expect(await t.buildReminder('s2')).not.toBeNull()
		expect(t.pending('s1')).toHaveLength(1)
		expect(t.pending('s2')).toHaveLength(1)
	})

	test('pending() filters out completed todos', () => {
		const t = new PendingTodosTracker()
		t.update('s1', [todo('completed', 'done'), todo('pending', 'still to do'), todo('in_progress', 'working')])
		const p = t.pending('s1')
		expect(p).toHaveLength(2)
		expect(p.every(x => x.status !== 'completed')).toBe(true)
	})
})
