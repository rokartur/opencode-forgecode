import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createForgePlugin } from '../src/index'
import type { PluginConfig } from '../src/types'
import type { PluginInput } from '@opencode-ai/plugin'

const TEST_DIR = '/tmp/opencode-forge-capability-warning-' + Date.now()

describe('createForgePlugin capability warnings', () => {
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

	test('logs startup warnings when unsupported config-only features are enabled', async () => {
		const logPath = join(testDir, 'logs', 'forge.log')
		const config: PluginConfig = {
			dataDir: join(testDir, 'data'),
			graph: { enabled: false },
			logging: {
				enabled: true,
				debug: false,
				file: logPath,
			},
			background: { enabled: true },
			telemetry: { enabled: true },
			sandbox: { mode: 'auto' },
			agents: {
				forge: {
					fallback_models: ['openai/gpt-5.4-mini'],
					budget: { maxTurns: 2 },
					user_prompt: 'extra prompt',
				},
			},
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
		currentHooks = (await plugin(mockInput)) as { getCleanup?: () => Promise<void> }

		const log = readFileSync(logPath, 'utf8')
		expect(log).not.toContain('[warning] Background runtime') // background is now implemented
		expect(log).not.toContain('[warning] Telemetry') // telemetry is now implemented
		expect(log).not.toContain('[warning] Additional sandbox modes') // sandbox-extra-modes is now implemented
		expect(log).not.toContain('[warning] Agent budget') // agent budgets are now implemented
		expect(log).not.toContain('[warning] Agent user prompt') // user prompt templating is now implemented
	})
})
