import { describe, it, expect } from 'bun:test'
import {
	resolveRtkConfig,
	RTK_INSTRUCTION_BLOCK,
	buildRtkInstructionBlock,
	isRtkInstalled,
	ensureRtkInstalled,
	resolveRtkPath,
	invalidateRtkPathCache,
} from '../src/runtime/rtk'
import { createRtkGuidanceHooks } from '../src/hooks/rtk-guidance'
import type { Logger } from '../src/types'

function makeLogger(): { logger: Logger; entries: string[] } {
	const entries: string[] = []
	const logger: Logger = {
		log: (m: string) => entries.push(`log:${m}`),
		error: (m: string) => entries.push(`error:${m}`),
		debug: (m: string) => entries.push(`debug:${m}`),
	}
	return { logger, entries }
}

describe('resolveRtkConfig', () => {
	it('applies defaults when config is undefined', () => {
		const r = resolveRtkConfig()
		expect(r.enabled).toBe(true)
		expect(r.autoInstall).toBe(true)
		expect(r.installUrl).toContain('rtk-ai/rtk')
		expect(r.installUrl).toContain('install.sh')
	})

	it('respects explicit overrides', () => {
		const r = resolveRtkConfig({ enabled: false, autoInstall: false, installUrl: 'https://example.com/x.sh' })
		expect(r.enabled).toBe(false)
		expect(r.autoInstall).toBe(false)
		expect(r.installUrl).toBe('https://example.com/x.sh')
	})
})

describe('RTK_INSTRUCTION_BLOCK', () => {
	it('is wrapped in system-reminder tags so the model treats it as a directive', () => {
		expect(RTK_INSTRUCTION_BLOCK).toContain('<system-reminder>')
		expect(RTK_INSTRUCTION_BLOCK).toContain('</system-reminder>')
		expect(RTK_INSTRUCTION_BLOCK).toContain("NOT part of the user's project")
	})

	it('contains the core rule and meta commands', () => {
		expect(RTK_INSTRUCTION_BLOCK).toContain('Always prefix shell commands with `rtk`')
		expect(RTK_INSTRUCTION_BLOCK).toContain('rtk gain')
		expect(RTK_INSTRUCTION_BLOCK).toContain('rtk proxy <cmd>')
	})
})

describe('resolveRtkPath', () => {
	it('returns a path string when rtk is installed', () => {
		if (!isRtkInstalled()) return
		const p = resolveRtkPath()
		expect(p).not.toBeNull()
		expect(typeof p).toBe('string')
		expect(p!.endsWith('rtk')).toBe(true)
	})
})

describe('buildRtkInstructionBlock', () => {
	it('is wrapped in system-reminder tags', () => {
		const block = buildRtkInstructionBlock()
		expect(block).toContain('<system-reminder>')
		expect(block).toContain('</system-reminder>')
	})

	it('contains the core RTK instruction content', () => {
		const block = buildRtkInstructionBlock()
		expect(block).toContain('rtk gain')
		expect(block).toContain('rtk proxy <cmd>')
		expect(block).toContain("NOT part of the user's project")
	})
})

describe('invalidateRtkPathCache', () => {
	it('can be called without throwing', () => {
		expect(() => invalidateRtkPathCache()).not.toThrow()
	})
})

describe('ensureRtkInstalled', () => {
	it('skips immediately when disabled', async () => {
		const { logger } = makeLogger()
		const result = await ensureRtkInstalled(logger, { enabled: false })
		expect(result.skipped).toBe(true)
		expect(result.reason).toBe('disabled')
	})

	it('skips when already installed', async () => {
		if (!isRtkInstalled()) return // only meaningful when rtk is present
		const { logger } = makeLogger()
		const result = await ensureRtkInstalled(logger, { enabled: true, autoInstall: true })
		expect(result.installed).toBe(true)
		expect(result.reason).toBe('already-installed')
	})

	it('skips install when autoInstall=false and binary missing', async () => {
		if (isRtkInstalled()) return // can't test missing-path when installed
		const { logger } = makeLogger()
		const result = await ensureRtkInstalled(logger, { enabled: true, autoInstall: false })
		expect(result.skipped).toBe(true)
		expect(result.reason).toBe('auto-install-disabled')
	})

	it('skips install in offline mode', async () => {
		if (isRtkInstalled()) return
		const prev = process.env['OPENCODE_OFFLINE']
		process.env['OPENCODE_OFFLINE'] = '1'
		try {
			const { logger } = makeLogger()
			const result = await ensureRtkInstalled(logger, { enabled: true, autoInstall: true })
			expect(result.skipped).toBe(true)
			expect(result.reason).toBe('offline')
		} finally {
			if (prev === undefined) delete process.env['OPENCODE_OFFLINE']
			else process.env['OPENCODE_OFFLINE'] = prev
		}
	})
})

describe('createRtkGuidanceHooks', () => {
	it('is a no-op when rtk is disabled', () => {
		const { logger } = makeLogger()
		const hooks = createRtkGuidanceHooks(logger, { rtk: { enabled: false } })
		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1', agent: 'forge' }, output)
		expect(output.parts.length).toBe(0)
	})

	it('does not inject for agents without shell access', () => {
		const { logger } = makeLogger()
		const hooks = createRtkGuidanceHooks(logger, { rtk: { enabled: true } })
		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1', agent: 'librarian' }, output)
		hooks.onMessage({ sessionID: 's1', agent: 'explore' }, output)
		hooks.onMessage({ sessionID: 's1', agent: 'oracle' }, output)
		hooks.onMessage({ sessionID: 's1', agent: 'metis' }, output)
		expect(output.parts.length).toBe(0)
	})

	it('injects RTK instructions for shell-capable agents including sage and muse', () => {
		if (!isRtkInstalled()) return // only meaningful when rtk is present
		const { logger } = makeLogger()
		const hooks = createRtkGuidanceHooks(logger, { rtk: { enabled: true } })
		const sageOutput: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 'sage-test', agent: 'sage' }, sageOutput)
		expect(sageOutput.parts.length).toBe(1)
		expect((sageOutput.parts[0] as { text: string }).text).toContain('RTK')

		const museOutput: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 'muse-test', agent: 'muse' }, museOutput)
		expect(museOutput.parts.length).toBe(1)
		expect((museOutput.parts[0] as { text: string }).text).toContain('RTK')
	})

	it('injects RTK instructions once per session for shell-capable agents when rtk is installed', () => {
		if (!isRtkInstalled()) return // only meaningful when rtk is present
		const { logger } = makeLogger()
		const hooks = createRtkGuidanceHooks(logger, { rtk: { enabled: true } })
		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's2', agent: 'forge' }, output)
		expect(output.parts.length).toBe(1)
		expect((output.parts[0] as { text: string }).text).toContain('<system-reminder>')
		// second call for the same session+agent is a no-op
		hooks.onMessage({ sessionID: 's2', agent: 'forge' }, output)
		expect(output.parts.length).toBe(1)
	})

	it('skips injection when rtk is missing from PATH and common locations', () => {
		if (isRtkInstalled()) return // only meaningful when rtk is absent
		const { logger } = makeLogger()
		const hooks = createRtkGuidanceHooks(logger, { rtk: { enabled: true } })
		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's3', agent: 'forge' }, output)
		expect(output.parts.length).toBe(0)
	})
})
