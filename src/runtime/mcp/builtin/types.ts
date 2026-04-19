/**
 * Built-in MCP type definitions — shared interfaces for all builtin MCP providers.
 *
 * Each builtin MCP is config-disabled by default and gracefully degrades
 * when API keys are missing.
 */

export interface McpSearchResult {
	title: string
	url: string
	snippet: string
}

export interface McpDocResult {
	title: string
	content: string
	url?: string
}

/**
 * A builtin MCP provider that can be queried for results.
 */
export interface BuiltinMcpProvider {
	/** Provider name for logging. */
	readonly name: string
	/** Check if the provider is configured (API key present, etc). */
	isConfigured(): boolean
	/** Initialize the provider. Throws if not configured. */
	init(): Promise<void>
}

/**
 * Configuration for builtin MCP providers.
 */
export interface BuiltinMcpConfig {
	/** Web search provider (Tavily, Brave Search, Serper). */
	websearch?: {
		enabled?: boolean
		provider?: 'tavily' | 'brave' | 'serper'
		apiKey?: string
	}
	/** Context7 documentation lookup. */
	context7?: {
		enabled?: boolean
		apiKey?: string
	}
	/** grep.app code search. */
	grepApp?: {
		enabled?: boolean
	}
}
