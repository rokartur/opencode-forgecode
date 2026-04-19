/**
 * Auto-setup of models & providers for forge agents/subagents.
 *
 * Philosophy (mirrors oh-my-opencode's model-requirements approach):
 *   1. Determine which providers the user has access to — either from the
 *      interactive `setup-models install` CLI (user answers yes/no to each
 *      subscription) or from the opencode server's `/provider` response
 *      at plugin startup (`connected` list).
 *   2. For each agent, walk its prioritized chain (`AGENT_CHAINS`) and pick
 *      the FIRST chain entry whose provider set intersects the user's
 *      providers AND whose model name is present in that provider's catalog.
 *      Subsequent matches form the `fallback_models` array.
 *   3. Persist the resulting mapping to `forge-config.jsonc` under
 *      `agents.<name>.{model, fallback_models}`.
 *
 * Model-name matching is prefix-based (case-insensitive) so that a chain
 * entry like `claude-opus-4` transparently picks up `claude-opus-4-5`,
 * `claude-opus-4-7`, etc. as providers publish newer versions.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import type { PluginConfig, AgentOverrideConfig, FallbackEntry, Logger } from '../types'
import { resolveConfigPath } from '../setup'
import { agents as AGENT_DEFINITIONS } from '../agents'
import { AGENT_CHAINS, type ChainEntry, type SupportedProvider } from './model-requirements'

/** Minimal provider catalog used by the resolver. */
export interface ProviderCatalog {
	/** provider id → set of available model ids. */
	models: Map<string, Set<string>>
	/** Providers the opencode server says are authenticated/reachable. */
	connected: Set<string>
}

/**
 * Loose client shape — the SDK overloads are awkward to match structurally.
 * We only rely on `provider.list` returning `{ data?, error? }`.
 */
// biome-ignore lint/suspicious/noExplicitAny: see comment above
export type AutoSetupClient = { provider: { list: (...args: any[]) => any } }

export interface AgentAssignment {
	agent: string
	model: string
	fallback_models: string[]
	profileRationale: string
}

// ---------------------------------------------------------------------------
// Provider catalog fetching
// ---------------------------------------------------------------------------

export async function fetchProviderCatalog(
	client: AutoSetupClient,
	directory: string | undefined,
): Promise<ProviderCatalog | null> {
	type RawModel = { id: string; name: string }
	type RawProvider = { id: string; name: string; models?: Record<string, RawModel> }
	type RawResult = { data?: { all?: RawProvider[]; connected?: string[] }; error?: unknown }

	try {
		const raw = (await client.provider.list({ query: { directory: directory ?? '' } })) as RawResult
		if (raw.error || !raw.data) return null

		const models = new Map<string, Set<string>>()
		for (const p of raw.data.all ?? []) {
			const ids = new Set<string>()
			for (const m of Object.values(p.models ?? {})) ids.add(m.id)
			models.set(p.id, ids)
		}
		return { models, connected: new Set(raw.data.connected ?? []) }
	} catch {
		return null
	}
}

// ---------------------------------------------------------------------------
// Chain resolution
// ---------------------------------------------------------------------------

/**
 * Pick the best concrete `providerID/modelID` for a single chain entry given
 * the user's available providers and the catalog of published models.
 */
export function resolveChainEntry(
	entry: ChainEntry,
	availableProviders: Set<string>,
	catalog: ProviderCatalog | null,
): { provider: string; modelId: string; full: string } | null {
	for (const provider of entry.providers) {
		if (!availableProviders.has(provider)) continue

		// Without a catalog we trust the chain literally — used by the
		// interactive installer before the opencode server is running.
		if (!catalog) {
			const modelId = entry.variant ? `${entry.model}-${entry.variant}` : entry.model
			return { provider, modelId, full: `${provider}/${modelId}` }
		}

		const providerModels = catalog.models.get(provider)
		if (!providerModels || providerModels.size === 0) continue

		const pattern = entry.model.toLowerCase()
		const variantSuffix = entry.variant?.toLowerCase()

		// Prefer exact, then variant-suffix, then prefix. Among prefix
		// matches, pick lexicographically latest id (newer versions tend
		// to sort later, e.g. `claude-opus-4-7` > `claude-opus-4-5`).
		let best: string | null = null
		for (const m of providerModels) {
			const lower = m.toLowerCase()
			if (lower === pattern) return { provider, modelId: m, full: `${provider}/${m}` }
			if (variantSuffix && lower === `${pattern}-${variantSuffix}`) {
				return { provider, modelId: m, full: `${provider}/${m}` }
			}
			if (lower.startsWith(pattern)) {
				if (best === null || m > best) best = m
			}
		}
		if (best) return { provider, modelId: best, full: `${provider}/${best}` }
	}
	return null
}

export function resolveAgentChain(
	agent: string,
	availableProviders: Set<string>,
	catalog: ProviderCatalog | null,
): { primary: string; fallbacks: string[]; rationale: string } | null {
	const agentChain = AGENT_CHAINS[agent]
	if (!agentChain) return null

	const seen = new Set<string>()
	const resolved: string[] = []
	for (const entry of agentChain.chain) {
		const hit = resolveChainEntry(entry, availableProviders, catalog)
		if (!hit || seen.has(hit.full)) continue
		seen.add(hit.full)
		resolved.push(hit.full)
	}
	if (resolved.length === 0) return null
	return { primary: resolved[0]!, fallbacks: resolved.slice(1), rationale: agentChain.rationale }
}

export function computeAgentAssignments(
	availableProviders: Set<string>,
	pluginConfig: PluginConfig,
	catalog: ProviderCatalog | null,
	opts: { overwrite?: boolean; maxFallbacks?: number } = {},
): AgentAssignment[] {
	const maxFallbacks = opts.maxFallbacks ?? 4
	const existing = pluginConfig.agents ?? {}
	const out: AgentAssignment[] = []
	for (const displayName of Object.keys(AGENT_DEFINITIONS)) {
		if (!opts.overwrite && existing[displayName]?.model) continue
		const resolved = resolveAgentChain(displayName, availableProviders, catalog)
		if (!resolved) continue
		out.push({
			agent: displayName,
			model: resolved.primary,
			fallback_models: resolved.fallbacks.slice(0, maxFallbacks),
			profileRationale: resolved.rationale,
		})
	}
	return out
}

// ---------------------------------------------------------------------------
// Config merging & persistence
// ---------------------------------------------------------------------------

export function mergeAssignmentsIntoConfig(
	pluginConfig: PluginConfig,
	assignments: AgentAssignment[],
): PluginConfig {
	if (assignments.length === 0) return pluginConfig
	const agents: Record<string, AgentOverrideConfig> = { ...pluginConfig.agents }
	for (const a of assignments) {
		const existing = agents[a.agent] ?? {}
		agents[a.agent] = {
			...existing,
			model: existing.model ?? a.model,
			fallback_models:
				(existing.fallback_models as Array<string | FallbackEntry> | undefined) ?? a.fallback_models,
		}
	}
	pluginConfig.agents = agents
	return pluginConfig
}

export function persistAgentAssignments(
	assignments: AgentAssignment[],
	logger: Pick<Logger, 'log' | 'debug' | 'error'>,
): { written: boolean; reason?: string } {
	if (assignments.length === 0) return { written: false, reason: 'no-assignments' }
	const configPath = resolveConfigPath()
	if (!existsSync(configPath)) return { written: false, reason: 'config-missing' }

	let raw: string
	try {
		raw = readFileSync(configPath, 'utf-8')
	} catch (err) {
		logger.error(`[auto-model-setup] failed to read ${configPath}`, err)
		return { written: false, reason: 'read-error' }
	}

	if (/^[\t ]*"agents"\s*:/m.test(raw)) {
		logger.log(
			`[auto-model-setup] forge-config.jsonc already has an "agents" block; in-memory only. ` +
				`Run \`oc-forgecode setup-models reset\` then re-run to regenerate.`,
		)
		return { written: false, reason: 'agents-block-exists' }
	}

	const block = renderAgentsBlock(assignments)
	const injected = injectBeforeClosingBrace(raw, block)
	if (injected === null) return { written: false, reason: 'parse-error' }

	try {
		writeFileSync(configPath, injected, 'utf-8')
		logger.log(`[auto-model-setup] wrote ${assignments.length} agent mapping(s) to ${configPath}`)
		return { written: true }
	} catch (err) {
		logger.error(`[auto-model-setup] failed to write ${configPath}`, err)
		return { written: false, reason: 'write-error' }
	}
}

function renderAgentsBlock(assignments: AgentAssignment[]): string {
	const lines: string[] = []
	lines.push('\t// Per-agent model mappings (auto-generated by forge auto-setup).')
	lines.push('\t// Edit freely; run `oc-forgecode setup-models reset` to regenerate.')
	lines.push('\t"agents": {')
	for (let i = 0; i < assignments.length; i++) {
		const a = assignments[i]!
		const last = i === assignments.length - 1
		lines.push(`\t\t// ${a.agent}: ${a.profileRationale}`)
		lines.push(`\t\t"${a.agent}": {`)
		lines.push(`\t\t\t"model": "${a.model}",`)
		const fb = a.fallback_models.map(m => `"${m}"`).join(', ')
		lines.push(`\t\t\t"fallback_models": [${fb}]`)
		lines.push(`\t\t}${last ? '' : ','}`)
	}
	lines.push('\t},')
	return lines.join('\n')
}

function injectBeforeClosingBrace(raw: string, block: string): string | null {
	const lastBrace = raw.lastIndexOf('}')
	if (lastBrace < 0) return null
	const before = raw.slice(0, lastBrace).trimEnd()
	const after = raw.slice(lastBrace)
	const needsComma = !/[,{]\s*$/.test(before)
	const sep = needsComma ? ',' : ''
	return `${before}${sep}\n${block}\n${after}`
}

// ---------------------------------------------------------------------------
// Plugin startup orchestrator — uses `connected` providers from the opencode
// server as the "available" set. Never throws.
// ---------------------------------------------------------------------------

export async function runAutoModelSetup(
	client: AutoSetupClient,
	directory: string | undefined,
	pluginConfig: PluginConfig,
	logger: Pick<Logger, 'log' | 'debug' | 'error'>,
	opts: { overwrite?: boolean; persist?: boolean } = {},
): Promise<AgentAssignment[]> {
	try {
		const existing = pluginConfig.agents ?? {}
		const allConfigured = Object.keys(AGENT_DEFINITIONS).every(name => !!existing[name]?.model)
		if (allConfigured && !opts.overwrite) {
			logger.debug('[auto-model-setup] all agents already have explicit models; skipping')
			return []
		}

		const catalog = await fetchProviderCatalog(client, directory)
		if (!catalog || catalog.connected.size === 0) {
			logger.debug('[auto-model-setup] no connected providers — skipping auto assignment')
			return []
		}

		const assignments = computeAgentAssignments(catalog.connected, pluginConfig, catalog, {
			overwrite: opts.overwrite,
		})
		if (assignments.length === 0) {
			logger.log('[auto-model-setup] no chain entries matched any connected provider')
			return []
		}

		mergeAssignmentsIntoConfig(pluginConfig, assignments)
		for (const a of assignments) {
			logger.log(
				`[auto-model-setup] ${a.agent} → ${a.model} (fallbacks: ${a.fallback_models.join(', ') || 'none'})`,
			)
		}

		if (opts.persist !== false) persistAgentAssignments(assignments, logger)
		return assignments
	} catch (err) {
		logger.error('[auto-model-setup] unexpected failure — continuing without auto assignment', err)
		return []
	}
}

export type { SupportedProvider }
