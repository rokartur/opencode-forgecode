import { describe, expect, test } from 'bun:test'
import { createRestrictedShellHooks } from '../src/hooks/restricted-shell'
import { createContextInjectionHooks } from '../src/hooks/context-injection'
import { createSkillLoaderHooks } from '../src/hooks/skill-loader'
import { createIntentRouterHooks } from '../src/hooks/intent-router'
import { createUserPromptTemplateHooks } from '../src/hooks/user-prompt-template'
import type { PluginConfig } from '../src/types'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const logger = {
	log: (_msg: string) => {},
	error: (_msg: string, _err?: unknown) => {},
	debug: (_msg: string, _err?: unknown) => {},
}

// ─── Restricted Shell ───────────────────────────────────────────────────────

describe('restricted shell hook', () => {
	test('allows commands when disabled', () => {
		const config: PluginConfig = { restrictedShell: { enabled: false } }
		const hooks = createRestrictedShellHooks(logger, config)
		hooks.trackAgent({ sessionID: 's1', agent: 'forge' })

		const output = { args: { command: 'rm -rf /' } }
		hooks.toolBefore({ tool: 'bash', sessionID: 's1', callID: 'c1' }, output)

		// Command should be unchanged (disabled)
		expect((output.args as { command: string }).command).toBe('rm -rf /')
	})

	test('blocks dangerous commands when enabled', () => {
		const config: PluginConfig = {
			restrictedShell: {
				enabled: true,
				whitelist: { forge: ['ls', 'cat', 'grep'] },
			},
		}
		const hooks = createRestrictedShellHooks(logger, config)
		hooks.trackAgent({ sessionID: 's1', agent: 'forge' })

		const output = { args: { command: 'rm -rf /' } }
		hooks.toolBefore({ tool: 'bash', sessionID: 's1', callID: 'c1' }, output)

		expect((output.args as { command: string }).command).toContain('blocked')
	})

	test('allows whitelisted commands', () => {
		const config: PluginConfig = {
			restrictedShell: {
				enabled: true,
				whitelist: { forge: ['ls', 'cat', 'grep'] },
			},
		}
		const hooks = createRestrictedShellHooks(logger, config)
		hooks.trackAgent({ sessionID: 's1', agent: 'forge' })

		const output = { args: { command: 'ls -la' } }
		hooks.toolBefore({ tool: 'bash', sessionID: 's1', callID: 'c1' }, output)

		// Should be unchanged
		expect((output.args as { command: string }).command).toBe('ls -la')
	})

	test('ignores non-bash tools', () => {
		const config: PluginConfig = {
			restrictedShell: {
				enabled: true,
				whitelist: { forge: ['ls'] },
			},
		}
		const hooks = createRestrictedShellHooks(logger, config)
		hooks.trackAgent({ sessionID: 's1', agent: 'forge' })

		const output = { args: { path: '/etc/passwd' } }
		hooks.toolBefore({ tool: 'read_file', sessionID: 's1', callID: 'c1' }, output)

		// Should be unchanged
		expect((output.args as { path: string }).path).toBe('/etc/passwd')
	})
})

// ─── Context Injection ──────────────────────────────────────────────────────

describe('context injection hook', () => {
	const testDir = join(tmpdir(), `ctx-inject-test-${Date.now()}`)

	test('injects AGENTS.md content on first message', () => {
		const dir = join(testDir, 'agents-test')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'AGENTS.md'), '# My Agents\nCustom rules here.')

		const config: PluginConfig = { contextInjection: { enabled: true } }
		const hooks = createContextInjectionHooks(logger, dir, config)

		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1' }, output)

		expect(output.parts.length).toBe(1)
		expect(output.parts[0].text).toContain('My Agents')
		expect(output.parts[0].synthetic).toBe(true)

		rmSync(dir, { recursive: true, force: true })
	})

	test('does not inject twice for same session', () => {
		const dir = join(testDir, 'dedup-test')
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, 'AGENTS.md'), '# Test')

		const config: PluginConfig = { contextInjection: { enabled: true } }
		const hooks = createContextInjectionHooks(logger, dir, config)

		const output1: { parts: Array<Record<string, unknown>> } = { parts: [] }
		const output2: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1' }, output1)
		hooks.onMessage({ sessionID: 's1' }, output2)

		expect(output1.parts.length).toBe(1)
		expect(output2.parts.length).toBe(0) // no re-injection

		rmSync(dir, { recursive: true, force: true })
	})

	test('does nothing when disabled', () => {
		const config: PluginConfig = { contextInjection: { enabled: false } }
		const hooks = createContextInjectionHooks(logger, '/nonexistent', config)

		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1' }, output)

		expect(output.parts.length).toBe(0)
	})
})

// ─── Skill Loader ───────────────────────────────────────────────────────────

describe('skill loader hook', () => {
	const testDir = join(tmpdir(), `skill-loader-test-${Date.now()}`)

	test('injects skills from project scope', () => {
		const dir = join(testDir, 'skills-test')
		const skillsDir = join(dir, '.opencode', 'skills')
		mkdirSync(skillsDir, { recursive: true })
		writeFileSync(
			join(skillsDir, 'testing.md'),
			'---\nname: testing\ndescription: Test guidelines\n---\nAlways write tests.',
		)

		const config: PluginConfig = { skills: { enabled: true } }
		const hooks = createSkillLoaderHooks(logger, dir, config)

		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1', agent: 'forge' }, output)

		expect(output.parts.length).toBe(1)
		expect(output.parts[0].text).toContain('Always write tests')
		expect(output.parts[0].synthetic).toBe(true)

		rmSync(dir, { recursive: true, force: true })
	})

	test('does nothing when disabled', () => {
		const config: PluginConfig = { skills: { enabled: false } }
		const hooks = createSkillLoaderHooks(logger, '/nonexistent', config)

		const output: { parts: Array<Record<string, unknown>> } = { parts: [] }
		hooks.onMessage({ sessionID: 's1', agent: 'forge' }, output)

		expect(output.parts.length).toBe(0)
	})
})

// ─── Intent Router ──────────────────────────────────────────────────────────

describe('intent router hook', () => {
	test('adds routing hint when intent mismatches agent', () => {
		const config: PluginConfig = {
			intentGate: { enabled: true, heuristicsOnly: true },
		}
		const hooks = createIntentRouterHooks(logger, config)

		const output = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'forge' },
					parts: [{ type: 'text', text: 'review my code and find bugs' }],
				},
			],
		}
		hooks.onMessagesTransform(output)

		// Should suggest sage for review
		const syntheticParts = output.messages[0].parts.filter(p => p.synthetic === true)
		expect(syntheticParts.length).toBe(1)
		expect(syntheticParts[0].text as string).toContain('sage')
	})

	test('does nothing when intent matches agent', () => {
		const config: PluginConfig = {
			intentGate: { enabled: true, heuristicsOnly: true },
		}
		const hooks = createIntentRouterHooks(logger, config)

		const output = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'forge' },
					parts: [{ type: 'text', text: 'implement a new login page' }],
				},
			],
		}
		hooks.onMessagesTransform(output)

		// No hint added (forge is correct for implement)
		const syntheticParts = output.messages[0].parts.filter(p => p.synthetic === true)
		expect(syntheticParts.length).toBe(0)
	})

	test('does nothing when disabled', () => {
		const config: PluginConfig = {
			intentGate: { enabled: false },
		}
		const hooks = createIntentRouterHooks(logger, config)

		const output = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'forge' },
					parts: [{ type: 'text', text: 'review my code' }],
				},
			],
		}
		hooks.onMessagesTransform(output)

		const syntheticParts = output.messages[0].parts.filter(p => p.synthetic === true)
		expect(syntheticParts.length).toBe(0)
	})
})

// ─── User Prompt Template ───────────────────────────────────────────────────

describe('user prompt template hook', () => {
	test('injects rendered template for configured agent', () => {
		const config: PluginConfig = {
			agents: {
				forge: {
					user_prompt: 'Working in {{cwd}} on project {{projectId}}',
				},
			},
		}
		const hooks = createUserPromptTemplateHooks(logger, config)

		const output = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'forge' },
					parts: [{ type: 'text', text: 'help me' }],
				},
			],
		}
		hooks.onMessagesTransform(output, {
			directory: '/home/dev/project',
			projectId: 'test-proj',
		})

		const syntheticParts = output.messages[0].parts.filter(p => p.synthetic === true)
		expect(syntheticParts.length).toBe(1)
		expect(syntheticParts[0].text as string).toContain('/home/dev/project')
		expect(syntheticParts[0].text as string).toContain('test-proj')
	})

	test('does nothing for agent without user_prompt', () => {
		const config: PluginConfig = {
			agents: {
				forge: {},
			},
		}
		const hooks = createUserPromptTemplateHooks(logger, config)

		const output = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'forge' },
					parts: [{ type: 'text', text: 'help me' }],
				},
			],
		}
		hooks.onMessagesTransform(output, {
			directory: '/tmp',
			projectId: 'p1',
		})

		const syntheticParts = output.messages[0].parts.filter(p => p.synthetic === true)
		expect(syntheticParts.length).toBe(0)
	})

	test('does nothing without agents config', () => {
		const config: PluginConfig = {}
		const hooks = createUserPromptTemplateHooks(logger, config)

		const output = {
			messages: [
				{
					info: { role: 'user' as const, agent: 'forge' },
					parts: [{ type: 'text', text: 'help me' }],
				},
			],
		}
		hooks.onMessagesTransform(output, {
			directory: '/tmp',
			projectId: 'p1',
		})

		expect(output.messages[0].parts.length).toBe(1) // only original
	})
})
