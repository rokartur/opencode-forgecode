/**
 * Skill loader hook — wires SkillLoader into chat.message to inject
 * applicable skills as synthetic prompt parts per session+agent.
 *
 * Skills are discovered on first call and cached. The hook filters
 * skills by agent name and injects their formatted body.
 */

import { SkillLoader } from '../runtime/skill-loader'
import type { Logger, PluginConfig } from '../types'

export interface SkillLoaderHooks {
	/** Call from chat.message to inject skills for the current agent. */
	onMessage: (
		input: { sessionID: string; messageID?: string; agent?: string },
		output: { parts: Array<Record<string, unknown>> },
	) => void
}

export function createSkillLoaderHooks(logger: Logger, directory: string, config: PluginConfig): SkillLoaderHooks {
	const loader = new SkillLoader(logger, directory, config.skills)
	const injectedSessions = new Set<string>()

	return {
		onMessage(input, output) {
			if (!loader.isEnabled()) return
			// Inject once per session
			if (injectedSessions.has(input.sessionID)) return
			injectedSessions.add(input.sessionID)

			const agentName = input.agent ?? 'forge'
			const skills = loader.getForAgent(agentName)
			if (skills.length === 0) return

			const formatted = loader.formatForPrompt(skills)
			if (!formatted) return

			output.parts.unshift({
				id: crypto.randomUUID(),
				sessionID: input.sessionID,
				messageID: input.messageID ?? '',
				type: 'text',
				text: formatted,
				synthetic: true,
			})

			logger.log(
				`[skill-loader-hook] injected ${skills.length} skill(s) for agent '${agentName}' in session ${input.sessionID}`,
			)
		},
	}
}
