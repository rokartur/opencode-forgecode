/**
 * Scope for memory entries used in RAG-style memory injection.
 */
export type MemoryScope = 'convention' | 'decision' | 'context'

/**
 * A memory entry stored for retrieval-augmented generation.
 */
export interface Memory {
	id: number
	projectId: string
	scope: MemoryScope
	content: string
	filePath: string | null
	accessCount: number
	lastAccessedAt: number | null
	createdAt: number
	updatedAt: number
}

/**
 * Input for creating a new memory entry.
 */
export interface CreateMemoryInput {
	projectId: string
	scope: MemoryScope
	content: string
	filePath?: string
}

/**
 * Input for updating an existing memory entry.
 */
export interface UpdateMemoryInput {
	content?: string
	scope?: MemoryScope
}

/**
 * A memory entry with its similarity distance from a query.
 */
export interface MemorySearchResult {
	memory: Memory
	distance: number
}

/**
 * Statistics about memory usage for a project.
 */
export interface MemoryStats {
	projectId: string
	total: number
	byScope: Record<MemoryScope, number>
}

/**
 * Configuration for plugin logging.
 */
export interface LoggingConfig {
	/** Enable file logging. */
	enabled: boolean
	/** Path to the log file. */
	file: string
	/** Enable verbose debug logging. */
	debug?: boolean
}

/**
 * Logger interface for plugin-wide logging.
 */
export interface Logger {
	log: (message: string, ...args: unknown[]) => void
	error: (message: string, ...args: unknown[]) => void
	debug: (message: string, ...args: unknown[]) => void
}

/**
 * Configuration for worktree loop completion logging.
 */
export interface WorktreeLoggingConfig {
	/** Enable worktree loop completion logging. Defaults to false. */
	enabled?: boolean
	/** Directory to write completion logs. Defaults to platform data dir. */
	directory?: string
}

/**
 * Configuration for autonomous loop behavior.
 */
export interface LoopConfig {
	/** Enable autonomous loop execution. Defaults to true. */
	enabled?: boolean
	/** Default maximum iterations per loop. */
	defaultMaxIterations?: number
	/** Clean up worktrees when loops complete. */
	cleanupWorktree?: boolean
	/** Enable automatic code auditing after each iteration. */
	defaultAudit?: boolean
	/** Model to use for loop iterations. */
	model?: string
	/** Timeout in ms before considering a loop stalled. */
	stallTimeoutMs?: number
	/** Minimum number of audits before a loop can complete. */
	minAudits?: number
	/** Worktree loop completion logging configuration. */
	worktreeLogging?: WorktreeLoggingConfig
	/** First-class success criteria — loop completion is gated on these commands passing. */
	successCriteria?: LoopSuccessCriteria
	/** Per-loop budget constraints. */
	budget?: LoopBudgetConfig
}

/**
 * Success criteria that must pass before a loop can complete.
 * Each command is run in the loop's working directory; a non-zero exit code
 * means the criterion is not met.
 */
export interface LoopSuccessCriteria {
	/** Test command, e.g. "bun test" or "npm test". */
	tests?: string
	/** Lint command, e.g. "bun run check" or "eslint .". */
	lint?: string
	/** Additional custom commands. */
	custom?: string[]
}

/**
 * Per-loop budget constraints.  When any limit is hit the loop terminates
 * with a budget-exceeded report.
 */
export interface LoopBudgetConfig {
	/** Maximum input + output tokens across all iterations. */
	maxTokens?: number
	/** Maximum cost in USD across all iterations. */
	maxCostUsd?: number
	/** Hard cap on iterations (overrides defaultMaxIterations if set). */
	maxIterations?: number
}

/**
 * Configuration for sandbox execution environment.
 */
export interface SandboxConfig {
	/** Sandbox mode - 'off' disables sandboxing, other backends enable it. */
	mode: 'off' | 'docker' | 'sandbox-exec' | 'bubblewrap' | 'auto'
	/** Docker image to use for sandboxed execution. */
	image?: string
}

/**
 * Configuration for background task execution.
 */
export interface BackgroundConfig {
	/** Enable background task runtime. */
	enabled?: boolean
	/** Maximum concurrent background tasks across all models. */
	maxConcurrent?: number
	/** Maximum concurrent tasks per model/provider. */
	perModelLimit?: number
	/** Poll interval for task status updates. */
	pollIntervalMs?: number
	/** Idle timeout used to auto-complete unchanged tasks. */
	idleTimeoutMs?: number
}

/**
 * Configuration for LSP integration.
 */
export interface LspConfig {
	/** Enable LSP tooling. */
	enabled?: boolean
	/** Command map per language/server key. */
	servers?: Record<string, string>
}

/**
 * Configuration for AST-aware tools.
 */
export interface AstConfig {
	/** Enable AST-aware tooling. */
	enabled?: boolean
	/** Binary to use for ast-grep operations. */
	binary?: string
}

/**
 * Configuration for runtime skill loading.
 */
export interface SkillsConfig {
	/** Enable automatic skill discovery/loading. */
	enabled?: boolean
	/** Explicit scope directories to scan. */
	scopes?: string[]
}

/**
 * Configuration for intent classification before routing.
 */
export interface IntentGateConfig {
	/** Enable intent classification. */
	enabled?: boolean
	/** Optional lightweight model used for ambiguous prompts. */
	model?: string
	/** Disable LLM fallback and use heuristics only. */
	heuristicsOnly?: boolean
	/**
	 * Gate mode:
	 * - 'advise' (default): appends a system hint suggesting the right agent
	 * - 'gate': blocks mismatched agent execution with a redirect message
	 */
	mode?: 'advise' | 'gate'
	/** Minimum confidence threshold to trigger a redirect. Default: 0.5. */
	confidenceThreshold?: number
}

/**
 * Configuration for the comment checker (anti-AI-slop).
 */
export interface CommentCheckerConfig {
	/** Enable comment checking on write/edit/patch output. Default: true. */
	enabled?: boolean
	/** Minimum violations to trigger a warning. Default: 2. */
	minViolations?: number
	/** Severity: 'warn' emits advisory, 'block' rejects the output. Default: 'warn'. */
	severity?: 'warn' | 'block'
}

/**
 * Rule for conditionally injecting extra context.
 */
export interface ContextInjectionRule {
	/** Glob pattern to match touched files. */
	glob: string
	/** Instruction text appended when the rule matches. */
	instruction: string
}

/**
 * Configuration for context injection.
 */
export interface ContextInjectionConfig {
	/** Enable context injection on session start. */
	enabled?: boolean
	/** Static files to inject. */
	files?: string[]
	/** Conditional rules keyed by file globs. */
	conditionalRules?: ContextInjectionRule[]
}

/**
 * Configuration for restricted shell enforcement.
 */
export interface RestrictedShellConfig {
	/** Enable shell command allowlisting. */
	enabled?: boolean
	/** Allowlist entries per agent display name/id. */
	whitelist?: Record<string, string[]>
}

/**
 * Configuration for local-only telemetry.
 */
export interface TelemetryConfig {
	/** Enable local telemetry collection. */
	enabled?: boolean
	/** Retention window for telemetry cleanup. */
	retentionDays?: number
}

/**
 * MCP server authentication and management configuration.
 */
export interface McpConfig {
	/** Registered MCP servers. */
	servers?: McpServerEntry[]
}

export interface McpServerEntry {
	/** Human-readable server name. */
	name: string
	/** Server base URL. */
	url: string
	/** Authentication method. */
	auth?: 'oauth' | 'none'
	/** Pre-configured client_id (skips DCR). */
	clientId?: string
	/** Scopes to request during OAuth. */
	scopes?: string[]
}

/**
 * Embeddings / semantic search configuration.
 */
export interface EmbeddingsConfig {
	/** Enable embedding-based semantic search. */
	enabled?: boolean
	/** Embedding provider to use. */
	provider?: 'fastembed' | 'openai' | 'voyage'
	/** Model name for the provider. */
	model?: string
	/** API key (for OpenAI/Voyage). Auto-detected from env if omitted. */
	apiKey?: string
	/** Max batch size for embedding calls. */
	batchSize?: number
}

/**
 * Ultrawork mode configuration.
 */
export interface UltraworkConfig {
	/** Enable ultrawork CLI command. Default: true. */
	enabled?: boolean
	/** Max pipeline steps before forced stop. Default: 50. */
	maxSteps?: number
	/** Auto-approve changes between pipeline stages. Default: true. */
	autoApprove?: boolean
}

/**
 * RTK (Rust Token Killer) CLI proxy configuration.
 *
 * RTK is a token-optimized shell command proxy that filters noisy output
 * before it reaches the model. When enabled, agents are instructed to
 * prefix shell commands with `rtk` (e.g. `rtk git status`).
 *
 * See https://github.com/rtk-ai/rtk for details.
 */
export interface RtkConfig {
	/**
	 * Enable RTK integration. Default: true.
	 *
	 * When enabled:
	 * - A system-reminder is injected into sessions for agents that use
	 *   the bash tool, instructing them to prefix commands with `rtk`.
	 * - `doctor` runs a PATH check for the `rtk` binary.
	 */
	enabled?: boolean
	/**
	 * Automatically install RTK on first plugin load when the binary is
	 * missing from PATH. Runs the upstream install script
	 * (`curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh`).
	 *
	 * Default: true. Set to false to disable the auto-installer (for
	 * air-gapped or policy-restricted environments).
	 */
	autoInstall?: boolean
	/**
	 * Override the install script URL. Defaults to the upstream RTK
	 * installer at github.com/rtk-ai/rtk.
	 */
	installUrl?: string
}

/**
 * Config entry for a model fallback step.
 */
export interface FallbackEntry {
	/** Model identifier in provider/model form. */
	model: string
	/** Optional temperature override. */
	temperature?: number
	/** Optional max token override. */
	maxTokens?: number
}

/**
 * Per-agent runtime budget limits.
 */
export interface AgentBudget {
	/** Maximum turns per session. */
	maxTurns?: number
	/** Maximum tool failures allowed within a turn. */
	maxToolFailuresPerTurn?: number
	/** Maximum requests allowed within a turn. */
	maxRequestsPerTurn?: number
	/** Maximum tokens allowed within a session. */
	maxTokensPerSession?: number
}

/**
 * Filter options for listing memories.
 */
export interface ListMemoriesFilter {
	scope?: MemoryScope
	limit?: number
	offset?: number
}

/**
 * Configuration for session compaction behavior.
 */
export interface CompactionConfig {
	/** Use a custom compaction prompt. */
	customPrompt?: boolean
	/** Maximum context tokens for compaction. */
	maxContextTokens?: number
}

/**
 * Configuration for memory injection into context.
 * @deprecated Use defaultKvTtlMs in root config instead
 */
export interface MemoryInjectionConfig {
	/** Enable memory injection. */
	enabled?: boolean
	/** Maximum number of memory results to inject. */
	maxResults?: number
	/** Maximum similarity distance threshold. */
	distanceThreshold?: number
	/** Maximum tokens to inject. */
	maxTokens?: number
	/** @deprecated Use defaultKvTtlMs in root config instead */
	cacheTtlMs?: number
	/** Enable debug logging for memory injection. */
	debug?: boolean
}

/**
 * Configuration for message transformation in architect sessions.
 */
export interface MessagesTransformConfig {
	/** Enable message transformation. Defaults to true. */
	enabled?: boolean
	/** Enable debug logging. */
	debug?: boolean
}

/**
 * Configuration for TUI display options.
 */
export interface TuiConfig {
	/** Show sidebar. */
	sidebar?: boolean
	/** Show active loops in TUI. */
	showLoops?: boolean
	/** Show version information. */
	showVersion?: boolean
	/** Keyboard shortcut overrides for Forge commands. */
	keybinds?: {
		/** View plan dialog. Default: Meta+Shift+P */
		viewPlan?: string
		/** Execute plan dialog. Default: Meta+Shift+E */
		executePlan?: string
		/** Show loops dialog. Default: Meta+Shift+L */
		showLoops?: string
	}
}

/**
 * Per-agent configuration overrides.
 */
export interface AgentOverrideConfig {
	/** Override default model temperature. */
	temperature?: number
	/** Override primary model. */
	model?: string
	/** Override fallback chain for this agent. */
	fallback_models?: Array<string | FallbackEntry>
	/** Runtime safety / budget limits for this agent. */
	budget?: AgentBudget
	/** Optional user prompt template. */
	user_prompt?: string
}

/**
 * Configuration for code graph indexing and queries.
 */
export interface GraphConfig {
	/** Enable graph indexing. Defaults to true. */
	enabled?: boolean
	/** Auto-check existing graph cache on startup and scan only when missing/stale. Defaults to true. */
	autoScan?: boolean
	/** Watch filesystem for changes. */
	watch?: boolean
	/** Debounce delay in ms for file change events. */
	debounceMs?: number
}

/**
 * Configuration for the forge harness (system-prompt partials, summary-frame
 * compaction, truncation, doom-loop detection, pending-todo reminders, and
 * filesystem snapshots used by the fs_undo tool).
 */
export interface HarnessConfig {
	/** Enable the harness module. Defaults to true. */
	enabled?: boolean
	/**
	 * Number of consecutive identical tool-call patterns required to trigger a
	 * doom-loop reminder. Defaults to 3.
	 */
	doomLoopThreshold?: number
	/** Emit a reminder when a session idles with open todos. Defaults to true. */
	pendingTodosReminder?: boolean
	/**
	 * Record `.bak` snapshots before mutating tools run so `fs_undo` can roll
	 * them back. Defaults to true.
	 */
	snapshots?: boolean
	/**
	 * Replace the default compaction prompt with a forge summary-frame. Defaults
	 * to true.
	 */
	compaction?: boolean
	/** Per-tool output truncation settings. */
	truncation?: {
		/** Enable output truncation. Defaults to true. */
		enabled?: boolean
	}
	/** Enable the hash-anchored patch tool. Defaults to true. */
	hashAnchoredPatch?: boolean
	/**
	 * Array of module specifiers for harness plugins.
	 * Each specifier is either a relative path or an npm package name that
	 * exports a `HarnessPlugin` object.
	 */
	plugins?: string[]
}

/**
 * Complete plugin configuration for opencode-forge.
 */
export interface PluginConfig {
	/** Custom data directory for plugin storage. Defaults to platform data dir. */
	dataDir?: string
	/** Logging configuration. */
	logging?: LoggingConfig
	/** Compaction behavior configuration. */
	compaction?: CompactionConfig
	/** Message transformation for architect agent. */
	messagesTransform?: MessagesTransformConfig
	/** Model to use for code execution. */
	executionModel?: string
	/** Model to use for code auditing. */
	auditorModel?: string
	/** Loop behavior configuration. */
	loop?: LoopConfig
	/** @deprecated Use `loop` instead */
	ralph?: LoopConfig
	/** Default TTL for KV entries in milliseconds. */
	defaultKvTtlMs?: number
	/** TUI display configuration. */
	tui?: TuiConfig
	/** Per-agent configuration overrides. */
	agents?: Record<string, AgentOverrideConfig>
	/** Sandbox execution configuration. */
	sandbox?: SandboxConfig
	/** Graph indexing configuration. */
	graph?: GraphConfig
	/** Forge harness configuration. */
	harness?: HarnessConfig
	/** Background task runtime configuration. */
	background?: BackgroundConfig
	/** LSP integration configuration. */
	lsp?: LspConfig
	/** AST-aware tooling configuration. */
	ast?: AstConfig
	/** Skill loading configuration. */
	skills?: SkillsConfig
	/** Intent routing / gate configuration. */
	intentGate?: IntentGateConfig
	/** Comment checker (anti-AI-slop) configuration. */
	commentChecker?: CommentCheckerConfig
	/** Context injection configuration. */
	contextInjection?: ContextInjectionConfig
	/** Restricted shell configuration. */
	restrictedShell?: RestrictedShellConfig
	/** Local telemetry configuration. */
	telemetry?: TelemetryConfig
	/** MCP server authentication configuration. */
	mcp?: McpConfig
	/** Embeddings / semantic search configuration. */
	embeddings?: EmbeddingsConfig
	/** Ultrawork mode configuration. */
	ultrawork?: UltraworkConfig
	/** RTK (Rust Token Killer) CLI proxy configuration. */
	rtk?: RtkConfig
	/** Host-side fast-path tool configuration (ripgrep-based grep/glob). */
	host?: HostConfig
}

/**
 * Host-side tool interception configuration.
 */
export interface HostConfig {
	/**
	 * When true and `rg` is on PATH, intercept `grep` / `glob` tool calls and
	 * serve them via ripgrep with grouped, submatch-windowed output. Defaults
	 * to true.
	 */
	fastGrep?: boolean
}

/**
 * Export format for memories and data.
 */
export type ExportFormat = 'json' | 'markdown'

/**
 * Options for exporting memories or other data.
 */
export interface ExportOptions {
	/** Export format. Defaults to 'json'. */
	format?: ExportFormat
	/** Output file path. */
	output?: string
	/** Project ID to export from. */
	projectId?: string
	/** Filter by memory scope. */
	scope?: MemoryScope
	/** Maximum number of entries to export. */
	limit?: number
	/** Offset for pagination. */
	offset?: number
	/** Path to database file. */
	dbPath?: string
}

/**
 * Options for importing data.
 */
export interface ImportOptions {
	/** Import format. Defaults to 'json'. */
	format?: ExportFormat
	/** Target project ID. */
	projectId: string
	/** Overwrite existing entries. */
	force?: boolean
	/** Path to database file. */
	dbPath?: string
}
