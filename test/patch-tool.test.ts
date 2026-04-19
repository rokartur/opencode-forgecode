import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPatchTools } from '../src/tools/patch'
import { hashLine } from '../src/utils/line-hash'
import { createHarnessHooks } from '../src/hooks/harness'

describe('patch tool', () => {
	let workDir: string

	beforeEach(() => {
		workDir = mkdtempSync(join(tmpdir(), 'patch-tool-'))
	})

	afterEach(() => {
		rmSync(workDir, { recursive: true, force: true })
	})

	function createTools() {
		return createPatchTools({
			projectId: 'test-project',
			directory: workDir,
			config: {},
			logger: console as any,
			db: null,
			dataDir: join(workDir, '.data'),
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
			graphService: null,
		})
	}

	function createToolsWithConfig(config: Record<string, unknown>) {
		return createPatchTools({
			projectId: 'test-project',
			directory: workDir,
			config: config as any,
			logger: console as any,
			db: null,
			dataDir: join(workDir, '.data'),
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
			graphService: null,
		})
	}

	test('applies single-line anchored patch', async () => {
		writeFileSync(join(workDir, 'sample.txt'), 'alpha\nbeta\n', 'utf8')
		const tools = createTools()

		const result = await tools.patch.execute(
			{
				file: 'sample.txt',
				patches: [{ anchor: `2#${hashLine('beta')}`, newContent: 'gamma' }],
			} as any,
			{} as any,
		)

		expect(result).toContain('OK')
		expect(readFileSync(join(workDir, 'sample.txt'), 'utf8')).toBe('alpha\ngamma\n')
	})

	test('fails atomically on hash mismatch', async () => {
		writeFileSync(join(workDir, 'sample.txt'), 'alpha\nbeta\n', 'utf8')
		const tools = createTools()

		const result = await tools.patch.execute(
			{
				file: 'sample.txt',
				patches: [{ anchor: '2#deadbeef', newContent: 'gamma' }],
			} as any,
			{} as any,
		)

		expect(result).toContain('hash mismatch')
		expect(readFileSync(join(workDir, 'sample.txt'), 'utf8')).toBe('alpha\nbeta\n')
	})

	test('applies multi-line range replacement', async () => {
		writeFileSync(join(workDir, 'sample.txt'), 'one\ntwo\nthree\nfour', 'utf8')
		const tools = createTools()

		const result = await tools.patch.execute(
			{
				file: 'sample.txt',
				patches: [
					{
						anchorStart: `2#${hashLine('two')}`,
						anchorEnd: `3#${hashLine('three')}`,
						newContent: 'second\nthird',
					},
				],
			} as any,
			{} as any,
		)

		expect(result).toContain('lines 2-3')
		expect(readFileSync(join(workDir, 'sample.txt'), 'utf8')).toBe('one\nsecond\nthird\nfour')
	})

	test('errors when only one range anchor is provided', async () => {
		writeFileSync(join(workDir, 'sample.txt'), 'one\ntwo\n', 'utf8')
		const tools = createTools()

		const result = await tools.patch.execute(
			{
				file: 'sample.txt',
				patches: [{ anchorStart: `1#${hashLine('one')}`, newContent: 'ONE' }],
			} as any,
			{} as any,
		)

		expect(result).toContain('anchorStart and anchorEnd must both be provided')
		expect(readFileSync(join(workDir, 'sample.txt'), 'utf8')).toBe('one\ntwo\n')
	})

	test('errors when file does not exist', async () => {
		const tools = createTools()

		const result = await tools.patch.execute(
			{
				file: 'missing.txt',
				patches: [{ anchor: `1#${hashLine('x')}`, newContent: 'y' }],
			} as any,
			{} as any,
		)

		expect(result).toContain('cannot read')
	})

	test('does not register patch tool when disabled by config', () => {
		const tools = createToolsWithConfig({ harness: { hashAnchoredPatch: false } })
		expect(tools.patch).toBeUndefined()
	})

	test('patch tool works with harness snapshots end-to-end', async () => {
		writeFileSync(join(workDir, 'sample.txt'), 'alpha\nbeta\n', 'utf8')

		const hooks = createHarnessHooks({
			logger: console as any,
			projectId: 'test-project',
			directory: workDir,
			dataDir: join(workDir, '.data'),
		})

		const tools = createTools()
		await hooks.toolBefore({
			sessionID: 'session-1',
			tool: 'patch',
			args: { file: 'sample.txt' },
		})

		const result = await tools.patch.execute(
			{
				file: 'sample.txt',
				patches: [{ anchor: `2#${hashLine('beta')}`, newContent: 'gamma' }],
			} as any,
			{} as any,
		)

		expect(result).toContain('OK')
		expect(readFileSync(join(workDir, 'sample.txt'), 'utf8')).toBe('alpha\ngamma\n')

		const snapshotDir = join(workDir, '.data', 'snapshots', 'session-1')
		const entries = readdirSync(snapshotDir)
		expect(entries.length).toBe(1)
		expect(readFileSync(join(snapshotDir, entries[0]), 'utf8')).toBe('alpha\nbeta\n')
	})
})
