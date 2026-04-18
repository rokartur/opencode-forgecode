import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createForgePlugin } from '../src/index'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { PluginConfig } from '../src/types'
import type { PluginInput } from '@opencode-ai/plugin'

const TEST_DIR = '/tmp/opencode-forge-softfail-' + Date.now()

describe('createForgePlugin soft-fail (DB init failure)', () => {
	let testDir: string
	let currentHooks: { getCleanup?: () => Promise<void> } | null

	beforeEach(() => {
		testDir = TEST_DIR + '-' + Math.random().toString(36).slice(2)
		mkdirSync(testDir, { recursive: true })
		currentHooks = null
	})

	afterEach(async () => {
		if (currentHooks?.getCleanup) {
			await currentHooks.getCleanup()
		}
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true, force: true })
		}
	})

	test('registers forge/muse/sage agents even when DB init fails', async () => {
		// Force DB init to fail: point dataDir at a path whose parent is a
		// regular file so mkdirSync(dataDir, { recursive: true }) throws
		// ENOTDIR. This exercises the soft-fail branch in createForgePlugin.
		const blocker = join(testDir, 'blocker')
		writeFileSync(blocker, 'not a directory')
		const badDataDir = join(blocker, 'data')

		const logs: Array<{ level: string; msg: string }> = []
		const origError = console.error
		console.error = (msg: unknown, ...rest: unknown[]) => {
			logs.push({ level: 'error', msg: String(msg) })
			origError(msg, ...rest)
		}

		const config: PluginConfig = {
			dataDir: badDataDir,
			graph: { enabled: false },
			logging: { enabled: false },
		}

		const mockInput: PluginInput = {
			directory: testDir,
			worktree: testDir,
			client: {} as never,
			project: { id: 'test-project' } as never,
			serverUrl: new URL('http://localhost:5551'),
			$: {} as never,
		}

		const plugin = createForgePlugin(config)
		let hooks: Awaited<ReturnType<typeof plugin>>
		try {
			hooks = await plugin(mockInput)
		} finally {
			console.error = origError
		}
		currentHooks = hooks as { getCleanup?: () => Promise<void> }

		// Config hook must register forge/muse/sage regardless of DB state.
		const opencodeConfig: Record<string, unknown> = {}
		expect(hooks.config).toBeTypeOf('function')
		await hooks.config!(opencodeConfig as any)

		const agent = opencodeConfig.agent as Record<string, unknown>
		expect(agent).toBeDefined()
		expect(agent.forge).toBeDefined()
		expect(agent.muse).toBeDefined()
		expect(agent.sage).toBeDefined()
		expect(opencodeConfig.default_agent).toBe('forge')
	})

	test('cleanup does not throw when db is null (degraded mode)', async () => {
		const blocker = join(testDir, 'blocker2')
		writeFileSync(blocker, 'not a directory')
		const badDataDir = join(blocker, 'data')

		const config: PluginConfig = {
			dataDir: badDataDir,
			graph: { enabled: false },
			logging: { enabled: false },
		}

		const mockInput: PluginInput = {
			directory: testDir,
			worktree: testDir,
			client: {} as never,
			project: { id: 'test-project-2' } as never,
			serverUrl: new URL('http://localhost:5551'),
			$: {} as never,
		}

		const plugin = createForgePlugin(config)
		const hooks = (await plugin(mockInput)) as { getCleanup?: () => Promise<void> }

		expect(hooks.getCleanup).toBeTypeOf('function')
		await expect(hooks.getCleanup!()).resolves.toBeUndefined()
	})
})
