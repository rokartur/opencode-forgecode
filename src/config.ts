import type { AgentRole, AgentDefinition, AgentConfig } from './agents'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROMPT_REVIEW = readFileSync(join(__dirname, 'command/template/review.txt'), 'utf-8')

const REPLACED_BUILTIN_AGENTS = ['build', 'plan']

/**
 * Providers for which we proactively set generous SSE/request timeouts so that
 * long reasoning gaps on high-effort models (e.g. gpt-5.4 reasoningEffort=high)
 * don't trip opencode's default stream abort, which surfaces in the TUI as
 * "~ Preparing patch... / Tool execution aborted / The operation timed out".
 *
 * - `timeout` (total request budget): 10 minutes. opencode default is 5 min;
 *   a full high-effort turn with many tool calls can exceed 5 min.
 * - `chunkTimeout` (max silence between SSE chunks): 5 minutes. Observed gaps
 *   between provider chunks on `reasoningEffort: high` regularly exceed 40 s
 *   and can stretch past 2 min on complex tool sequences. 5 min leaves margin
 *   without wedging the CLI forever on a genuinely stuck request.
 *
 * These are applied ONLY when the user has not explicitly configured a value
 * for that provider — we never overwrite an explicit user setting.
 */
const TIMEOUT_DEFAULTS_PROVIDERS = [
	'openai',
	'anthropic',
	'google',
	'google-vertex',
	'openrouter',
	'xai',
	'deepseek',
	'groq',
	'mistral',
	'azure',
	'bedrock',
	'copilot',
	'ollama',
] as const
// ── Long-session timeouts ──────────────────────────────────────────
// Very long sessions (multi-hour coding marathons, complex refactors,
// big loop runs) routinely hit reasoning gaps of 3-5 min on high-effort
// models (gpt-5.4 high, claude-opus, etc.) and total request durations
// well beyond 10 min when many tool calls are chained.
//
//   request  = total wall-clock for a single LLM round-trip (30 min)
//   chunk    = max silence between SSE chunks before abort  (10 min)
//
// These generous defaults prevent "Tool execution aborted / operation
// timed out" mid-stream on long sessions. Users can always tighten
// them via provider.*.options.timeout in opencode.json.
const DEFAULT_REQUEST_TIMEOUT_MS = 1_800_000 // 30 min (was 10 min)
const DEFAULT_CHUNK_TIMEOUT_MS = 600_000 // 10 min silence between SSE chunks (was 5 min)

/**
 * Returns true when the value looks like an intentional, positive timeout
 * the user explicitly configured.  `false`, `null`, `undefined`, `0`, and
 * non-number values are all treated as "not set" so we can inject our
 * generous default.  This prevents configs like `"timeout": false` from
 * silently disabling the safety net.
 */
function isExplicitTimeout(v: unknown): boolean {
	return typeof v === 'number' && v > 0
}

function applyStreamTimeoutDefaults(config: Record<string, unknown>): void {
	const providerSection = (config.provider ?? {}) as Record<string, unknown>

	const ensureProviderTimeouts = (id: string) => {
		const existing = (providerSection[id] ?? {}) as Record<string, unknown>
		const existingOptions = (existing.options ?? {}) as Record<string, unknown>

		// Only fill in values the user didn't set — never overwrite.
		const options: Record<string, unknown> = { ...existingOptions }
		if (!isExplicitTimeout(options.timeout)) options.timeout = DEFAULT_REQUEST_TIMEOUT_MS
		if (!isExplicitTimeout(options.chunkTimeout)) options.chunkTimeout = DEFAULT_CHUNK_TIMEOUT_MS

		providerSection[id] = { ...existing, options }
	}

	// Patch providers already present in the user config (so their options
	// get the missing timeout fields) plus the known-common providers, so new
	// users benefit without having to touch opencode.json.
	const ids = new Set<string>([...Object.keys(providerSection), ...TIMEOUT_DEFAULTS_PROVIDERS])
	for (const id of ids) ensureProviderTimeouts(id)

	config.provider = providerSection
}

/**
 * Vercel AI SDK (used inside opencode's `streamText`) has its OWN
 * chunk/step/request timeouts derived from `streamText({ timeout })`, which
 * are independent from the provider-options `chunkTimeout` we set above.
 * Those surface as a Bun `DOMException: The operation timed out.` after as
 * little as 20–30s of reasoning silence on gpt-5 high.
 *
 * Opencode threads `agent.options` straight into `streamText(...)`, so we
 * also inject a generous `timeout` there for every agent the plugin owns
 * (plus the standard built-ins) unless the user has set their own.
 */
function applyAgentTimeoutDefaults(mergedAgents: Record<string, AgentConfig>): void {
	for (const [name, agentCfg] of Object.entries(mergedAgents)) {
		if (!agentCfg) continue
		const existingOptions = ((agentCfg as unknown as Record<string, unknown>).options ?? {}) as Record<
			string,
			unknown
		>
		if (isExplicitTimeout(existingOptions.timeout)) continue // user wins
		mergedAgents[name] = {
			...(agentCfg as AgentConfig),
			options: {
				...existingOptions,
				// Single scalar covers overall/step/chunk timeouts in AI SDK.
				// 5 minutes between chunks is plenty for reasoningEffort: high.
				timeout: DEFAULT_CHUNK_TIMEOUT_MS,
			},
		} as AgentConfig
	}
}

const ENHANCED_BUILTIN_AGENTS: Record<string, { permission: Record<string, string>; prompt?: string }> = {
	explore: {
		permission: {
			'graph-query': 'allow',
			'graph-symbols': 'allow',
			'graph-analyze': 'allow',
		},
		prompt: `# Graph-first discovery hierarchy
You have access to four graph tools: graph-status, graph-query, graph-symbols, and graph-analyze. Use whichever graph tool best fits the question — these prompts prioritize graph usage without constraining which graph tool you use.

0. **Named-symbol lookup (LSP-first)**: When the question is about a specific named symbol in a supported language (TS/JS/Python/Rust/Go), prefer \`lsp-definition\`, \`lsp-references\`, and \`lsp-hover\` over regex-based grep — LSP is precise and avoids false positives on shared names.
1. **File-level topology**: Use graph-query for structural questions: top_files (most important files), file_symbols (what symbols live in a file), file_deps (what a file depends on), file_dependents (what depends on a file), cochanges (files that change together), blast_radius (impact analysis), packages (external package usage).
2. **Symbol lookup**: Use graph-symbols for symbol-level queries: find (locate a symbol), search (search by pattern), signature (get symbol signature), callers (who calls this), callees (what this calls).
3. **Code quality analysis**: Use graph-analyze for structural quality insights: unused_exports (exported but never imported), duplication (duplicate code structures), near_duplicates (near-duplicate code patterns).
4. **Structural patterns**: Use \`ast-search\` / \`ast-rewrite\` for patterns text-grep cannot express (e.g. "all async fns returning X", multi-site renames).
5. **Direct inspection**: Use Read to inspect the narrowed files directly.
6. **Fallback**: Use Glob/Grep only for literal filename/content searches or when the steps above cannot answer the question.

## General guidelines
- When exploring the codebase, prefer the Task tool to reduce context usage.
- Call multiple tools in a single response when they are independent. Batch tool calls for performance.
- Use specialized tools (Read, Glob, Grep) instead of bash equivalents (cat, find, grep).
- For language/LOC statistics, prefer the \`code-stats\` tool over piping \`find ... | wc -l\`.
- When bash is unavoidable, prefer \`fd\` over \`find\` and \`rg\`/\`git grep\` over plain \`grep\`.
`,
	},
}

const PLUGIN_COMMANDS: Record<string, { template: string; description: string; agent: string; subtask: boolean }> = {
	review: {
		description: 'Run a code review.',
		agent: 'sage',
		subtask: true,
		template: PROMPT_REVIEW,
	},
	loop: {
		description: 'Start an iterative development loop in a worktree',
		agent: 'forge',
		subtask: false,
		template: `## Step 1: Prepare the Plan

Ensure you have a clear implementation plan ready.

## Step 2: Choose Execution Mode

Decide whether to run in:
- Worktree mode (isolated git worktree) for safe experimentation
- In-place mode (current directory) for quick iterations

## Step 3: Execute the Loop

Run \`loop\` with:
- plan: The full implementation plan
- title: A short descriptive title
- worktree: true for worktree mode, false for in-place

The loop will automatically continue through iterations until complete.
Use \`loop-status\` to check progress or \`loop-cancel\` to stop.

$ARGUMENTS`,
	},
	'loop-status': {
		description: 'Check status of all active loops',
		agent: 'forge',
		subtask: false,
		template: `Check the status of all memory loops.

## Step 1: List Active Loops

Run \`loop-status\` with no arguments to list all active loops for the current project.

## Step 2: Get Detailed Status

For each active loop found, run \`loop-status\` with the loop name to get detailed status. Token counts, iterations, last output.

## Step 3: Report

Present a summary showing:
- Total number of active loops
- For each loop: name, status, and any additional details

If no loops are active, report that there are no active loops.

$ARGUMENTS`,
	},
	'loop-cancel': {
		description: 'Cancel the active loop',
		agent: 'forge',
		subtask: false,
		template: `## Step 1: Identify the Loop

Run \`loop-status\` to see all active loops if you don't know the name.

## Step 2: Cancel the Loop

Run \`loop-cancel\` with:
- name: The worktree name of the loop to cancel (optional if only one active)

## Step 3: Verify Cancellation

Confirm the loop was cancelled and check if worktree cleanup is needed.

$ARGUMENTS`,
	},
}

export interface AgentConfigOverride {
	temperature?: number
	/** `providerID/modelID` — becomes the agent's default model. */
	model?: string
}

export function createConfigHandler(
	agents: Record<AgentRole, AgentDefinition>,
	agentOverrides?: Record<string, AgentConfigOverride>,
) {
	return async (config: Record<string, unknown>) => {
		const effectiveAgents = { ...agents }
		if (agentOverrides) {
			for (const [name, overrides] of Object.entries(agentOverrides)) {
				const role = Object.keys(effectiveAgents).find(
					r => effectiveAgents[r as AgentRole].displayName === name,
				) as AgentRole | undefined
				if (role) {
					const { model, temperature } = overrides
					effectiveAgents[role] = {
						...effectiveAgents[role],
						...(temperature !== undefined ? { temperature } : {}),
						// Promote `model` override into the agent's defaultModel so it
						// flows through to OpenCode's `config.agent[name].model`.
						...(model ? { defaultModel: model } : {}),
					}
				}
			}
		}
		const agentConfigs = createAgentConfigs(effectiveAgents)

		const userAgentConfigs = config.agent as Record<string, AgentConfig> | undefined
		const mergedAgents = { ...agentConfigs }

		if (userAgentConfigs) {
			for (const [name, userConfig] of Object.entries(userAgentConfigs)) {
				if (mergedAgents[name]) {
					const existing = mergedAgents[name]
					const mergedTools = { ...existing?.tools, ...userConfig.tools }
					mergedAgents[name] = {
						...existing,
						...userConfig,
						...(Object.keys(mergedTools).length ? { tools: mergedTools } : {}),
					}
				} else {
					mergedAgents[name] = userConfig
				}
			}
		}

		for (const name of REPLACED_BUILTIN_AGENTS) {
			mergedAgents[name] = { ...mergedAgents[name], hidden: true }
		}

		for (const [name, enhancement] of Object.entries(ENHANCED_BUILTIN_AGENTS)) {
			const existing = mergedAgents[name] as AgentConfig | undefined
			const existingPermission = (existing?.permission ?? {}) as Record<string, unknown>
			const existingPrompt = existing?.prompt ?? ''
			const newPrompt = enhancement.prompt
				? existingPrompt
					? `${existingPrompt}\n\n${enhancement.prompt}`
					: enhancement.prompt
				: existingPrompt
			mergedAgents[name] = {
				...existing,
				permission: { ...existingPermission, ...enhancement.permission },
				prompt: newPrompt,
			} as AgentConfig
		}

		applyAgentTimeoutDefaults(mergedAgents)

		config.agent = mergedAgents
		config.default_agent = 'forge'

		// Inject generous SSE/request timeouts so long reasoning gaps on
		// high-effort models (gpt-5.4 high, etc.) don't surface as
		// "Tool execution aborted / operation timed out" mid-stream.
		// Works for any provider and any reasoningEffort level — never
		// overwrites values the user has explicitly configured.
		applyStreamTimeoutDefaults(config)

		// Visible breadcrumb in opencode log so we can confirm this build of
		// the plugin is actually loaded (timestamps alone have been misleading).
		try {
			const providerCount = Object.keys((config.provider as Record<string, unknown>) ?? {}).length
			const agentCount = Object.keys(mergedAgents).length
			console.log(
				`[forge] stream timeouts injected (providers=${providerCount}, agents=${agentCount}, chunk=${DEFAULT_CHUNK_TIMEOUT_MS}ms, request=${DEFAULT_REQUEST_TIMEOUT_MS}ms)`,
			)
		} catch {}

		// Also dump to a file so we can forensically confirm plugin ran
		// and see the shape of the config that went through our hook.
		try {
			const fs = await import('node:fs/promises')
			const os = await import('node:os')
			const path = await import('node:path')
			const dumpDir = path.join(os.homedir(), '.cache', 'opencode-forge')
			await fs.mkdir(dumpDir, { recursive: true })
			const snapshot = {
				ts: new Date().toISOString(),
				providers: Object.fromEntries(
					Object.entries(
						(config.provider as Record<string, { options?: Record<string, unknown> }>) ?? {},
					).map(([k, v]) => [k, v?.options ?? null]),
				),
				agentModels: Object.fromEntries(
					Object.entries(mergedAgents).map(([k, v]) => {
						const a = v as unknown as { model?: string; hidden?: boolean; mode?: string }
						return [k, { model: a.model ?? '(none)', hidden: !!a.hidden, mode: a.mode ?? '?' }]
					}),
				),
				agentTimeouts: Object.fromEntries(
					Object.entries(mergedAgents).map(([k, v]) => {
						const opts = (v as unknown as { options?: Record<string, unknown> }).options
						return [k, opts?.timeout ?? null]
					}),
				),
			}
			await fs.writeFile(path.join(dumpDir, 'last-config.json'), JSON.stringify(snapshot, null, 2))
		} catch {}

		const userCommands = config.command as Record<string, unknown> | undefined
		const mergedCommands: Record<string, unknown> = { ...PLUGIN_COMMANDS }

		if (userCommands) {
			for (const [name, userCommand] of Object.entries(userCommands)) {
				mergedCommands[name] = userCommand
			}
		}

		config.command = mergedCommands
	}
}

function createAgentConfigs(agents: Record<AgentRole, AgentDefinition>): Record<string, AgentConfig> {
	const result: Record<string, AgentConfig> = {}

	for (const agent of Object.values(agents)) {
		const tools: Record<string, boolean> = {}
		if (agent.tools?.include) {
			// Whitelist mode: explicitly enable only listed tools
			for (const tool of agent.tools.include) {
				tools[tool] = true
			}
		}
		if (agent.tools?.exclude) {
			for (const tool of agent.tools.exclude) {
				tools[tool] = false
			}
		}

		result[agent.displayName] = {
			description: agent.description,
			model: agent.defaultModel ?? '',
			prompt: agent.systemPrompt ?? '',
			mode: agent.mode ?? 'subagent',
			...(Object.keys(tools).length > 0 ? { tools } : {}),
			...(agent.variant ? { variant: agent.variant } : {}),
			...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
			...(agent.steps !== undefined ? { steps: agent.steps } : {}),
			...(agent.hidden ? { hidden: agent.hidden } : {}),
			...(agent.color ? { color: agent.color } : {}),
			...(agent.permission ? { permission: agent.permission } : {}),
		}
	}

	return result
}
