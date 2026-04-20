/**
 * Agent-as-tool — auto-registers `agent_<name>` tools for each agent
 * with `toolSupported: true`.
 *
 * Supports conversational multi-turn interactions via `session_id`:
 *   - First call (no session_id): creates a new child session, returns session_id.
 *   - Follow-up calls (with session_id): continues the conversation in the
 *     same session, preserving full context.
 *
 * Uses the official OpenCode v2 SDK APIs:
 *   - session.create({ parentID }) for child session hierarchy
 *   - session.prompt() (sync) for blocking agent calls — returns { info, parts } directly
 *   - session.promptAsync() for background fire-and-forget
 *   - session.messages() for fetching message history (continuation mode)
 *   - session.status() for checking idle/busy state
 *
 * @see https://opencode.ai/docs/sdk
 * @see https://opencode.ai/docs/agents
 */

import { tool } from '@opencode-ai/plugin'
import { agents, type AgentDefinition } from '../agents'
import type { ToolContext } from '../tools/types'
import type { BackgroundSpawner } from '../runtime/background/spawner'
import {
	parseModelString,
	resolveFallbackModelEntries,
	retryWithModelFallback,
} from '../utils/model-fallback'

const z = tool.schema

/** Max chars to return from agent output. */
const MAX_OUTPUT_CHARS = 8_000

/**
 * Create agent-as-tool entries for all agents that declare `toolSupported: true`.
 */
export function createAgentAsTools(
	ctx: ToolContext & { bgSpawner: BackgroundSpawner | null },
): Record<string, ReturnType<typeof tool>> {
	const tools: Record<string, ReturnType<typeof tool>> = {}

	for (const [role, def] of Object.entries(agents)) {
		if (!def.toolSupported) continue
		tools[`agent_${role}`] = createAgentTool(role, def, ctx)
	}

	return tools
}

/**
 * Extract text content from message parts using the OpenCode SDK format.
 * Messages use `{ info: Message, parts: Part[] }` where Part has `.type` and `.text`.
 * @see https://opencode.ai/docs/sdk — SessionMessagesResponse / SessionPromptResponse
 */
function extractPartsText(parts: Array<{ type: string; text?: string }>): string {
	return parts
		.filter(p => p.type === 'text' && p.text)
		.map(p => p.text!)
		.join('\n')
}

function createAgentTool(
	role: string,
	def: AgentDefinition,
	ctx: ToolContext & { bgSpawner: BackgroundSpawner | null },
): ReturnType<typeof tool> {
	return tool({
		description:
			`Invoke the ${def.displayName} agent: ${def.description}\n\n` +
			'Supports multi-turn conversations: omit session_id for a new session, ' +
			'or provide a session_id from a previous call to continue the conversation ' +
			'with full context preserved.',
		args: {
			prompt: z.string().describe(`Instruction / question for the ${def.displayName} agent`),
			context: z.string().optional().describe('Additional context to prepend to the prompt (first call only)'),
			session_id: z
				.string()
				.optional()
				.describe(
					'Session ID from a previous invocation to continue the conversation. ' +
						'Omit to start a new session.',
				),
			background: z
				.boolean()
				.optional()
				.default(false)
				.describe('Run in background (true) or wait for result (false)'),
		},
		execute: async (args, toolCtx) => {
			const { bgSpawner, v2, directory, logger } = ctx
			const parentSessionID = toolCtx.sessionID

			// ── Background delegation ──────────────────────────────────
			if (args.background && bgSpawner) {
				if (args.session_id) {
					return continueBackgroundSession(v2, directory, role, args)
				}

				const id = `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
				const task = await bgSpawner.spawn({
					id,
					parentAgent: 'forge',
					targetAgent: role,
					prompt: args.prompt,
					context: args.context,
					model: role,
				})

				return (
					`Spawned agent_${role} in background.\n\n` +
					`**task_id**: ${task.id}\n` +
					`**session_id**: ${task.sessionId ?? '(pending)'}\n` +
					`**status**: ${task.status}\n\n` +
					'Use `bg_status` to check progress, `bg_wait` to wait, ' +
					'or call this tool again with session_id to continue the conversation.'
				)
			}

			// ── Sync delegation ────────────────────────────────────────
			try {
				let sessionId: string

				if (args.session_id) {
					// ── Continuation: reuse existing session ──
					sessionId = args.session_id

					// Verify session still exists
					const sessResult = await v2.session.get({ sessionID: sessionId })
					if (sessResult.error || !sessResult.data) {
						return `Session ${sessionId} not found or expired. Start a new conversation by omitting session_id.`
					}

					logger.log(`[agent-as-tool] continuing session=${sessionId} agent=${role}`)
				} else {
					// ── New child session ──
					// Use parentID to create a proper child session per OpenCode docs
					// @see https://opencode.ai/docs/agents — "When subagents create child sessions"
					const createResult = await v2.session.create({
						parentID: parentSessionID,
						title: `agent_${role}: ${args.prompt.slice(0, 60)}`,
						directory,
					})

					if (createResult.error || !createResult.data) {
						return `Failed to create session for agent_${role}: ${JSON.stringify(createResult.error)}`
					}

					sessionId = createResult.data.id
					logger.log(`[agent-as-tool] new child session=${sessionId} parent=${parentSessionID} agent=${role}`)
				}

				// Build the prompt — context only on first message
				const fullPrompt =
					!args.session_id && args.context ? `${args.context}\n\n---\n\n${args.prompt}` : args.prompt

				// Resolve the agent's primary model and fallback chain from config
				const agentOverride = ctx.config.agents?.[role]
				const primaryModel = parseModelString(agentOverride?.model)
				const fallbackModels = resolveFallbackModelEntries(agentOverride?.fallback_models)

				// Use retryWithModelFallback to walk the model chain on failure,
				// matching the same resilience that loop.ts provides.
				const { result: promptResult, usedModel } = await retryWithModelFallback(
					candidate =>
						v2.session.prompt({
							sessionID: sessionId,
							directory,
							agent: role,
							parts: [{ type: 'text' as const, text: fullPrompt }],
							model: candidate,
						}),
					() =>
						v2.session.prompt({
							sessionID: sessionId,
							directory,
							agent: role,
							parts: [{ type: 'text' as const, text: fullPrompt }],
						}),
					primaryModel,
					logger,
					{ fallbackModels, maxRetries: 2 },
				)

				if (usedModel && primaryModel && usedModel.modelID !== primaryModel.modelID) {
					logger.log(
						`[agent-as-tool] agent_${role} used fallback model ${usedModel.providerID}/${usedModel.modelID}`,
					)
				}

				if (promptResult.error) {
					return `agent_${role} prompt failed: ${JSON.stringify(promptResult.error)}`
				}

				// Extract text from the response parts
				const data = promptResult.data as {
					info: Record<string, unknown>
					parts: Array<{ type: string; text?: string }>
				} | null
				if (!data) {
					return (
						`agent_${role} returned no response.\n\n` +
						`**session_id**: ${sessionId}\n` +
						'Call this tool again with session_id to send a follow-up.'
					)
				}

				const responseText = extractPartsText(data.parts)
				const output = responseText.slice(0, MAX_OUTPUT_CHARS)
				const truncated = responseText.length > MAX_OUTPUT_CHARS ? '\n\n[output truncated]' : ''

				return (
					`${output}${truncated}\n\n---\n` +
					`**session_id**: ${sessionId}\n` +
					'To continue this conversation, call this tool again with the session_id above.'
				)
			} catch (err) {
				logger.log(`[agent-as-tool] agent_${role} error: ${err instanceof Error ? err.message : err}`)
				return `agent_${role} error: ${err instanceof Error ? err.message : String(err)}`
			}
		},
	})
}

/**
 * Continue a background session by sending a new prompt to an existing session.
 * Uses promptAsync since background tasks are fire-and-forget.
 */
async function continueBackgroundSession(
	v2: ToolContext['v2'],
	directory: string,
	role: string,
	args: { prompt: string; session_id?: string },
): Promise<string> {
	const sessionId = args.session_id!

	try {
		const promptResult = await v2.session.promptAsync({
			sessionID: sessionId,
			directory,
			agent: role,
			parts: [{ type: 'text' as const, text: args.prompt }],
		})

		if (promptResult.error) {
			return `Failed to continue background session: ${JSON.stringify(promptResult.error)}`
		}

		return (
			`Sent follow-up to agent_${role} in session ${sessionId}.\n\n` +
			'The agent continues with full previous context preserved.\n' +
			'Use `bg_status` to check progress or call this tool again with session_id to continue.'
		)
	} catch (err) {
		return `Failed to continue session: ${err instanceof Error ? err.message : String(err)}`
	}
}
