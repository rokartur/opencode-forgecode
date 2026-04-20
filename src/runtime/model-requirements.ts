/**
 * Per-agent model fallback chains.
 *
 * Mirrors the design of oh-my-opencode's `src/shared/model-requirements.ts`:
 * each agent has an ordered list of chain entries. Each entry declares a set
 * of acceptable providers for the SAME model name — the first provider in
 * the user's available set wins. The overall chain is walked top-to-bottom
 * until an entry matches; subsequent matches form the `fallback_models`
 * array.
 *
 * The provider set is derived either from:
 *   - the interactive `setup-models install` CLI (user answers yes/no to
 *     "do you have a <provider> subscription?"), OR
 *   - the opencode server's `/provider` response (`connected` list) at
 *     plugin startup.
 */

export interface ChainEntry {
	/**
	 * Providers that carry this model (ordered by preference). The first
	 * provider from this list that is in the user's set is picked.
	 */
	providers: string[]
	/** Model id (without provider prefix). */
	model: string
	/** Optional variant name (e.g. "high", "max"). */
	variant?: string
	/** Optional notes, surfaced in CLI output. */
	notes?: string
}

export interface AgentChain {
	/** Short role description — shown in CLI. */
	rationale: string
	/** Ordered fallback entries. */
	chain: ChainEntry[]
}

/**
 * Known opencode provider ids. Kept as a closed enum here to prevent typos
 * in chain definitions — unknown ids would silently never match.
 */
export const SUPPORTED_PROVIDERS = [
	'anthropic',
	'openai',
	'google',
	'github-copilot',
	'opencode', // OpenCode Zen
	'opencode-go',
	'zai-coding-plan',
	'ollama-cloud',
] as const

export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number]

/**
 * Subscription questions asked by the interactive installer. Order is the
 * order the user sees.
 */
export interface SubscriptionQuestion {
	id: SupportedProvider
	label: string
	hint?: string
}

export const SUBSCRIPTION_QUESTIONS: SubscriptionQuestion[] = [
	{ id: 'anthropic', label: 'Claude Pro/Max' },
	{ id: 'openai', label: 'OpenAI Plus / API' },
	{ id: 'google', label: 'Google Gemini' },
	{ id: 'github-copilot', label: 'GitHub Copilot' },
	{ id: 'opencode', label: 'OpenCode Zen' },
	{ id: 'opencode-go', label: 'OpenCode Go' },
	{ id: 'zai-coding-plan', label: 'Z.ai Coding Plan' },
	{ id: 'ollama-cloud', label: 'Ollama' },
]

/**
 * Per-agent chains. Keyed by agent `displayName` (matches the `agents`
 * object exported from `src/agents`).
 *
 * Design notes:
 *  - `forge` is the coding primary — optimized for top-tier code generation.
 *  - `muse`/`oracle`/`sage` need reasoning — prefer Opus/o-series.
 *  - `explore`/`librarian` are retrieval — prefer fast + cheap.
 *  - Model ids use concrete version numbers (e.g. `claude-opus-4-7`, `gpt-5.4`,
 *    `gemini-3.1-pro-preview`) and are matched as a prefix against the provider's
 *    model catalog, so minor version bumps (e.g. `-8`) are tolerated via
 *    prefix matching.
 */
export const AGENT_CHAINS: Record<string, AgentChain> = {
	forge: {
		rationale: 'Primary coding agent — needs top-tier code generation & tool-calling.',
		chain: [
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-opus-4-7' },
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-sonnet-4-6' },
			{ providers: ['openai', 'github-copilot', 'opencode'], model: 'gpt-5.4', variant: 'high' },
			{ providers: ['zai-coding-plan', 'opencode', 'opencode-go'], model: 'glm-5.1' },
		],
	},
	muse: {
		rationale: 'Planning & brainstorming — reasoning-first, dual-prompt (Claude/GPT).',
		chain: [
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-opus-4-7' },
			{ providers: ['openai', 'github-copilot', 'opencode'], model: 'gpt-5.4', variant: 'high' },
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-sonnet-4-6' },
			{ providers: ['google', 'github-copilot', 'opencode'], model: 'gemini-3.1-pro-preview' },
			{ providers: ['zai-coding-plan', 'opencode', 'opencode-go'], model: 'glm-5.1' },
		],
	},
	sage: {
		rationale: 'Audit/review — prioritizes rigorous reasoning, cost-insensitive.',
		chain: [
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-opus-4-7' },
			{ providers: ['openai', 'github-copilot', 'opencode'], model: 'gpt-5.4', variant: 'high' },
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-sonnet-4-6' },
			{ providers: ['google', 'github-copilot', 'opencode'], model: 'gemini-3.1-pro-preview', variant: 'high' },
			{ providers: ['zai-coding-plan', 'opencode', 'opencode-go'], model: 'glm-5.1' },
		],
	},
	oracle: {
		rationale: 'Architectural questions — GPT-preferred deep reasoning.',
		chain: [
			{ providers: ['openai', 'github-copilot', 'opencode'], model: 'gpt-5.4', variant: 'high' },
			{ providers: ['google', 'github-copilot', 'opencode'], model: 'gemini-3.1-pro-preview', variant: 'high' },
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-opus-4-7' },
			{ providers: ['zai-coding-plan', 'opencode', 'opencode-go'], model: 'glm-5.1' },
		],
	},
	prometheus: {
		rationale: 'Strategic planner — interview mode, builds plan before execution.',
		chain: [
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-opus-4-7' },
			{ providers: ['openai', 'github-copilot', 'opencode'], model: 'gpt-5.4', variant: 'high' },
			{ providers: ['zai-coding-plan', 'opencode', 'opencode-go'], model: 'glm-5.1' },
			{ providers: ['google', 'github-copilot', 'opencode'], model: 'gemini-3.1-pro-preview' },
		],
	},
	metis: {
		rationale: 'Plan consultant — balanced cost/quality.',
		chain: [
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-opus-4-7' },
			{ providers: ['openai', 'github-copilot', 'opencode'], model: 'gpt-5.4', variant: 'high' },
			{ providers: ['zai-coding-plan', 'opencode', 'opencode-go'], model: 'glm-5.1' },
		],
	},
	librarian: {
		rationale: 'Memory retrieval — speed/cost over intelligence. Do NOT upgrade to Opus.',
		chain: [
			{ providers: ['opencode-go'], model: 'minimax-m2.7' },
			{ providers: ['opencode'], model: 'minimax-m2.7-highspeed' },
			{ providers: ['anthropic', 'opencode'], model: 'claude-haiku-4-5' },
			{ providers: ['opencode'], model: 'gpt-5.4-mini' },
			{ providers: ['google', 'github-copilot', 'opencode'], model: 'gemini-3.1-flash-lite-preview' },
		],
	},
	explore: {
		rationale: 'Fast codebase grep — speed is everything. Do NOT upgrade to Opus.',
		chain: [
			{ providers: ['github-copilot', 'xai'], model: 'grok-code-fast-1' },
			{ providers: ['opencode-go'], model: 'minimax-m2.7' },
			{ providers: ['opencode'], model: 'minimax-m2.7-highspeed' },
			{ providers: ['anthropic', 'github-copilot', 'opencode'], model: 'claude-haiku-4-5' },
			{ providers: ['opencode'], model: 'gpt-5.4-mini' },
			{ providers: ['google', 'github-copilot', 'opencode'], model: 'gemini-3.1-flash-lite-preview' },
		],
	},
}
