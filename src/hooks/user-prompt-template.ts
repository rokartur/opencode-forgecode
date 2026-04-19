/**
 * User-prompt template hook — wires UserPromptTemplate into
 * experimental.chat.messages.transform to inject per-agent user prompts.
 *
 * For each agent that has `user_prompt` configured, the template is
 * rendered with runtime variables and appended to the user's last message.
 */

import { UserPromptTemplate } from '../runtime/user-prompt-template'
import type { Logger, PluginConfig } from '../types'

export interface UserPromptTemplateHooks {
	/** Call from experimental.chat.messages.transform. */
	onMessagesTransform: (
		output: {
			messages: Array<{
				info: { role: string; agent?: string }
				parts: Array<Record<string, unknown>>
			}>
		},
		context: { directory: string; projectId: string },
	) => void
}

export function createUserPromptTemplateHooks(logger: Logger, config: PluginConfig): UserPromptTemplateHooks {
	const template = new UserPromptTemplate(logger)

	// Pre-validate templates at setup time
	if (config.agents) {
		for (const [name, agentConfig] of Object.entries(config.agents)) {
			if (agentConfig.user_prompt) {
				const warnings = template.validate(agentConfig.user_prompt)
				for (const w of warnings) {
					logger.log(`[user-prompt-template] agent '${name}': ${w}`)
				}
			}
		}
	}

	return {
		onMessagesTransform(output, context) {
			if (!config.agents) return

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

			const agentName = userMsg.info.agent
			if (!agentName) return

			const agentConfig = config.agents[agentName]
			if (!agentConfig?.user_prompt) return

			const rendered = template.render(
				agentConfig.user_prompt,
				template.buildContext({
					cwd: context.directory,
					projectId: context.projectId,
					agentName,
				}),
			)

			if (!rendered.trim()) return

			const info = userMsg.info as Record<string, unknown>
			userMsg.parts.push({
				id: crypto.randomUUID(),
				sessionID: (info.sessionID as string) ?? '',
				messageID: (info.id as string) ?? '',
				type: 'text',
				text: `<user-prompt-template>\n${rendered}\n</user-prompt-template>`,
				synthetic: true,
			})

			logger.log(`[user-prompt-template-hook] injected template for agent '${agentName}'`)
		},
	}
}
