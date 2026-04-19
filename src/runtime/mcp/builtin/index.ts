/**
 * Built-in MCP registry — manages all builtin MCP providers.
 *
 * Initializes providers based on configuration and environment variables,
 * providing graceful degradation when API keys are missing.
 */

import type { Logger } from '../../../types'
import type { BuiltinMcpConfig, BuiltinMcpProvider } from './types'
import { createWebSearchMcp, type WebSearchMcp } from './websearch'
import { createContext7Mcp, type Context7Mcp } from './context7'
import { createGrepAppMcp, type GrepAppMcp } from './grep_app'

export interface BuiltinMcpRegistry {
	websearch: WebSearchMcp | null
	context7: Context7Mcp | null
	grepApp: GrepAppMcp | null
	/** List of all configured (available) providers. */
	configured(): BuiltinMcpProvider[]
	/** Summary of provider statuses. */
	status(): Record<string, boolean>
}

/**
 * Create the builtin MCP registry, initializing providers based on config
 * and environment. Providers that fail to configure are silently disabled.
 */
export function createBuiltinMcpRegistry(config: BuiltinMcpConfig | undefined, logger: Logger): BuiltinMcpRegistry {
	// Web search
	let websearch: WebSearchMcp | null = null
	if (config?.websearch?.enabled !== false) {
		const ws = createWebSearchMcp(config?.websearch?.provider, config?.websearch?.apiKey)
		if (ws.isConfigured()) {
			websearch = ws
			logger.log(`[mcp:builtin] websearch available (provider: ${ws.name})`)
		} else {
			logger.log('[mcp:builtin] websearch not configured (no API key)')
		}
	}

	// Context7
	let context7: Context7Mcp | null = null
	if (config?.context7?.enabled !== false) {
		const c7 = createContext7Mcp(config?.context7?.apiKey)
		if (c7.isConfigured()) {
			context7 = c7
			logger.log('[mcp:builtin] context7 available')
		} else {
			logger.log('[mcp:builtin] context7 not configured (no API key)')
		}
	}

	// grep.app — always available
	let grepApp: GrepAppMcp | null = null
	if (config?.grepApp?.enabled !== false) {
		grepApp = createGrepAppMcp()
		logger.log('[mcp:builtin] grep.app available')
	}

	return {
		websearch,
		context7,
		grepApp,

		configured(): BuiltinMcpProvider[] {
			return [websearch, context7, grepApp].filter(Boolean) as BuiltinMcpProvider[]
		},

		status(): Record<string, boolean> {
			return {
				websearch: websearch?.isConfigured() ?? false,
				context7: context7?.isConfigured() ?? false,
				grepApp: grepApp?.isConfigured() ?? false,
			}
		},
	}
}

export { type WebSearchMcp } from './websearch'
export { type Context7Mcp } from './context7'
export { type GrepAppMcp } from './grep_app'
export { type BuiltinMcpConfig, type BuiltinMcpProvider, type McpSearchResult, type McpDocResult } from './types'
