/**
 * Tests for delta-read hook — verifies diff-on-reread, unchanged detection,
 * and large-diff fallback.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDeltaReadBeforeHook, createDeltaReadAfterHook, __resetDeltaReadForTests } from '../src/hooks/delta-read'

const noop = (..._args: unknown[]) => {}
const logger = { log: noop, debug: noop, error: noop } as any

function tmpDir() {
	return mkdtempSync(join(tmpdir(), 'delta-read-'))
}

afterEach(() => {
	__resetDeltaReadForTests()
})

describe('Delta-read hook', () => {
	test('first read passes through and caches content', async () => {
		const dir = tmpDir()
		const file = join(dir, 'test.ts')
		writeFileSync(file, 'const x = 1\n')

		const before = createDeltaReadBeforeHook({ logger, cwd: dir, config: { enabled: true } })
		const after = createDeltaReadAfterHook({ logger, cwd: dir, config: { enabled: true } })

		// First read — before hook should not intercept
		const input = { tool: 'read', sessionID: 'sess1', callID: 'c1' }
		const output = { args: { filePath: file } }
		await before(input, output)
		expect(output.args.filePath).toBe(file) // not modified

		// Simulate tool execution — after hook caches
		const afterInput = { tool: 'read', sessionID: 'sess1', callID: 'c1', args: { filePath: file } }
		const afterOutput = { title: '', output: 'const x = 1\n', metadata: null }
		await after(afterInput, afterOutput)
		expect(afterOutput.output).toBe('const x = 1\n') // not modified

		rmSync(dir, { recursive: true })
	})

	test('second read of unchanged file returns "File unchanged" message', async () => {
		const dir = tmpDir()
		const file = join(dir, 'test.ts')
		writeFileSync(file, 'const x = 1\n')

		const before = createDeltaReadBeforeHook({ logger, cwd: dir, config: { enabled: true } })
		const after = createDeltaReadAfterHook({ logger, cwd: dir, config: { enabled: true } })

		// First read
		const input1 = { tool: 'read', sessionID: 'sess1', callID: 'c1' }
		const output1 = { args: { filePath: file } }
		await before(input1, output1)
		await after(
			{ tool: 'read', sessionID: 'sess1', callID: 'c1', args: { filePath: file } },
			{ title: '', output: 'const x = 1\n', metadata: null },
		)

		// Second read — should intercept and return "unchanged"
		const input2 = { tool: 'read', sessionID: 'sess1', callID: 'c2' }
		const output2 = { args: { filePath: file } }
		await before(input2, output2)
		expect(output2.args.filePath).toBe('__forge_delta_noop__')

		// After hook should serve the pending result
		const afterOutput2 = { title: '', output: 'fallback', metadata: null }
		await after({ tool: 'read', sessionID: 'sess1', callID: 'c2', args: { filePath: file } }, afterOutput2)
		expect(afterOutput2.output).toContain('File unchanged')

		rmSync(dir, { recursive: true })
	})

	test('second read of changed file returns diff', async () => {
		const dir = tmpDir()
		const file = join(dir, 'test.ts')
		writeFileSync(file, 'const x = 1\nconst y = 2\n')

		const before = createDeltaReadBeforeHook({ logger, cwd: dir, config: { enabled: true } })
		const after = createDeltaReadAfterHook({ logger, cwd: dir, config: { enabled: true } })

		// First read
		await before({ tool: 'read', sessionID: 'sess1', callID: 'c1' }, { args: { filePath: file } })
		await after(
			{ tool: 'read', sessionID: 'sess1', callID: 'c1', args: { filePath: file } },
			{ title: '', output: 'const x = 1\nconst y = 2\n', metadata: null },
		)

		// Modify file
		// Sleep briefly to ensure mtime changes (filesystem resolution is ~1ms on most OS)
		await new Promise(r => setTimeout(r, 50))
		writeFileSync(file, 'const x = 1\nconst y = 3\n')

		// Second read — should produce a diff
		const output2 = { args: { filePath: file } }
		await before({ tool: 'read', sessionID: 'sess1', callID: 'c2' }, output2)
		expect(output2.args.filePath).toBe('__forge_delta_noop__')

		const afterOutput2 = { title: '', output: 'fallback', metadata: null }
		await after({ tool: 'read', sessionID: 'sess1', callID: 'c2', args: { filePath: file } }, afterOutput2)
		expect(afterOutput2.output).toContain('Delta')
		expect(afterOutput2.output).toContain('-const y = 2')
		expect(afterOutput2.output).toContain('+const y = 3')

		rmSync(dir, { recursive: true })
	})

	test('non-read tools are ignored', async () => {
		const dir = tmpDir()
		const before = createDeltaReadBeforeHook({ logger, cwd: dir, config: { enabled: true } })

		const output = { args: { pattern: 'foo' } }
		await before({ tool: 'grep', sessionID: 's', callID: 'c' }, output)
		expect(output.args.pattern).toBe('foo')
	})

	test('disabled config disables hook', async () => {
		const dir = tmpDir()
		const file = join(dir, 'test.ts')
		writeFileSync(file, 'content\n')

		const before = createDeltaReadBeforeHook({ logger, cwd: dir, config: { enabled: false } })
		const after = createDeltaReadAfterHook({ logger, cwd: dir, config: { enabled: false } })

		// First read
		await before({ tool: 'read', sessionID: 's', callID: 'c1' }, { args: { filePath: file } })
		await after(
			{ tool: 'read', sessionID: 's', callID: 'c1', args: { filePath: file } },
			{ title: '', output: 'content\n', metadata: null },
		)

		// Second read — should NOT intercept because disabled
		const out = { args: { filePath: file } }
		await before({ tool: 'read', sessionID: 's', callID: 'c2' }, out)
		expect(out.args.filePath).toBe(file)

		rmSync(dir, { recursive: true })
	})

	test('.env files are excluded from caching', async () => {
		const dir = tmpDir()
		const file = join(dir, '.env.local')
		writeFileSync(file, 'SECRET=123\n')

		const before = createDeltaReadBeforeHook({ logger, cwd: dir, config: { enabled: true } })
		const after = createDeltaReadAfterHook({ logger, cwd: dir, config: { enabled: true } })

		// First read
		await before({ tool: 'read', sessionID: 's', callID: 'c1' }, { args: { filePath: file } })
		await after(
			{ tool: 'read', sessionID: 's', callID: 'c1', args: { filePath: file } },
			{ title: '', output: 'SECRET=123\n', metadata: null },
		)

		// Second read — should NOT intercept because .env* excluded
		const out = { args: { filePath: file } }
		await before({ tool: 'read', sessionID: 's', callID: 'c2' }, out)
		expect(out.args.filePath).toBe(file)

		rmSync(dir, { recursive: true })
	})
})
