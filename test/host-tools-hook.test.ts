import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
	createHostToolBeforeHook,
	createHostToolAfterHook,
	__clearHostToolPendingForTests,
} from '../src/hooks/host-tools'
import { isRipgrepAvailable } from '../src/tools/host-fs'

const noopLogger = { log: (_: string) => {}, error: (_: string) => {} }

function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'host-hook-'))
	mkdirSync(join(root, 'src'), { recursive: true })
	writeFileSync(join(root, 'src/a.ts'), `export const fooBar = 1\n`)
	writeFileSync(join(root, 'src/b.ts'), `import { fooBar } from './a'\n`)
	return root
}

function mkDeps(cwd: string, opts: { enabled?: boolean; sandboxActive?: boolean } = {}) {
	return {
		cwd,
		enabled: opts.enabled,
		logger: noopLogger,
		sandboxManager: opts.sandboxActive
			? ({
					docker: {} as never,
					getActive: () => ({ containerName: 'c', projectDir: cwd }),
				} as never)
			: null,
		loopService: {
			resolveLoopName: () => (opts.sandboxActive ? 'loop-x' : null),
			getActiveState: () => (opts.sandboxActive ? { active: true, sandbox: true } : null),
		} as never,
	}
}

describe('host-tools hook', () => {
	beforeEach(() => {
		__clearHostToolPendingForTests()
	})

	if (!isRipgrepAvailable()) {
		test.skip('rg not installed — skipping', () => {})
		return
	}

	test('intercepts grep and swaps output', async () => {
		const cwd = makeRepo()
		try {
			const deps = mkDeps(cwd)
			const before = createHostToolBeforeHook(deps)
			const after = createHostToolAfterHook(deps)

			const output: { args: Record<string, unknown> } = { args: { pattern: 'fooBar' } }
			await before!({ tool: 'grep', sessionID: 's1', callID: 'call-1' }, output as never)
			// Builtin pattern was neutralised.
			expect(output.args.pattern).toBe('__forge_host_fs_noop__')

			const toolOutput: { title: string; output: string; metadata: unknown } = {
				title: '',
				output: 'BUILTIN_OUTPUT_SHOULD_BE_REPLACED',
				metadata: {},
			}
			await after!({ tool: 'grep', sessionID: 's1', callID: 'call-1', args: output.args }, toolOutput as never)
			expect(toolOutput.output).toContain('src/a.ts')
			expect(toolOutput.output).toContain('src/b.ts')
			expect(toolOutput.output).not.toContain('BUILTIN_OUTPUT_SHOULD_BE_REPLACED')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('intercepts glob', async () => {
		const cwd = makeRepo()
		try {
			const deps = mkDeps(cwd)
			const before = createHostToolBeforeHook(deps)
			const after = createHostToolAfterHook(deps)

			const output: { args: Record<string, unknown> } = { args: { pattern: '**/*.ts' } }
			await before!({ tool: 'glob', sessionID: 's2', callID: 'call-2' }, output as never)
			expect(output.args.pattern).toBe('__forge_host_fs_noop__')

			const toolOutput = { title: '', output: 'BUILTIN', metadata: {} }
			await after!({ tool: 'glob', sessionID: 's2', callID: 'call-2', args: output.args }, toolOutput as never)
			expect(toolOutput.output).toContain('src/a.ts')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('does nothing when disabled by flag', async () => {
		const cwd = makeRepo()
		try {
			const deps = mkDeps(cwd, { enabled: false })
			const before = createHostToolBeforeHook(deps)
			const after = createHostToolAfterHook(deps)

			const output = { args: { pattern: 'fooBar' } }
			await before!({ tool: 'grep', sessionID: 's3', callID: 'call-3' }, output as never)
			expect(output.args.pattern).toBe('fooBar')

			const toolOutput = { title: '', output: 'BUILTIN', metadata: {} }
			await after!({ tool: 'grep', sessionID: 's3', callID: 'call-3', args: output.args }, toolOutput as never)
			expect(toolOutput.output).toBe('BUILTIN')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('defers to sandbox hook when a sandbox is active', async () => {
		const cwd = makeRepo()
		try {
			const deps = mkDeps(cwd, { sandboxActive: true })
			const before = createHostToolBeforeHook(deps)

			const output = { args: { pattern: 'fooBar' } }
			await before!({ tool: 'grep', sessionID: 's4', callID: 'call-4' }, output as never)
			// Args untouched — sandbox interceptor will handle this call.
			expect(output.args.pattern).toBe('fooBar')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('ignores unrelated tools', async () => {
		const cwd = makeRepo()
		try {
			const deps = mkDeps(cwd)
			const before = createHostToolBeforeHook(deps)
			const output = { args: { command: 'echo hi' } }
			await before!({ tool: 'bash', sessionID: 's5', callID: 'call-5' }, output as never)
			expect(output.args.command).toBe('echo hi')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})
})
