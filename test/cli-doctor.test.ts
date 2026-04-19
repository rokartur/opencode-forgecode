import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const TEST_DIR = '/tmp/opencode-forge-doctor-' + Date.now()

describe('CLI doctor', () => {
	let testConfigDir: string
	let testDataDir: string
	let originalLog: typeof console.log
	let outputLines: string[]

	beforeEach(() => {
		testConfigDir = TEST_DIR + '-config-' + Math.random().toString(36).slice(2)
		testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
		mkdirSync(testConfigDir, { recursive: true })
		mkdirSync(testDataDir, { recursive: true })
		process.env['XDG_CONFIG_HOME'] = testConfigDir
		process.env['XDG_DATA_HOME'] = testDataDir
		originalLog = console.log
		outputLines = []
		console.log = (msg?: unknown) => outputLines.push(String(msg ?? ''))
	})

	afterEach(() => {
		console.log = originalLog
		delete process.env['XDG_CONFIG_HOME']
		delete process.env['XDG_DATA_HOME']
		if (existsSync(testConfigDir)) {
			rmSync(testConfigDir, { recursive: true, force: true })
		}
		if (existsSync(testDataDir)) {
			rmSync(testDataDir, { recursive: true, force: true })
		}
	})

	test('returns OK for default config', async () => {
		const { run } = await import('../src/cli/commands/doctor')
		const code = await run()

		expect(code).toBe(0)
		expect(outputLines.join('\n')).toContain('Doctor result: OK')
	})

	test('returns OK when all previously config-only features are implemented', async () => {
		const configPath = join(testConfigDir, 'opencode', 'forge-config.jsonc')
		mkdirSync(join(testConfigDir, 'opencode'), { recursive: true })
		writeFileSync(
			configPath,
			JSON.stringify({
				background: { enabled: true },
				telemetry: { enabled: true },
				sandbox: { mode: 'auto' },
				agents: {
					forge: {
						budget: { maxTurns: 1 },
					},
				},
			}),
		)

		const { run } = await import('../src/cli/commands/doctor')
		const code = await run()

		// All features are now implemented — no config issues
		expect(code).toBe(0)
		const output = outputLines.join('\n')
		expect(output).not.toContain('[FAIL] Background runtime')
		expect(output).not.toContain('[FAIL] Telemetry')
		expect(output).not.toContain('[FAIL] Additional sandbox modes')
		expect(output).not.toContain('[FAIL] Agent budget')
		expect(output).toContain('Doctor result: OK')
	})
})
