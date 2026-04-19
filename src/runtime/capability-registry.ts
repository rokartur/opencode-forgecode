/**
 * Capability registry — single source of truth for the runtime status of every
 * capability in the plugin.
 *
 * Used by:
 * - startup warnings (`logUnsupportedConfigIssues`)
 * - `oc-forgecode doctor`
 * - README status matrix generation
 * - runtime gating
 */

export type CapabilityStatus = 'implemented' | 'partial' | 'config-only' | 'planned'

export interface CapabilityDescriptor {
	id: string
	label: string
	status: CapabilityStatus
	note: string
	/** Optional list of external dependencies required at runtime. */
	externalDeps?: string[]
	/** Category for grouping in reports. */
	category: 'core' | 'agents' | 'safety' | 'tools' | 'platform' | 'optional'
}

export interface CapabilityIssue {
	id: string
	label: string
	severity: 'fail' | 'warn' | 'info'
	detail: string
}

const CAPABILITY_REGISTRY: CapabilityDescriptor[] = [
	// ── Core (implemented) ───────────────────────────────────────────────
	{
		id: 'harness-core',
		label: 'Harness core',
		status: 'implemented',
		note: 'summary-frame compaction, truncation, doom-loop, pending-todos, snapshots',
		category: 'core',
	},
	{
		id: 'graph-loops-agents',
		label: 'Graph + loops + agent trinity',
		status: 'implemented',
		note: 'graph indexing, loop runtime, forge/muse/sage',
		category: 'core',
	},
	{
		id: 'hash-anchored-patch',
		label: 'Hash-anchored patch',
		status: 'implemented',
		note: 'patch tool with LINE#HASH anchors',
		category: 'core',
	},
	{
		id: 'docker-sandbox',
		label: 'Docker sandbox',
		status: 'implemented',
		note: 'isolated loop execution via Docker',
		externalDeps: ['docker'],
		category: 'core',
	},

	// ── Agents (partial / implemented) ───────────────────────────────────
	{
		id: 'agent-fallbacks',
		label: 'Per-agent fallback chain',
		status: 'implemented',
		note: 'full fallback chain across providers with reason-aware retry, context-window recovery, per-agent override',
		category: 'agents',
	},
	{
		id: 'agent-budgets',
		label: 'Per-agent budgets',
		status: 'implemented',
		note: 'runtime enforcement of maxTurns, maxToolFailuresPerTurn, maxRequestsPerTurn, maxTokensPerSession',
		category: 'agents',
	},
	{
		id: 'agent-user-prompt',
		label: 'Per-agent user prompt templating',
		status: 'implemented',
		note: 'simple template layer with {{variable}} substitution and opt-in injection',
		category: 'agents',
	},

	// ── Safety (implemented) ─────────────────────────────────────────────
	{
		id: 'restricted-shell',
		label: 'Restricted shell',
		status: 'implemented',
		note: 'per-agent command allowlists with parser and audit bypass',
		category: 'safety',
	},
	{
		id: 'session-recovery',
		label: 'Session recovery',
		status: 'implemented',
		note: 'compaction+retry on context overflow, backoff on timeout, fallback on 5xx/overload',
		category: 'safety',
	},
	{
		id: 'context-injection',
		label: 'Context injection',
		status: 'implemented',
		note: 'automatic injection of AGENTS.md, README.md, .opencode/context/*.md with conditional rules',
		category: 'safety',
	},
	{
		id: 'intent-gate',
		label: 'Intent routing',
		status: 'implemented',
		note: 'heuristics-first classifier with optional LLM fallback for ambiguous prompts',
		category: 'safety',
	},

	// ── Tools (implemented / config-only) ────────────────────────────────
	{
		id: 'ast',
		label: 'AST-aware tooling',
		status: 'implemented',
		note: 'ast-grep wrapper (ast_search / ast_rewrite) with sg binary detection and graceful fallback',
		externalDeps: ['sg'],
		category: 'tools',
	},
	{
		id: 'lsp',
		label: 'LSP tooling',
		status: 'implemented',
		note: 'LspPool + LspClient wired into tools — lsp_diagnostics, lsp_definition, lsp_references, lsp_hover, lsp_code_actions, lsp_rename with graceful fallback',
		category: 'tools',
	},

	// ── Platform (implemented / config-only) ─────────────────────────────
	{
		id: 'background',
		label: 'Background runtime',
		status: 'implemented',
		note: 'BackgroundManager + ConcurrencyManager + BackgroundSpawner wired at startup; bg_spawn / bg_status / bg_wait / bg_cancel tools; agent-as-tool delegation',
		category: 'platform',
	},
	{
		id: 'telemetry',
		label: 'Telemetry',
		status: 'implemented',
		note: 'local SQLite telemetry with event tracking, retention, and batched writes',
		category: 'platform',
	},
	{
		id: 'skills',
		label: 'Skill loader',
		status: 'implemented',
		note: 'project/user/global scope skill loading with frontmatter, registry, and runtime injection',
		category: 'platform',
	},
	{
		id: 'ci-mode',
		label: 'CI mode',
		status: 'implemented',
		note: 'non-TTY harness execution with JSON output, markdown report, and exit codes',
		category: 'platform',
	},

	// ── Optional ─────────────────────────────────────────────────────────
	{
		id: 'sandbox-extra-modes',
		label: 'Additional sandbox modes',
		status: 'implemented',
		note: 'SandboxBackend interface + sandbox-exec (macOS), bubblewrap (Linux), firejail (Linux) backends with auto-detect; resolveSandboxBackend selects best available',
		category: 'optional',
	},
	{
		id: 'semantic-search',
		label: 'Real semantic search',
		status: 'implemented',
		note: 'Pluggable embeddings (fastembed/OpenAI/Voyage) + symbol-aware chunker + in-memory HNSW index store + semanticSearch API',
		category: 'optional',
	},
	{
		id: 'mcp-oauth',
		label: 'MCP OAuth 2.0 + PKCE + DCR',
		status: 'implemented',
		note: 'PKCE code verifier/challenge, OAuthClient factory, RFC 7591 DCR, secure token store (keytar/encrypted-file), CLI auth flow with local callback server',
		category: 'optional',
	},
	{
		id: 'ultrawork',
		label: 'Ultrawork mode',
		status: 'implemented',
		note: 'Autonomous pipeline: Intent Gate → Strategic Plan (muse) → Execute (forge) → Audit (sage) → Report; slash command template + CLI + programmatic API',
		category: 'optional',
	},
]

/**
 * Return the full capability registry (immutable copy).
 */
export function getCapabilityRegistry(): readonly CapabilityDescriptor[] {
	return CAPABILITY_REGISTRY
}

/**
 * Lookup a single capability by id.
 */
export function getCapability(id: string): CapabilityDescriptor | undefined {
	return CAPABILITY_REGISTRY.find(c => c.id === id)
}

/**
 * Return capabilities filtered by status.
 */
export function getCapabilitiesByStatus(status: CapabilityStatus): CapabilityDescriptor[] {
	return CAPABILITY_REGISTRY.filter(c => c.status === status)
}

/**
 * Return capabilities filtered by category.
 */
export function getCapabilitiesByCategory(category: CapabilityDescriptor['category']): CapabilityDescriptor[] {
	return CAPABILITY_REGISTRY.filter(c => c.category === category)
}

/**
 * Generate a human-readable status matrix for documentation.
 */
export function generateStatusMatrix(): string {
	const lines: string[] = ['| Capability | Status | Note |', '|---|---|---|']
	for (const cap of CAPABILITY_REGISTRY) {
		const icon = statusIcon(cap.status)
		lines.push(`| ${cap.label} | ${icon} ${cap.status} | ${cap.note} |`)
	}
	return lines.join('\n')
}

function statusIcon(status: CapabilityStatus): string {
	switch (status) {
		case 'implemented':
			return '✅'
		case 'partial':
			return '🔶'
		case 'config-only':
			return '⚙️'
		case 'planned':
			return '📋'
	}
}
