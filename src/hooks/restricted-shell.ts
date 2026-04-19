/**
 * Restricted shell hook — wires RestrictedShellEnforcer into tool.execute.before
 * to block disallowed commands for the current agent.
 *
 * Since tool.execute.before doesn't receive the agent name, we maintain
 * a lightweight sessionID → agent mapping populated from chat.message.
 */

import { RestrictedShellEnforcer } from '../runtime/restricted-shell'
import type { Logger, PluginConfig } from '../types'

export interface RestrictedShellHooks {
	/** Call from chat.message to record session→agent mapping. */
	trackAgent: (input: { sessionID: string; agent?: string }) => void
	/** Call from tool.execute.before for bash tool commands. */
	toolBefore: (input: { tool: string; sessionID: string; callID: string }, output: { args: unknown }) => void
}

export function createRestrictedShellHooks(logger: Logger, config: PluginConfig): RestrictedShellHooks {
	const enforcer = new RestrictedShellEnforcer(logger, config.restrictedShell)
	const sessionAgents = new Map<string, string>()

	return {
		trackAgent(input) {
			if (input.agent) {
				sessionAgents.set(input.sessionID, input.agent)
			}
		},

		toolBefore(input, output) {
			if (!enforcer.isEnabled()) return
			if (input.tool !== 'bash') return

			const args = output.args as { command?: string } | undefined
			const command = args?.command
			if (!command) return

			const agent = sessionAgents.get(input.sessionID) ?? 'unknown'
			const result = enforcer.check(agent, command, input.sessionID)

			if (!result.allowed) {
				// Replace command with a harmless echo that informs the model
				const notice = `Command blocked by restricted-shell: ${result.reason}`
				;(output.args as Record<string, unknown>).command = `echo "${notice.replace(/"/g, '\\"')}"`
				logger.log(
					`[restricted-shell-hook] blocked: agent=${agent} tool=${input.tool} reason="${result.reason}"`,
				)
			}
		},
	}
}
