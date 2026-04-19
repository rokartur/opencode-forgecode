/**
 * Built-in Context7 MCP provider — documentation lookup.
 *
 * Context7 provides library/framework documentation via their API.
 * Requires CONTEXT7_API_KEY environment variable.
 *
 * Gracefully returns empty results when not configured.
 */

import type { McpDocResult, BuiltinMcpProvider } from './types'

export interface Context7Mcp extends BuiltinMcpProvider {
	/** Look up documentation for a library or concept. */
	lookup(query: string, library?: string): Promise<McpDocResult[]>
}

export function createContext7Mcp(explicitKey?: string): Context7Mcp {
	const apiKey = explicitKey ?? process.env.CONTEXT7_API_KEY

	return {
		name: 'context7',

		isConfigured(): boolean {
			return !!apiKey
		},

		async init(): Promise<void> {
			if (!apiKey) {
				throw new Error('Context7 not configured. Set CONTEXT7_API_KEY environment variable.')
			}
		},

		async lookup(query: string, library?: string): Promise<McpDocResult[]> {
			if (!apiKey) return []

			try {
				const params = new URLSearchParams({ query })
				if (library) params.set('library', library)

				const res = await fetch(`https://api.context7.com/v1/docs?${params}`, {
					headers: {
						Authorization: `Bearer ${apiKey}`,
						Accept: 'application/json',
					},
				})

				if (!res.ok) return []

				const data = (await res.json()) as {
					results?: Array<{ title: string; content: string; url?: string }>
				}

				return (data.results ?? []).map(r => ({
					title: r.title,
					content: r.content?.slice(0, 2000) ?? '',
					url: r.url,
				}))
			} catch {
				return []
			}
		},
	}
}
