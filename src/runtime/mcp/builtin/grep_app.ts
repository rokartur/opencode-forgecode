/**
 * Built-in grep.app MCP provider — public code search.
 *
 * Uses grep.app's public search API (no API key required).
 * Returns code snippets matching the query across open-source repositories.
 *
 * Always available (no API key needed) — gracefully handles rate limits / errors.
 */

import type { McpSearchResult, BuiltinMcpProvider } from './types'

export interface GrepAppMcp extends BuiltinMcpProvider {
	/** Search for code across public repositories. */
	search(query: string, maxResults?: number): Promise<McpSearchResult[]>
}

export function createGrepAppMcp(): GrepAppMcp {
	return {
		name: 'grep_app',

		isConfigured(): boolean {
			return true // No API key required
		},

		async init(): Promise<void> {
			// Nothing to initialize
		},

		async search(query: string, maxResults = 10): Promise<McpSearchResult[]> {
			try {
				const params = new URLSearchParams({ q: query, max: String(maxResults) })
				const res = await fetch(`https://grep.app/api/search?${params}`, {
					headers: {
						Accept: 'application/json',
						'User-Agent': 'opencode-forge/1.0',
					},
				})

				if (!res.ok) return []

				const data = (await res.json()) as {
					hits?: {
						hits?: Array<{
							_source?: {
								repo?: { raw?: string }
								path?: { raw?: string }
								content?: { snippet?: string }
							}
						}>
					}
				}

				return (data.hits?.hits ?? []).slice(0, maxResults).map(hit => {
					const src = hit._source ?? {}
					const repo = src.repo?.raw ?? 'unknown'
					const path = src.path?.raw ?? ''
					const snippet = src.content?.snippet ?? ''

					return {
						title: `${repo}/${path}`,
						url: `https://github.com/${repo}/blob/HEAD/${path}`,
						snippet: snippet.slice(0, 500),
					}
				})
			} catch {
				return []
			}
		},
	}
}
