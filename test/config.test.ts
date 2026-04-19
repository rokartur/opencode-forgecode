import { describe, test, expect } from 'bun:test'
import { createConfigHandler } from '../src/config'
import { agents } from '../src/agents'

describe('createConfigHandler', () => {
	describe('built-in explore agent enhancement', () => {
		test('explore agent receives three graph tool permissions', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			expect(explore).toBeDefined()
			expect(explore.permission).toBeDefined()

			const permission = explore.permission as Record<string, string>
			expect(permission['graph-query']).toBe('allow')
			expect(permission['graph-symbols']).toBe('allow')
			expect(permission['graph-analyze']).toBe('allow')
		})

		test('explore agent receives graph-first prompt suffix', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			expect(explore).toBeDefined()
			expect(explore.prompt).toBeDefined()

			const prompt = explore.prompt as string
			expect(prompt).toContain('graph-query')
			expect(prompt).toContain('graph-symbols')
			expect(prompt).toContain('graph-analyze')
			expect(prompt).toContain('Graph-first discovery hierarchy')
		})

		test('explore prompt does not include muse-specific plan workflow text', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			const prompt = explore.prompt as string
			expect(prompt).not.toContain('plan-write')
			expect(prompt).not.toContain('plan-append')
			expect(prompt).not.toContain('plan-edit')
			expect(prompt).not.toContain('plan-read')
			expect(prompt).not.toContain('READ-ONLY mode')
		})

		test('explore prompt augmentation is appended not replaced', async () => {
			const configHandler = createConfigHandler(agents)

			const config: Record<string, unknown> = {
				agent: {
					explore: {
						prompt: 'Custom explore prompt prefix',
					},
				},
			}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			const prompt = explore.prompt as string
			expect(prompt).toContain('Custom explore prompt prefix')
			expect(prompt).toMatch(/graph-first|Graph-first/i)
		})

		test('explore prompt includes fallback guidance for Glob/Grep', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			const prompt = explore.prompt as string
			expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i)
		})

		test('explore prompt includes Read as direct inspection step', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			const prompt = explore.prompt as string
			expect(prompt).toMatch(/read.*inspect|direct.*inspection/i)
		})
	})

	describe('config merge behavior', () => {
		test('existing built-in agent prompts are preserved and augmented', async () => {
			const configHandler = createConfigHandler(agents)

			const config: Record<string, unknown> = {
				agent: {
					explore: {
						prompt: 'Original explore prompt',
						temperature: 0.5,
					},
				},
			}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>

			expect(explore.prompt).toContain('Original explore prompt')
			expect(explore.prompt).toMatch(/graph-first|Graph-first/i)
			expect(explore.temperature).toBe(0.5)
		})

		test('permission enablement is additive to existing permission config', async () => {
			const configHandler = createConfigHandler(agents)

			const config: Record<string, unknown> = {
				agent: {
					explore: {
						permission: {
							'existing-tool': 'allow',
						},
					},
				},
			}

			await configHandler(config)

			const exploreConfig = config.agent as Record<string, unknown>
			const explore = exploreConfig?.explore as Record<string, unknown>
			const permission = explore.permission as Record<string, string>

			expect(permission['existing-tool']).toBe('allow')
			expect(permission['graph-query']).toBe('allow')
			expect(permission['graph-symbols']).toBe('allow')
			expect(permission['graph-analyze']).toBe('allow')
		})

		test('built-in agents without enhancement are hidden if in REPLACED_BUILTIN_AGENTS', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const agentConfigs = config.agent as Record<string, unknown>

			expect(agentConfigs.explore).toBeDefined()
			expect(agentConfigs.build).toBeDefined()
			expect((agentConfigs.build as Record<string, unknown>).hidden).toBe(true)
			expect(agentConfigs.plan).toBeDefined()
			expect((agentConfigs.plan as Record<string, unknown>).hidden).toBe(true)
		})

		test('forge agent tools include review-delete: false by default', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const agentConfigs = config.agent as Record<string, unknown>
			const forge = agentConfigs.forge as Record<string, unknown>
			const tools = forge.tools as Record<string, boolean>

			expect(tools).toBeDefined()
			expect(tools['review-delete']).toBe(false)
		})

		test('user tool override preserves built-in excludes during merge', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {
				agent: {
					forge: {
						tools: {
							bash: true,
						},
					},
				},
			}

			await configHandler(config)

			const agentConfigs = config.agent as Record<string, unknown>
			const forge = agentConfigs.forge as Record<string, unknown>
			const tools = forge.tools as Record<string, boolean>

			expect(tools['review-delete']).toBe(false)
			expect(tools.bash).toBe(true)
		})

		test('explicit user override can override built-in tool denies', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {
				agent: {
					forge: {
						tools: {
							'review-delete': true,
						},
					},
				},
			}

			await configHandler(config)

			const agentConfigs = config.agent as Record<string, unknown>
			const forge = agentConfigs.forge as Record<string, unknown>
			const tools = forge.tools as Record<string, boolean>

			expect(tools['review-delete']).toBe(true)
		})

		test('sage agent retains review-delete access', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const agentConfigs = config.agent as Record<string, unknown>
			const sage = agentConfigs.sage as Record<string, unknown>

			expect(sage).toBeDefined()
			const tools = sage.tools as Record<string, boolean> | undefined
			if (tools) {
				expect(tools['review-delete']).not.toBe(false)
			}
		})
	})

	describe('stream timeout defaults', () => {
		test('injects timeout + chunkTimeout for common providers when absent', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const provider = config.provider as Record<string, { options?: Record<string, unknown> }>
			expect(provider).toBeDefined()
			expect(provider.openai?.options?.timeout).toBe(600_000)
			expect(provider.openai?.options?.chunkTimeout).toBe(300_000)
			expect(provider.anthropic?.options?.timeout).toBe(600_000)
			expect(provider.anthropic?.options?.chunkTimeout).toBe(300_000)
		})

		test('user-set provider options are NOT overwritten', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {
				provider: {
					openai: {
						options: { apiKey: 'sk-user', timeout: 42_000, chunkTimeout: 9_000 },
					},
				},
			}

			await configHandler(config)

			const provider = config.provider as Record<string, { options?: Record<string, unknown> }>
			expect(provider.openai?.options?.apiKey).toBe('sk-user')
			expect(provider.openai?.options?.timeout).toBe(42_000)
			expect(provider.openai?.options?.chunkTimeout).toBe(9_000)
		})

		test('partial user options are merged: missing timeout key gets default', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {
				provider: {
					openai: { options: { chunkTimeout: 99_000 } },
				},
			}

			await configHandler(config)

			const provider = config.provider as Record<string, { options?: Record<string, unknown> }>
			expect(provider.openai?.options?.chunkTimeout).toBe(99_000)
			expect(provider.openai?.options?.timeout).toBe(600_000)
		})

		test('custom providers already in user config also get timeout defaults', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {
				provider: {
					'my-custom-provider': { options: { apiKey: 'x' } },
				},
			}

			await configHandler(config)

			const provider = config.provider as Record<string, { options?: Record<string, unknown> }>
			expect(provider['my-custom-provider']?.options?.apiKey).toBe('x')
			expect(provider['my-custom-provider']?.options?.timeout).toBe(600_000)
			expect(provider['my-custom-provider']?.options?.chunkTimeout).toBe(300_000)
		})

		test('agent.options.timeout default is injected for plugin agents', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {}

			await configHandler(config)

			const agentCfg = config.agent as Record<string, { options?: Record<string, unknown> }>
			expect(agentCfg.forge?.options?.timeout).toBe(300_000)
			expect(agentCfg.muse?.options?.timeout).toBe(300_000)
		})

		test('user-set agent.options.timeout is NOT overwritten', async () => {
			const configHandler = createConfigHandler(agents)
			const config: Record<string, unknown> = {
				agent: {
					forge: { options: { timeout: 42_000, foo: 'bar' } },
				},
			}

			await configHandler(config)

			const agentCfg = config.agent as Record<string, { options?: Record<string, unknown> }>
			expect(agentCfg.forge?.options?.timeout).toBe(42_000)
			expect(agentCfg.forge?.options?.foo).toBe('bar')
		})
	})
})
