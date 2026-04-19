/**
 * Agent-as-tool — auto-registers `agent_<name>` tools for each agent
 * with `toolSupported: true`.
 *
 * These tools delegate to the background spawner (if available) or
 * run inline via v2 session prompt (sync fallback).
 */

import { tool } from '@opencode-ai/plugin'
import { agents, type AgentDefinition } from '../agents'
import type { ToolContext } from '../tools/types'
import type { BackgroundSpawner } from '../runtime/background/spawner'

const z = tool.schema

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

function createAgentTool(
	role: string,
	def: AgentDefinition,
	ctx: ToolContext & { bgSpawner: BackgroundSpawner | null },
): ReturnType<typeof tool> {
	return tool({
		description: `Invoke the ${def.displayName} agent: ${def.description}`,
		args: {
			prompt: z.string().describe(`Instruction / question for the ${def.displayName} agent`),
			context: z.string().optional().describe('Additional context to prepend to the prompt'),
			background: z
				.boolean()
				.optional()
				.default(false)
				.describe('Run in background (true) or wait for result (false)'),
		},
		execute: async args => {
			const { bgSpawner, v2, directory, logger } = ctx

			if (args.background && bgSpawner) {
				// Background delegation
				const id = `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
				const task = await bgSpawner.spawn({
					id,
					parentAgent: 'forge',
					targetAgent: role,
					prompt: args.prompt,
					context: args.context,
					model: role,
				})

				return `Spawned agent_${role} in background (task ${task.id}, status: ${task.status}). Use bg_status or bg_wait to track.`
			}

			// Sync delegation — create a session, prompt, and collect result
			try {
				const createResult = await v2.session.create({
					title: `agent_${role}: ${args.prompt.slice(0, 60)}`,
					directory,
				})

				if (createResult.error || !createResult.data) {
					return `Failed to create session for agent_${role}: ${JSON.stringify(createResult.error)}`
				}

				const sessionId = createResult.data.id
				const fullPrompt = args.context ? `${args.context}\n\n---\n\n${args.prompt}` : args.prompt

				const promptResult = await v2.session.promptAsync({
					sessionID: sessionId,
					directory,
					agent: role,
					parts: [{ type: 'text' as const, text: fullPrompt }],
				})

				if (promptResult.error) {
					return `agent_${role} prompt failed: ${JSON.stringify(promptResult.error)}`
				}

				// Poll for result (up to 120s)
				const deadline = Date.now() + 120_000
				while (Date.now() < deadline) {
					await new Promise(r => setTimeout(r, 2000))
					const sessResult = await v2.session.get({ sessionID: sessionId })
					if (sessResult.error || !sessResult.data) continue

					// Cast through unknown — the runtime shape may include messages
					const session = sessResult.data as Record<string, unknown>
					const messages = session.messages as Array<{ role: string; content: unknown }> | undefined
					if (!messages || messages.length < 2) continue

					const lastMsg = messages[messages.length - 1]
					const content =
						typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content)

					// Simple heuristic: if the last message is from assistant, the agent is done
					if (lastMsg.role === 'assistant') {
						return content.slice(0, 4000)
					}
				}

				return `agent_${role} timed out after 120s. Check session ${sessionId} manually.`
			} catch (err) {
				logger.log(`[agent-as-tool] agent_${role} error: ${err instanceof Error ? err.message : err}`)
				return `agent_${role} error: ${err instanceof Error ? err.message : String(err)}`
			}
		},
	})
}
