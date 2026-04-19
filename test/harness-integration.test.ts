import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHarnessHooks, type HarnessHooks } from '../src/hooks/harness'
import type { Logger } from '../src/types'

/**
 * Integration tests for the harness hook factory. Exercise the full lifecycle
 * a plugin sees: tool.execute.before snapshots + doom-loop, tool.execute.after
 * truncation, event handling (todo updates + idle reminders), compact hook.
 */

const makeLogger = (): Logger & { logs: string[]; debugs: string[] } => {
	const logs: string[] = []
	const debugs: string[] = []
	return {
		log: (m: unknown) => logs.push(String(m)),
		debug: (m: unknown) => debugs.push(String(m)),
		error: (m: unknown) => logs.push(`ERR ${String(m)}`),
		warn: (m: unknown) => logs.push(`WARN ${String(m)}`),
		logs,
		debugs,
	}
}

describe('createHarnessHooks — snapshot capture', () => {
	let workDir: string
	let dataDir: string
	let hooks: HarnessHooks
	let appended: Array<{ sessionId: string; text: string }>
	let logger: ReturnType<typeof makeLogger>

	beforeEach(async () => {
		workDir = await mkdtemp(join(tmpdir(), 'harness-work-'))
		dataDir = await mkdtemp(join(tmpdir(), 'harness-data-'))
		appended = []
		logger = makeLogger()
		hooks = createHarnessHooks({
			logger,
			projectId: 'test-project',
			directory: workDir,
			dataDir,
			appendPrompt: (sessionId, text) => {
				appended.push({ sessionId, text })
			},
		})
	})

	afterEach(async () => {
		await rm(workDir, { recursive: true, force: true })
		await rm(dataDir, { recursive: true, force: true })
	})

	test('captures snapshot for edit on existing file', async () => {
		const file = join(workDir, 'target.txt')
		await writeFile(file, 'original content')

		await hooks.toolBefore({ sessionID: 'sess-1', tool: 'edit', args: { filePath: 'target.txt' } })

		const snapRoot = join(dataDir, 'snapshots', 'sess-1')
		const entries = await readdir(snapRoot)
		expect(entries.length).toBe(1)
		expect(entries[0]).toMatch(/\.bak$/)
		const stored = await readFile(join(snapRoot, entries[0]), 'utf8')
		expect(stored).toBe('original content')
	})

	test('captures snapshot for write, multi_patch, and patch', async () => {
		await writeFile(join(workDir, 'a.txt'), 'A')
		await writeFile(join(workDir, 'b.txt'), 'B')
		await writeFile(join(workDir, 'c.txt'), 'C')

		await hooks.toolBefore({ sessionID: 's', tool: 'write', args: { filePath: 'a.txt' } })
		await hooks.toolBefore({ sessionID: 's', tool: 'multi_patch', args: { file: 'b.txt' } })
		await hooks.toolBefore({ sessionID: 's', tool: 'patch', args: { file: 'c.txt' } })

		const entries = await readdir(join(dataDir, 'snapshots', 's'))
		expect(entries.length).toBe(3)
	})

	test('does not snapshot for non-mutating tools', async () => {
		await writeFile(join(workDir, 'x.txt'), 'x')
		await hooks.toolBefore({ sessionID: 's', tool: 'bash', args: { command: 'ls' } })
		await hooks.toolBefore({ sessionID: 's', tool: 'read', args: { filePath: 'x.txt' } })
		try {
			const entries = await readdir(join(dataDir, 'snapshots', 's'))
			expect(entries.length).toBe(0)
		} catch {
			// directory not created — equally fine
		}
	})

	test('no snapshot for nonexistent target file', async () => {
		await hooks.toolBefore({ sessionID: 's', tool: 'write', args: { filePath: 'new.txt' } })
		try {
			const entries = await readdir(join(dataDir, 'snapshots', 's'))
			expect(entries.length).toBe(0)
		} catch {
			// ok — nothing captured
		}
	})
})

describe('createHarnessHooks — doom-loop', () => {
	let hooks: HarnessHooks
	let appended: Array<{ sessionId: string; text: string }>

	beforeEach(async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'harness-'))
		const dataDir = await mkdtemp(join(tmpdir(), 'harness-'))
		appended = []
		hooks = createHarnessHooks({
			logger: makeLogger(),
			projectId: 'p',
			directory: workDir,
			dataDir,
			config: { enabled: true, doomLoopThreshold: 3 },
			appendPrompt: (sessionId, text) => {
				appended.push({ sessionId, text })
			},
		})
	})

	test('fires appendPrompt reminder after threshold repetitions', async () => {
		for (let i = 0; i < 3; i++) {
			await hooks.toolBefore({ sessionID: 'sd', tool: 'read', args: { p: '/a' } })
		}
		expect(appended.length).toBe(1)
		expect(appended[0].sessionId).toBe('sd')
		expect(appended[0].text.length).toBeGreaterThan(0)
	})

	test('does not re-warn same session', async () => {
		for (let i = 0; i < 10; i++) {
			await hooks.toolBefore({ sessionID: 'sd', tool: 'read', args: { p: '/a' } })
		}
		expect(appended.length).toBe(1)
	})

	test('non-repeating sequence does not warn', async () => {
		const tools = ['read', 'bash', 'grep', 'write']
		for (const tool of tools) {
			await hooks.toolBefore({ sessionID: 'sd', tool, args: { n: tool } })
		}
		expect(appended.length).toBe(0)
	})
})

describe('createHarnessHooks — truncation', () => {
	let hooks: HarnessHooks

	beforeEach(async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'harness-'))
		const dataDir = await mkdtemp(join(tmpdir(), 'harness-'))
		hooks = createHarnessHooks({
			logger: makeLogger(),
			projectId: 'p',
			directory: workDir,
			dataDir,
		})
	})

	test('truncates long bash output in place', async () => {
		const lines = Array.from({ length: 600 }, (_, i) => `line${i}`).join('\n')
		const output = { output: lines }
		await hooks.toolAfter({ sessionID: 's', tool: 'bash' }, output)
		expect(output.output).toContain('lines hidden')
		expect(output.output.length).toBeLessThan(lines.length)
	})

	test('leaves short output unchanged', async () => {
		const output = { output: 'tiny' }
		await hooks.toolAfter({ sessionID: 's', tool: 'bash' }, output)
		expect(output.output).toBe('tiny')
	})

	test('leaves unknown tools unchanged', async () => {
		const output = { output: 'x'.repeat(100000) }
		const copy = output.output
		await hooks.toolAfter({ sessionID: 's', tool: 'custom_tool' }, output)
		expect(output.output).toBe(copy)
	})

	test('disabled config bypasses truncation', async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'harness-'))
		const dataDir = await mkdtemp(join(tmpdir(), 'harness-'))
		const h = createHarnessHooks({
			logger: makeLogger(),
			projectId: 'p',
			directory: workDir,
			dataDir,
			config: { enabled: true, truncation: { enabled: false } },
		})
		const lines = Array.from({ length: 600 }, (_, i) => `l${i}`).join('\n')
		const output = { output: lines }
		await h.toolAfter({ sessionID: 's', tool: 'bash' }, output)
		expect(output.output).toBe(lines)
	})
})

describe('createHarnessHooks — events', () => {
	let hooks: HarnessHooks
	let appended: Array<{ sessionId: string; text: string }>

	beforeEach(async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'harness-'))
		const dataDir = await mkdtemp(join(tmpdir(), 'harness-'))
		appended = []
		hooks = createHarnessHooks({
			logger: makeLogger(),
			projectId: 'p',
			directory: workDir,
			dataDir,
			appendPrompt: (sessionId, text) => {
				appended.push({ sessionId, text })
			},
		})
	})

	test('records todo snapshot from todo.updated event', async () => {
		await hooks.onEvent({
			event: {
				type: 'todo.updated',
				properties: {
					sessionId: 's1',
					todos: [
						{ status: 'pending', content: 'A' },
						{ status: 'completed', content: 'B' },
					],
				},
			},
		})
		// No reminder on the update itself, only on idle
		expect(appended.length).toBe(0)
	})

	test('emits pending-todos reminder on session.idle', async () => {
		await hooks.onEvent({
			event: {
				type: 'todo.updated',
				properties: {
					sessionId: 's1',
					todos: [{ status: 'pending', content: 'finish this' }],
				},
			},
		})
		await hooks.onEvent({
			event: { type: 'session.idle', properties: { sessionId: 's1' } },
		})
		expect(appended.length).toBe(1)
		expect(appended[0].sessionId).toBe('s1')
	})

	test('no reminder when all todos completed', async () => {
		await hooks.onEvent({
			event: {
				type: 'todo.updated',
				properties: {
					sessionId: 's1',
					todos: [{ status: 'completed', content: 'done' }],
				},
			},
		})
		await hooks.onEvent({
			event: { type: 'session.idle', properties: { sessionId: 's1' } },
		})
		expect(appended.length).toBe(0)
	})

	test('session.deleted clears tracker state', async () => {
		await hooks.onEvent({
			event: {
				type: 'todo.updated',
				properties: {
					sessionId: 's1',
					todos: [{ status: 'pending', content: 'A' }],
				},
			},
		})
		await hooks.onEvent({
			event: { type: 'session.deleted', properties: { sessionId: 's1' } },
		})
		await hooks.onEvent({
			event: { type: 'session.idle', properties: { sessionId: 's1' } },
		})
		expect(appended.length).toBe(0)
	})

	test('unknown event types are ignored', async () => {
		await hooks.onEvent({ event: { type: 'random.event', properties: {} } })
		expect(appended.length).toBe(0)
	})

	test('malformed todo entries are filtered out', async () => {
		await hooks.onEvent({
			event: {
				type: 'todo.updated',
				properties: {
					sessionId: 's1',
					todos: [
						{ status: 'pending', content: 'good' },
						null,
						{ content: 'missing status' },
						{ status: 'pending' },
					],
				},
			},
		})
		await hooks.onEvent({
			event: { type: 'session.idle', properties: { sessionId: 's1' } },
		})
		// Only the 'good' todo survives -> reminder fires
		expect(appended.length).toBe(1)
	})
})

describe('createHarnessHooks — disabled', () => {
	test('enabled=false short-circuits everything', async () => {
		const workDir = await mkdtemp(join(tmpdir(), 'harness-'))
		const dataDir = await mkdtemp(join(tmpdir(), 'harness-'))
		let appendCalls = 0
		const hooks = createHarnessHooks({
			logger: makeLogger(),
			projectId: 'p',
			directory: workDir,
			dataDir,
			config: { enabled: false },
			appendPrompt: () => {
				appendCalls++
			},
		})

		await writeFile(join(workDir, 'f.txt'), 'x')
		for (let i = 0; i < 10; i++) {
			await hooks.toolBefore({ sessionID: 's', tool: 'write', args: { filePath: 'f.txt' } })
		}
		const output = { output: 'l\n'.repeat(1000) }
		await hooks.toolAfter({ sessionID: 's', tool: 'bash' }, output)

		try {
			const entries = await readdir(join(dataDir, 'snapshots'))
			expect(entries.length).toBe(0)
		} catch {
			// not created
		}
		expect(appendCalls).toBe(0)
		// truncation skipped
		expect(output.output.split('\n').length).toBeGreaterThan(500)
	})
})
