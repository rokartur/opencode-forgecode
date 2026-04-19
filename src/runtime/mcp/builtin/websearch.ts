/**
 * Built-in web search MCP provider.
 *
 * Wraps multiple web search APIs behind a unified interface:
 *   - Tavily (default): requires TAVILY_API_KEY
 *   - Brave Search: requires BRAVE_SEARCH_API_KEY
 *   - Serper: requires SERPER_API_KEY
 *
 * Gracefully degrades when API key is missing (returns empty results with a notice).
 */

import type { McpSearchResult, BuiltinMcpProvider } from './types'

type WebSearchProvider = 'tavily' | 'brave' | 'serper'

interface WebSearchConfig {
	provider: WebSearchProvider
	apiKey: string
}

export interface WebSearchMcp extends BuiltinMcpProvider {
	search(query: string, maxResults?: number): Promise<McpSearchResult[]>
}

/**
 * Detect configuration from environment variables.
 */
function detectConfig(explicitProvider?: WebSearchProvider, explicitKey?: string): WebSearchConfig | null {
	if (explicitKey && explicitProvider) {
		return { provider: explicitProvider, apiKey: explicitKey }
	}

	// Auto-detect from environment
	const tavily = process.env.TAVILY_API_KEY
	if (tavily) return { provider: 'tavily', apiKey: tavily }

	const brave = process.env.BRAVE_SEARCH_API_KEY
	if (brave) return { provider: 'brave', apiKey: brave }

	const serper = process.env.SERPER_API_KEY
	if (serper) return { provider: 'serper', apiKey: serper }

	return null
}

export function createWebSearchMcp(explicitProvider?: WebSearchProvider, explicitKey?: string): WebSearchMcp {
	const config = detectConfig(explicitProvider, explicitKey)

	return {
		name: 'websearch',

		isConfigured(): boolean {
			return config !== null
		},

		async init(): Promise<void> {
			if (!config) {
				throw new Error(
					'Web search not configured. Set one of: TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, or SERPER_API_KEY.',
				)
			}
		},

		async search(query: string, maxResults = 5): Promise<McpSearchResult[]> {
			if (!config) {
				return []
			}

			switch (config.provider) {
				case 'tavily':
					return searchTavily(config.apiKey, query, maxResults)
				case 'brave':
					return searchBrave(config.apiKey, query, maxResults)
				case 'serper':
					return searchSerper(config.apiKey, query, maxResults)
			}
		},
	}
}

// ── Provider implementations ──────────────────────────────────

async function searchTavily(apiKey: string, query: string, maxResults: number): Promise<McpSearchResult[]> {
	try {
		const res = await fetch('https://api.tavily.com/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				api_key: apiKey,
				query,
				max_results: maxResults,
				include_answer: false,
			}),
		})

		if (!res.ok) return []

		const data = (await res.json()) as { results?: Array<{ title: string; url: string; content: string }> }
		return (data.results ?? []).map(r => ({
			title: r.title,
			url: r.url,
			snippet: r.content?.slice(0, 500) ?? '',
		}))
	} catch {
		return []
	}
}

async function searchBrave(apiKey: string, query: string, maxResults: number): Promise<McpSearchResult[]> {
	try {
		const params = new URLSearchParams({ q: query, count: String(maxResults) })
		const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
			headers: {
				Accept: 'application/json',
				'X-Subscription-Token': apiKey,
			},
		})

		if (!res.ok) return []

		const data = (await res.json()) as {
			web?: { results?: Array<{ title: string; url: string; description: string }> }
		}
		return (data.web?.results ?? []).map(r => ({
			title: r.title,
			url: r.url,
			snippet: r.description?.slice(0, 500) ?? '',
		}))
	} catch {
		return []
	}
}

async function searchSerper(apiKey: string, query: string, maxResults: number): Promise<McpSearchResult[]> {
	try {
		const res = await fetch('https://google.serper.dev/search', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-API-KEY': apiKey,
			},
			body: JSON.stringify({ q: query, num: maxResults }),
		})

		if (!res.ok) return []

		const data = (await res.json()) as {
			organic?: Array<{ title: string; link: string; snippet: string }>
		}
		return (data.organic ?? []).map(r => ({
			title: r.title,
			url: r.link,
			snippet: r.snippet?.slice(0, 500) ?? '',
		}))
	} catch {
		return []
	}
}
