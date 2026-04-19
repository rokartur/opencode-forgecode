/**
 * Context injection hook — wires ContextInjector into chat.message
 * to inject project context (AGENTS.md, README.md, .opencode/context/*.md)
 * on the first message of each session.
 */

import { ContextInjector } from '../runtime/context-injection'
import type { Logger, PluginConfig } from '../types'

export interface ContextInjectionHooks {
	/** Call from chat.message to inject context on first message per session. */
	onMessage: (
		input: { sessionID: string; messageID?: string },
		output: { parts: Array<Record<string, unknown>> },
	) => void
}

export function createContextInjectionHooks(
	logger: Logger,
	directory: string,
	config: PluginConfig,
): ContextInjectionHooks {
	const injector = new ContextInjector(logger, directory, config.contextInjection)
	const injectedSessions = new Set<string>()

	return {
		onMessage(input, output) {
			if (!injector.isEnabled()) return
			// Only inject once per session (first message)
			if (injectedSessions.has(input.sessionID)) return
			injectedSessions.add(input.sessionID)

			const result = injector.collect()
			if (result.items.length === 0) return

			const formatted = injector.format(result)
			if (!formatted) return

			// Prepend injected context as a synthetic text part
			output.parts.unshift({
				id: crypto.randomUUID(),
				sessionID: input.sessionID,
				messageID: input.messageID ?? '',
				type: 'text',
				text: formatted,
				synthetic: true,
			})

			logger.log(
				`[context-injection-hook] injected ${result.items.length} item(s) (${result.totalChars} chars) for session ${input.sessionID}`,
			)
			if (result.truncated) {
				logger.log('[context-injection-hook] injection was truncated due to size limit')
			}
		},
	}
}
