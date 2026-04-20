/**
 * RTK guidance hook — injects a short system-reminder into agent
 * sessions instructing them to prefix shell commands with `rtk`
 * (the Rust Token Killer CLI proxy).
 *
 * The reminder is injected once per session for every agent that has
 * shell/Bash access. Agents whose tool set is restricted to read-only
 * tools via an include-list (librarian, explore, oracle, metis) are
 * skipped to avoid context noise.
 *
 * When `rtk` is installed outside the process PATH (e.g. ~/.local/bin),
 * the instruction block includes an `export PATH` preamble so agents
 * can locate the binary in spawned shells.
 *
 * See `src/runtime/rtk.ts` for the installer and raw instruction text.
 */

import { buildRtkInstructionBlock, isRtkInstalled, resolveRtkConfig } from '../runtime/rtk'
import type { Logger, PluginConfig } from '../types'

export interface RtkGuidanceHooks {
	/** Call from chat.message to inject the RTK instruction once per session. */
	onMessage: (
		input: { sessionID: string; messageID?: string; agent?: string },
		output: { parts: Array<Record<string, unknown>> },
	) => void
}

/**
 * Agents that DO NOT need the RTK guidance. Only agents that have
 * NO shell/Bash access at all (include-list without Bash) are skipped.
 * Agents with shell access (even read-only ones like sage/muse that
 * run git commands) MUST receive RTK guidance.
 */
const SKIP_AGENTS = new Set(['librarian', 'explore', 'oracle', 'metis'])

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
				text: buildRtkInstructionBlock(),
				synthetic: true,
			})
			logger.log(`[rtk-guidance] injected RTK instructions for agent '${agent}' in session ${input.sessionID}`)
		},
	}
}
