import type { PluginConfig } from '../types'

/**
 * Capability status tiers:
 * - `implemented`: feature is fully wired into runtime and active by default (or via simple config flag).
 * - `partial`: feature has runtime, but is missing capability surface (e.g. some operations work, others don't).
 * - `ready-to-wire`: standalone runtime module exists in `src/runtime/` with full logic and tests, but is
 *   not yet integrated into hooks/setup. Enabling the config flag does NOT yet take effect — runtime wiring
 *   is planned in a later stage. This status is for contributor visibility; users still see a FAIL when they
 *   enable a `ready-to-wire` capability via config (until the wiring stage lands).
 * - `config-only`: only types/config exist, no runtime module yet.
 */
export type CapabilityStatus = 'implemented' | 'partial' | 'ready-to-wire' | 'config-only'

export interface CapabilityDescriptor {
	id: string
	label: string
	status: CapabilityStatus
	note: string
	/** Stage where wiring/implementation is planned (free-form, e.g. "Stage 2"). Optional. */
	plannedStage?: string
}

export interface CapabilityIssue {
	id: string
	label: string
	severity: 'fail'
	detail: string
}

const CAPABILITY_DESCRIPTORS: CapabilityDescriptor[] = [
	{
		id: 'harness-core',
		label: 'Harness core',
		status: 'implemented',
		note: 'summary-frame compaction, truncation, doom-loop, pending-todos, snapshots',
	},
	{
		id: 'graph-loops-agents',
		label: 'Graph + loops + agent trinity',
		status: 'implemented',
		note: 'graph indexing, loop runtime, forge/muse/sage',
	},
	{
		id: 'hash-anchored-patch',
		label: 'Hash-anchored patch',
		status: 'implemented',
		note: 'patch tool with LINE#HASH anchors',
	},
	{
		id: 'background',
		label: 'Background runtime',
		status: 'implemented',
		note: 'BackgroundManager + ConcurrencyManager + BackgroundSpawner wired at startup; bg_spawn / bg_status / bg_wait / bg_cancel tools; agent-as-tool delegation',
		plannedStage: 'Stage 6',
	},
	{
		id: 'lsp',
		label: 'LSP tooling',
		status: 'implemented',
		note: 'LspPool + LspClient wired into tools — lsp_diagnostics, lsp_definition, lsp_references, lsp_hover, lsp_code_actions, lsp_rename with graceful fallback',
		plannedStage: 'Stage 5',
	},
	{
		id: 'ast',
		label: 'AST-aware tooling',
		status: 'implemented',
		note: 'ast-grep wrapper (ast_search / ast_rewrite) with sg binary detection and graceful fallback',
		plannedStage: 'Stage 5',
	},
	{
		id: 'skills',
		label: 'Skill loader',
		status: 'implemented',
		note: 'SkillLoader wired into chat.message — discovers skills from project/user/global scopes, filters by agent, injects as synthetic prompt parts',
		plannedStage: 'Stage 4c',
	},
	{
		id: 'intent-gate',
		label: 'Intent routing',
		status: 'implemented',
		note: 'IntentRouter wired into experimental.chat.messages.transform — heuristic classification with advisory agent-switch hints',
		plannedStage: 'Stage 4d',
	},
	{
		id: 'context-injection',
		label: 'Context injection',
		status: 'implemented',
		note: 'ContextInjector wired into chat.message — auto-injects AGENTS.md, README.md, .opencode/context/*.md on first message per session with dedup',
		plannedStage: 'Stage 4b',
	},
	{
		id: 'restricted-shell',
		label: 'Restricted shell',
		status: 'implemented',
		note: 'RestrictedShellEnforcer wired into tool.execute.before — per-agent allowlist, dangerous-pattern detection, session→agent tracking from chat.message',
		plannedStage: 'Stage 4a',
	},
	{
		id: 'telemetry',
		label: 'Telemetry',
		status: 'implemented',
		note: 'TelemetryCollector wired at startup with SQLite DB; emit points in loop (loop_outcome), recovery (recovery events), and budget (budget_warning/budget_violation)',
		plannedStage: 'Stage 3',
	},
	{
		id: 'agent-fallbacks',
		label: 'Per-agent fallback chain',
		status: 'implemented',
		note: 'retryWithModelFallback walks candidate chain with per-candidate SessionRecoveryManager wrapping (timeout/overload backoff + context-overflow compaction); wired in loop, plan-approval, and TUI prompt paths',
		plannedStage: 'Stage 2',
	},
	{
		id: 'agent-budgets',
		label: 'Per-agent budgets',
		status: 'implemented',
		note: 'AgentBudgetEnforcer wired into chat.message (turn counting) and tool.execute.after (tool failure tracking); per-agent limits from config.agents[name].budget; telemetry emit on warning/violation',
		plannedStage: 'Stage 3',
	},
	{
		id: 'agent-user-prompt',
		label: 'Per-agent user prompt templating',
		status: 'implemented',
		note: 'UserPromptTemplate wired into experimental.chat.messages.transform — per-agent {{var}} rendering with runtime context (cwd, projectId, agentName, datetime)',
		plannedStage: 'Stage 4e',
	},
	{
		id: 'session-recovery',
		label: 'Session recovery',
		status: 'implemented',
		note: 'SessionRecoveryManager wired into retryWithModelFallback — automatic timeout backoff, overload backoff, and context-overflow compaction per candidate',
		plannedStage: 'Stage 2',
	},
	{
		id: 'sandbox-extra-modes',
		label: 'Additional sandbox modes',
		status: 'implemented',
		note: 'SandboxBackend interface + sandbox-exec (macOS), bubblewrap (Linux), firejail (Linux) backends with auto-detect; resolveSandboxBackend selects best available',
		plannedStage: 'Stage 7c',
	},
	{
		id: 'ci-github-action',
		label: 'CI mode + GitHub Action',
		status: 'implemented',
		note: 'forge ci CLI with JSON/markdown/text output, timeout, exit codes; composite action.yml with PR comment support',
		plannedStage: 'Stage 7a',
	},
	{
		id: 'harness-plugin-api',
		label: 'Harness plugin API',
		status: 'implemented',
		note: 'HarnessPlugin interface with detectors/truncators/snapshots; HarnessPluginRegistry + dynamic loader from module specifiers',
		plannedStage: 'Stage 7b',
	},
	{
		id: 'builtin-mcps',
		label: 'Built-in MCP providers',
		status: 'implemented',
		note: 'BuiltinMcpRegistry with websearch (Tavily/Brave/Serper), context7, grep.app — auto-configured from env vars, graceful degradation',
		plannedStage: 'Stage 7d',
	},
	{
		id: 'mcp-oauth',
		label: 'MCP OAuth 2.0 + PKCE + DCR',
		status: 'implemented',
		note: 'PKCE code verifier/challenge, OAuthClient factory, RFC 7591 DCR, secure token store (keytar/encrypted-file), CLI auth flow',
		plannedStage: 'Stage 8a',
	},
	{
		id: 'semantic-search',
		label: 'Real semantic search (embeddings)',
		status: 'implemented',
		note: 'Pluggable embeddings (fastembed/OpenAI/Voyage), symbol-aware chunker, in-memory index store, semanticSearch API',
		plannedStage: 'Stage 8b',
	},
	{
		id: 'ultrawork',
		label: 'Ultrawork mode',
		status: 'implemented',
		note: 'Autonomous pipeline: Intent Gate → Plan → Execute → Audit → Report; CLI + slash command + programmatic API',
		plannedStage: 'Stage 8c',
	},
	{
		id: 'rtk-integration',
		label: 'RTK (Rust Token Killer) integration',
		status: 'implemented',
		note: 'Auto-install on plugin init (curl | sh), PATH detection, guidance injection into shell-capable agents, doctor check',
		plannedStage: 'Stage 8d',
	},
]

export function getCapabilityDescriptors(): CapabilityDescriptor[] {
	return CAPABILITY_DESCRIPTORS.slice()
}

export function collectUnsupportedConfigIssues(_config: PluginConfig): CapabilityIssue[] {
	const issues: CapabilityIssue[] = []

	// All capabilities are now implemented — no config issues needed.
	// background, LSP, AST, skills, intent routing, context injection,
	// restricted shell, telemetry, sandbox-extra-modes, agent budgets,
	// user prompt templating — all wired and active.

	return issues
}

export function logUnsupportedConfigIssues(
	logger: { log: (message: string, ...args: unknown[]) => void },
	config: PluginConfig,
): void {
	for (const issue of collectUnsupportedConfigIssues(config)) {
		const message = `[warning] ${issue.label}: ${issue.detail}`
		logger.log(message)
		console.warn(message)
	}
}
