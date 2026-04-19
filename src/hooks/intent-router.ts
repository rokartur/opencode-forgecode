/**
 * IntentGate hook — wires the multi-signal IntentRouter into
 * experimental.chat.messages.transform.
 *
 * Two modes:
 *   - 'advise' (default): appends a system hint suggesting a better agent
 *   - 'gate': replaces the user message with a redirect notice
 *
 * Default: disabled. Enable via `intentGate.enabled: true`.
 */

import { IntentRouter } from '../runtime/intent-router'
import type { Logger, PluginConfig } from '../types'

export interface IntentRouterHooks {
	/** Call from experimental.chat.messages.transform. */
	onMessagesTransform: (output: {
		messages: Array<{
			info: { role: string; agent?: string }
			parts: Array<Record<string, unknown>>
		}>
	}) => void
}

export function createIntentRouterHooks(logger: Logger, config: PluginConfig): IntentRouterHooks {
	const router = new IntentRouter(logger, config.intentGate)
	const mode = config.intentGate?.mode ?? 'advise'

	return {
		onMessagesTransform(output) {
			if (!router.isEnabled()) return

			const messages = output.messages
			// Find last user message
			let userMsg: (typeof messages)[number] | undefined
			for (let i = messages.length - 1; i >= 0; i--) {
				if (messages[i].info.role === 'user') {
					userMsg = messages[i]
					break
				}
			}
			if (!userMsg) return

			// Extract text from parts
			const text = userMsg.parts
				.filter(p => p.type === 'text' && typeof p.text === 'string' && !p.synthetic)
				.map(p => p.text as string)
				.join(' ')

			if (!text) return

			const currentAgent = userMsg.info.agent
			if (!currentAgent) return

			const decision = router.gate(text, currentAgent)

			if (decision.pass) return

			const { classification, redirectMessage } = decision

			logger.log(
				`[intent-gate] ${mode} redirect: current=${currentAgent} suggested=${classification.agent} tag=${classification.tag} confidence=${classification.confidence.toFixed(2)} complexity=${classification.complexity}`,
			)

			const info = userMsg.info as Record<string, unknown>

			if (mode === 'gate') {
				// Gate mode: replace user message parts with redirect notice
				userMsg.parts.push({
					id: crypto.randomUUID(),
					sessionID: (info.sessionID as string) ?? '',
					messageID: (info.id as string) ?? '',
					type: 'text',
					text: `<system-gate>\n${redirectMessage}\n\nPlease inform the user about this recommendation and ask if they want to switch agents. Do NOT proceed with the original request until the user confirms.\n</system-gate>`,
					synthetic: true,
				})
			} else {
				// Advise mode: append advisory hint
				userMsg.parts.push({
					id: crypto.randomUUID(),
					sessionID: (info.sessionID as string) ?? '',
					messageID: (info.id as string) ?? '',
					type: 'text',
					text: `<system-hint>${redirectMessage}\nConsider suggesting the user switch agents if appropriate.</system-hint>`,
					synthetic: true,
				})
			}
		},
	}
}
