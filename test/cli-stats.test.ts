import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TEST_DIR = join(tmpdir(), 'opencode-forge-stats-' + Date.now())

describe('CLI stats', () => {
	let testConfigDir: string
	let testDataDir: string
	let originalLog: typeof console.log
	let originalErr: typeof console.error
	let outputLines: string[]

	beforeEach(() => {
		testConfigDir = TEST_DIR + '-config-' + Math.random().toString(36).slice(2)
		testDataDir = TEST_DIR + '-data-' + Math.random().toString(36).slice(2)
		mkdirSync(testConfigDir, { recursive: true })
		mkdirSync(testDataDir, { recursive: true })
		process.env['XDG_CONFIG_HOME'] = testConfigDir
		process.env['XDG_DATA_HOME'] = testDataDir
		originalLog = console.log
		originalErr = console.error
		outputLines = []
		console.log = (msg?: unknown) => outputLines.push(String(msg ?? ''))
		console.error = (msg?: unknown) => outputLines.push(String(msg ?? ''))
	})

	afterEach(() => {
		console.log = originalLog
		console.error = originalErr
		delete process.env['XDG_CONFIG_HOME']
		delete process.env['XDG_DATA_HOME']
		if (existsSync(testConfigDir)) rmSync(testConfigDir, { recursive: true, force: true })
		if (existsSync(testDataDir)) rmSync(testDataDir, { recursive: true, force: true })
	})

	test('reports no-data state when telemetry table is absent', async () => {
		const { run } = await import('../src/cli/commands/stats')
		const code = await run([], { dir: testDataDir })
		expect(code).toBe(0)
		const out = outputLines.join('\n')
		expect(out).toContain('No telemetry data found')
	})

	test('--json emits valid JSON document', async () => {
		const { run } = await import('../src/cli/commands/stats')
		const code = await run(['--json'], { dir: testDataDir })
		expect(code).toBe(0)
		const parsed = JSON.parse(outputLines.join('\n'))
		expect(parsed).toHaveProperty('total')
		expect(parsed).toHaveProperty('window')
	})

	test('parses --days, --week, --month, --all without crash', async () => {
		const { run } = await import('../src/cli/commands/stats')
		for (const flag of ['--days=3', '--today', '--week', '--month', '--all']) {
			outputLines = []
			const code = await run([flag], { dir: testDataDir })
			expect(code).toBe(0)
		}
	})
})
