/**
 * Agent-as-tool — auto-registers `agent_<name>` tools for each agent
 * with `toolSupported: true`.
 *
 * Supports conversational multi-turn interactions via `session_id`:
 *   - First call (no session_id): creates a new child session, returns session_id.
 *   - Follow-up calls (with session_id): continues the conversation in the
 *     same session, preserving full context.
 *
 * Uses the framework-provided v1 SDK client (`input.client`) for all session
 * operations.  This client is instantiated by the plugin runtime with the
 * correct internal URL, so it works even when no external HTTP server is
 * running (TUI mode).
 *
 * API surface used:
 *   - session.create({ body: { parentID }, query: { directory } })
 *   - session.promptAsync({ path: { id }, body: { ... }, query: { directory } })
 *   - session.messages({ path: { id }, query: { directory, limit } })
 *   - session.status({ query: { directory } })
 *
 * @see https://opencode.ai/docs/sdk
 * @see https://opencode.ai/docs/agents
 */

import { tool, type PluginInput } from '@opencode-ai/plugin'
import { agents, type AgentDefinition } from '../agents'
import type { ToolContext } from '../tools/types'
import type { BackgroundSpawner } from '../runtime/background/spawner'
import {
	resolveFallbackModelEntries,
} from '../utils/model-fallback'

const z = tool.schema

/** Max chars to return from agent output. */
const MAX_OUTPUT_CHARS = 8_000

/** Convenience alias for the framework-provided SDK client type. */
type SdkClient = PluginInput['client']

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

	const names = Object.keys(tools)
	ctx.logger.log(`[agent-as-tool] registered ${names.length} agent tools: ${names.join(', ')}`)
	return tools
}

/**
 * Extract text content from message parts using the OpenCode SDK format.
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
			`Compatibility wrapper for the native ${def.displayName} subagent: ${def.description}\n\n` +
			'Prefer the built-in Task/subtask flow or @mentions when you want OpenCode-native child-session visibility. ' +
			'Use this wrapper only when you explicitly need session_id-based continuation or a legacy fallback path.\n\n' +
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
			const { bgSpawner, directory, logger } = ctx
			const client: SdkClient = ctx.input.client
			const parentSessionID = toolCtx.sessionID

			logger.log(
				`[agent-as-tool] ENTER agent_${role} background=${args.background} session_id=${args.session_id ?? '(new)'} bgSpawner=${!!bgSpawner}`,
			)

			// ── Background delegation (full bgSpawner) ────────────────
			if (args.background && bgSpawner) {
				if (args.session_id) {
					return continueBackgroundSession(client, directory, role, args)
				}

				const bgAgentOverride = ctx.config.agents?.[role]
				const bgModelStr = bgAgentOverride?.model || role

				const id = `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
				const task = await bgSpawner.spawn({
					id,
					parentAgent: 'forge',
					targetAgent: role,
					prompt: args.prompt,
					context: args.context,
					model: bgModelStr,
					fallbackModels: bgAgentOverride?.fallback_models,
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

			// ── Lightweight background via promptAsync (bgSpawner disabled) ─
			if (args.background && !bgSpawner) {
				try {
					const bgCreateResult = await client.session.create({
						body: {
							parentID: parentSessionID,
							title: `agent_${role}: ${args.prompt.slice(0, 60)}`,
						},
						query: { directory },
					})
					if (bgCreateResult.error || !bgCreateResult.data) {
						logger.log(`[agent-as-tool] bg-lite session create failed: ${JSON.stringify(bgCreateResult.error)}`)
						return `agent_${role} background failed: could not create session`
					}
					const bgSessionId = (bgCreateResult.data as { id: string }).id
					const bgFullPrompt =
						args.context ? `${args.context}\n\n---\n\n${args.prompt}` : args.prompt

					// Fire-and-forget — promptAsync returns 204 regardless of model
					// validity, so retryWithModelFallback is useless here. Just send
					// the prompt and let the agent's configured model handle it.
					const bgPromptResult = await client.session.promptAsync({
						path: { id: bgSessionId },
						body: {
							agent: role,
							parts: [{ type: 'text' as const, text: bgFullPrompt }],
						},
						query: { directory },
					})

					if (bgPromptResult.error) {
						logger.log(`[agent-as-tool] bg-lite prompt failed: ${JSON.stringify(bgPromptResult.error)}`)
						return `agent_${role} background failed: ${JSON.stringify(bgPromptResult.error)}`
					}

					logger.log(`[agent-as-tool] bg-lite started session=${bgSessionId} agent=${role}`)
					return (
						`Spawned agent_${role} in background (lite mode).\n\n` +
						`**session_id**: ${bgSessionId}\n\n` +
						'The agent is running asynchronously. Call this tool again with session_id to check results.'
					)
				} catch (err) {
					logger.log(`[agent-as-tool] bg-lite error: ${err instanceof Error ? err.message : err}`)
					return `agent_${role} background error: ${err instanceof Error ? err.message : String(err)}`
				}
			}

			// ── Sync delegation (promptAsync + poll) ───────────────────
			try {
				let sessionId: string

				if (args.session_id) {
					sessionId = args.session_id

					const sessResult = await client.session.get({ path: { id: sessionId }, query: { directory } })
					if (sessResult.error || !sessResult.data) {
						return `Session ${sessionId} not found or expired. Start a new conversation by omitting session_id.`
					}

					logger.log(`[agent-as-tool] continuing session=${sessionId} agent=${role}`)
				} else {
					logger.log(`[agent-as-tool] creating child session for agent_${role}...`)
					const createResult = await client.session.create({
						body: {
							parentID: parentSessionID,
							title: `agent_${role}: ${args.prompt.slice(0, 60)}`,
						},
						query: { directory },
					})

					if (createResult.error || !createResult.data) {
						logger.log(`[agent-as-tool] session create FAILED: ${JSON.stringify(createResult.error)}`)
						return `Failed to create session for agent_${role}: ${JSON.stringify(createResult.error)}`
					}

					sessionId = (createResult.data as { id: string }).id
					logger.log(`[agent-as-tool] child session created: ${sessionId} for agent_${role}`)
				}

				// Build the prompt
				const fullPrompt =
					!args.session_id && args.context ? `${args.context}\n\n---\n\n${args.prompt}` : args.prompt

				// Resolve the agent's fallback chain from config (for post-idle retry)
				const agentOverride = ctx.config.agents?.[role]
				const fallbackModels = resolveFallbackModelEntries(agentOverride?.fallback_models)

				logger.log(
					`[agent-as-tool] firing promptAsync for agent_${role} session=${sessionId} model=${agentOverride?.model ?? '(agent-config)'} fallbacks=${fallbackModels.length}`,
				)

				// --- Helper: send prompt + poll until idle -----------------
				const sendAndPoll = async (
					modelOverride?: { providerID: string; modelID: string },
				): Promise<{ ok: boolean; assistantText: string | null }> => {
					const body: Record<string, unknown> = {
						agent: role,
						parts: [{ type: 'text' as const, text: fullPrompt }],
					}
					if (modelOverride) body.model = modelOverride

					const res = await client.session.promptAsync({
						path: { id: sessionId },
						body: body as { agent: string; parts: Array<{ type: 'text'; text: string }> },
						query: { directory },
					})
					if (res.error) return { ok: false, assistantText: null }

					// Poll for idle
					const POLL_MS = 2_000
					const MAX_MS = 5 * 60 * 1_000
					const t0 = Date.now()
					while (Date.now() - t0 < MAX_MS) {
						await new Promise(r => setTimeout(r, POLL_MS))
						try {
							const sr = await client.session.status({ query: { directory } })
							if (!sr.error && sr.data) {
								const ss = (sr.data as Record<string, { type: string }>)[sessionId]
								if (!ss || ss.type === 'idle') {
									logger.log(
										`[agent-as-tool] agent_${role} session=${sessionId} reached idle after ${Date.now() - t0}ms`,
									)
									break
								}
							}
						} catch {
							/* continue polling */
						}
					}

					// Check for assistant response
					const mr = await client.session.messages({
						path: { id: sessionId },
						query: { directory, limit: 10 },
					})
					const msgs = (mr.data ?? []) as Array<{
						info: { role?: string }
						parts: Array<{ type: string; text?: string }>
					}>
					const aMsg = [...msgs].reverse().find(m => m.info.role === 'assistant')
					const text = aMsg ? extractPartsText(aMsg.parts) : null
					return { ok: !!text, assistantText: text }
				}

				// --- 1. Initial attempt (no model override → uses agent config) ---
				let result = await sendAndPoll()

				// --- 2. Post-idle fallback: if no response, the server-side model
				//     likely failed (e.g. ProviderModelNotFoundError). Retry with
				//     each fallback model until one succeeds. -----------------------
				if (!result.ok && fallbackModels.length > 0) {
					logger.log(
						`[agent-as-tool] agent_${role} no response — trying ${fallbackModels.length} fallback model(s)`,
					)
					for (const fb of fallbackModels) {
						logger.log(`[agent-as-tool] agent_${role} retrying with fallback ${fb.providerID}/${fb.modelID}`)
						result = await sendAndPoll(fb)
						if (result.ok) break
					}
				}

				if (!result.assistantText) {
					return (
						`agent_${role} finished but returned no assistant response (model may be unavailable).\n\n` +
						`**session_id**: ${sessionId}\n` +
						'Call this tool again with session_id to send a follow-up.'
					)
				}

				const output = result.assistantText.slice(0, MAX_OUTPUT_CHARS)
				const truncated = result.assistantText.length > MAX_OUTPUT_CHARS ? '\n\n[output truncated]' : ''

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
 */
async function continueBackgroundSession(
	client: SdkClient,
	directory: string,
	role: string,
	args: { prompt: string; session_id?: string },
): Promise<string> {
	const sessionId = args.session_id!

	try {
		const promptResult = await client.session.promptAsync({
			path: { id: sessionId },
			body: {
				agent: role,
				parts: [{ type: 'text' as const, text: args.prompt }],
			},
			query: { directory },
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
