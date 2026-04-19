/**
 * RTK guidance hook — injects a short system-reminder into agent
 * sessions instructing them to prefix shell commands with `rtk`
 * (the Rust Token Killer CLI proxy).
 *
 * The reminder is injected once per session, only for agents that
 * have shell access (i.e. bash-capable primary agents). Read-only
 * agents (librarian/explore/oracle/sage) don't run shell commands,
 * so they are skipped to avoid context noise.
 *
 * See `src/runtime/rtk.ts` for the installer and raw instruction text.
 */

import { RTK_INSTRUCTION_BLOCK, isRtkInstalled, resolveRtkConfig } from '../runtime/rtk'
import type { Logger, PluginConfig } from '../types'

export interface RtkGuidanceHooks {
	/** Call from chat.message to inject the RTK instruction once per session. */
	onMessage: (
		input: { sessionID: string; messageID?: string; agent?: string },
		output: { parts: Array<Record<string, unknown>> },
	) => void
}

/**
 * Agents that DO NOT need the RTK guidance. These are read-only or
 * orchestration-only agents that don't directly run shell commands.
 */
const SKIP_AGENTS = new Set(['librarian', 'explore', 'oracle', 'sage', 'metis', 'muse'])

export function createRtkGuidanceHooks(logger: Logger, config: PluginConfig): RtkGuidanceHooks {
	const resolved = resolveRtkConfig(config.rtk)
	const injectedSessions = new Set<string>()

	return {
		onMessage(input, output) {
			if (!resolved.enabled) return
			const agent = (input.agent ?? 'forge').toLowerCase()
			if (SKIP_AGENTS.has(agent)) return

			// Only inject once per session.
			const key = `${input.sessionID}:${agent}`
			if (injectedSessions.has(key)) return
			injectedSessions.add(key)

			// If rtk isn't on PATH, skip injection — otherwise we'd instruct the
			// agent to use a missing binary. The installer runs in the
			// background at plugin init; it may become available later.
			if (!isRtkInstalled()) {
				logger.debug('[rtk-guidance] rtk not on PATH; skipping guidance injection')
				return
			}

			output.parts.unshift({
				id: crypto.randomUUID(),
				sessionID: input.sessionID,
				messageID: input.messageID ?? '',
				type: 'text',
				text: RTK_INSTRUCTION_BLOCK,
				synthetic: true,
			})
			logger.log(`[rtk-guidance] injected RTK instructions for agent '${agent}' in session ${input.sessionID}`)
		},
	}
}
