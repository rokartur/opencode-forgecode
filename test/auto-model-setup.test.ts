import { describe, expect, test } from 'bun:test'
import {
	computeAgentAssignments,
	mergeAssignmentsIntoConfig,
	resolveAgentChain,
	resolveChainEntry,
	type ProviderCatalog,
} from '../src/runtime/auto-model-setup'
import { AGENT_CHAINS } from '../src/runtime/model-requirements'
import { removeAgentsBlock } from '../src/cli/commands/setup-models'
import type { PluginConfig } from '../src/types'

function catalog(entries: Record<string, string[]>, connected: string[] = []): ProviderCatalog {
	const models = new Map<string, Set<string>>()
	for (const [p, ids] of Object.entries(entries)) models.set(p, new Set(ids))
	return { models, connected: new Set(connected) }
}

describe('resolveChainEntry', () => {
	test('returns null when no provider is available', () => {
		const entry = { providers: ['anthropic', 'opencode'], model: 'claude-opus-4' }
		const res = resolveChainEntry(entry, new Set(['openai']), null)
		expect(res).toBeNull()
	})

	test('prefix-matches and picks lexicographically latest model', () => {
		const entry = { providers: ['anthropic'], model: 'claude-opus-4' }
		const cat = catalog({ anthropic: ['claude-opus-4-5', 'claude-opus-4-7', 'claude-opus-3'] })
		const res = resolveChainEntry(entry, new Set(['anthropic']), cat)
		expect(res?.full).toBe('anthropic/claude-opus-4-7')
	})

	test('without catalog, trusts the chain literal', () => {
		const entry = { providers: ['opencode'], model: 'claude-opus-4', variant: '7' }
		const res = resolveChainEntry(entry, new Set(['opencode']), null)
		expect(res?.full).toBe('opencode/claude-opus-4-7')
	})

	test('prefers first provider in the list that has a matching model', () => {
		const entry = { providers: ['anthropic', 'github-copilot'], model: 'claude-opus-4' }
		const cat = catalog({ 'github-copilot': ['claude-opus-4-7'], anthropic: [] })
		const res = resolveChainEntry(entry, new Set(['anthropic', 'github-copilot']), cat)
		expect(res?.full).toBe('github-copilot/claude-opus-4-7')
	})

	test('variant suffix matches exactly', () => {
		const entry = { providers: ['anthropic'], model: 'claude', variant: 'opus-4-5' }
		const cat = catalog({ anthropic: ['claude-opus-4-5', 'claude-opus-4-7'] })
		const res = resolveChainEntry(entry, new Set(['anthropic']), cat)
		expect(res?.modelId).toBe('claude-opus-4-5')
	})
})

describe('resolveAgentChain', () => {
	test('returns null for unknown agents', () => {
		expect(resolveAgentChain('not-a-real-agent', new Set(['anthropic']), null)).toBeNull()
	})

	test('produces primary + fallbacks in chain order with no dupes', () => {
		const agent = Object.keys(AGENT_CHAINS)[0]!
		const providers = new Set<string>(['anthropic', 'opencode', 'openai', 'opencode-go'])
		const res = resolveAgentChain(agent, providers, null)
		expect(res).not.toBeNull()
		expect(res!.primary.length).toBeGreaterThan(0)
		const all = [res!.primary, ...res!.fallbacks]
		expect(new Set(all).size).toBe(all.length)
	})
})

describe('computeAgentAssignments', () => {
	test('skips agents that the user has already pinned unless overwrite=true', () => {
		const config: PluginConfig = { agents: { forge: { model: 'custom/pinned' } } }
		const skipped = computeAgentAssignments(new Set(['anthropic']), config, null)
		expect(skipped.find(a => a.agent === 'forge')).toBeUndefined()

		const overwritten = computeAgentAssignments(new Set(['anthropic']), config, null, {
			overwrite: true,
		})
		expect(overwritten.find(a => a.agent === 'forge')).toBeDefined()
	})

	test('with rich provider set, assigns every agent that has a chain', () => {
		const providers = new Set<string>(['anthropic', 'openai', 'opencode', 'opencode-go', 'github-copilot'])
		const out = computeAgentAssignments(providers, {}, null)
		expect(out.length).toBe(Object.keys(AGENT_CHAINS).length)
		for (const a of out) {
			expect(a.model).toMatch(/\//)
			expect(a.profileRationale.length).toBeGreaterThan(0)
		}
	})

	test('caps fallback_models at maxFallbacks', () => {
		const providers = new Set<string>(['anthropic', 'openai', 'opencode', 'opencode-go', 'github-copilot'])
		const out = computeAgentAssignments(providers, {}, null, { maxFallbacks: 1 })
		for (const a of out) expect(a.fallback_models.length).toBeLessThanOrEqual(1)
	})
})

describe('mergeAssignmentsIntoConfig', () => {
	test('preserves existing per-agent overrides (temperature, user_prompt)', () => {
		const config: PluginConfig = {
			agents: { forge: { temperature: 0.2, user_prompt: 'hi' } },
		}
		const merged = mergeAssignmentsIntoConfig(config, [
			{ agent: 'forge', model: 'x/y', fallback_models: ['a/b'], profileRationale: 'r' },
		])
		expect(merged.agents?.forge?.model).toBe('x/y')
		expect(merged.agents?.forge?.temperature).toBe(0.2)
		expect(merged.agents?.forge?.user_prompt).toBe('hi')
	})

	test('does not clobber a user-set model', () => {
		const config: PluginConfig = { agents: { forge: { model: 'user/pinned' } } }
		const merged = mergeAssignmentsIntoConfig(config, [
			{ agent: 'forge', model: 'auto/picked', fallback_models: [], profileRationale: 'r' },
		])
		expect(merged.agents?.forge?.model).toBe('user/pinned')
	})
})

describe('removeAgentsBlock', () => {
	test('removes a top-level agents block', () => {
		const raw = `{
\t"plan": { "enabled": true },
\t// Per-agent model mappings (auto-generated by forge auto-setup).
\t"agents": {
\t\t"forge": { "model": "a/b", "fallback_models": ["c/d"] },
\t\t"muse": { "model": "e/f", "fallback_models": [] }
\t},
\t"budget": { "limit": 10 }
}
`
		const out = removeAgentsBlock(raw)
		expect(out).not.toBeNull()
		expect(out).not.toContain('"agents"')
		expect(out).toContain('"plan"')
		expect(out).toContain('"budget"')
	})

	test('returns null when no agents block exists', () => {
		expect(removeAgentsBlock('{ "plan": { "enabled": true } }')).toBeNull()
	})
})
