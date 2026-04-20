/**
 * Background task tools — spawn, monitor, wait, continue, and cancel background agent tasks.
 *
 * Supports multi-turn conversations with background agents via bg_continue:
 * send follow-up prompts to running/completed sessions, preserving full context.
 */

import { tool, type PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import type { BackgroundSpawner } from '../runtime/background/spawner'
import type { BackgroundManager } from '../runtime/background/manager'
import type { ConcurrencyManager } from '../runtime/background/concurrency'
import { parseModelString } from '../utils/model-fallback'

const z = tool.schema

type SdkClient = PluginInput['client']

function extractPartsText(parts: Array<{ type: string; text?: string }>): string {
	return parts
		.filter(p => p.type === 'text' && p.text)
		.map(p => p.text!)
		.join('\n')
}

function formatTask(t: {
	id: string
	targetAgent: string
	status: string
	model: string
	prompt: string
	summary: string
	createdAt: number
	error?: string
	sessionId?: string | null
}): string {
	const age = Math.round((Date.now() - t.createdAt) / 1000)
	let line = `**${t.id}** [${t.status}] agent=${t.targetAgent} model=${t.model} (${age}s ago)`
	if (t.sessionId) line += `\n  session_id: ${t.sessionId}`
	if (t.summary) line += `\n  Last output: ${t.summary.slice(0, 200)}`
	if (t.error) line += `\n  Error: ${t.error.slice(0, 200)}`
	return line
}

export function createBackgroundTools(
	ctx: ToolContext & {
		bgSpawner: BackgroundSpawner | null
		bgManager: BackgroundManager | null
		bgConcurrency: ConcurrencyManager | null
	},
): Record<string, ReturnType<typeof tool>> {
	const { bgSpawner, bgManager, bgConcurrency, directory, logger } = ctx
	const client: SdkClient = ctx.input.client

	const DISABLED_MSG =
		'Background task runtime is disabled. Enable it via `background.enabled: true` in forge-config.'

	if (!bgManager || !bgConcurrency) {
		return {
			bg_spawn: tool({
				description: 'Spawn a background agent task.',
				args: {
					agent: z.string().describe('Agent to run'),
					prompt: z.string().describe('Prompt for the agent'),
				},
				execute: async () => DISABLED_MSG,
			}),
			bg_status: tool({
				description: 'Get background task status.',
				args: {
					id: z.string().optional().describe('Task ID (omit for overview)'),
				},
				execute: async () => DISABLED_MSG,
			}),
			bg_wait: tool({
				description: 'Wait for a background task to complete.',
				args: { id: z.string().describe('Task ID') },
				execute: async () => DISABLED_MSG,
			}),
			bg_continue: tool({
				description: 'Continue a conversation with a background agent.',
				args: {
					id: z.string().describe('Task ID'),
					prompt: z.string().describe('Follow-up prompt'),
				},
				execute: async () => DISABLED_MSG,
			}),
			bg_cancel: tool({
				description: 'Cancel a background task.',
				args: { id: z.string().describe('Task ID') },
				execute: async () => DISABLED_MSG,
			}),
		}
	}

	const refreshLiteTask = async (taskId: string) => {
		const task = bgManager.getById(taskId)
		if (!task || !task.sessionId) return task
		if (task.status === 'cancelled') return task

		try {
			const statusResult = await client.session.status({ query: { directory } })
			const statuses = (!statusResult.error && statusResult.data
				? (statusResult.data as Record<string, { type: string }>)
				: {}) as Record<string, { type: string }>
			const sessionStatus = statuses[task.sessionId]

			const msgsResult = await client.session.messages({
				path: { id: task.sessionId },
				query: { directory, limit: 5 },
			})
			const messages = (msgsResult.data ?? []) as Array<{
				info: { role: string }
				parts: Array<{ type: string; text?: string }>
			}>

			const lastAssistant = [...messages].reverse().find(m => m.info.role === 'assistant')
			const summary = lastAssistant ? extractPartsText(lastAssistant.parts).slice(0, 500) : ''

			if (task.status === 'running' && summary) {
				bgManager.updateSummary(task.id, summary)
			}

			if (task.status === 'running' && (!sessionStatus || sessionStatus.type === 'idle')) {
				bgManager.markCompleted(task.id, summary || task.summary || '(no output)')
			}
		} catch (err) {
			logger.log(
				`[background-lite] refresh failed for task=${taskId}: ${err instanceof Error ? err.message : String(err)}`,
			)
		}

		return bgManager.getById(taskId)
	}

	if (!bgSpawner) {
		return {
			bg_spawn: tool({
				description:
					'Compatibility background agent launcher using the lightweight session-backed runtime. ' +
					'Prefer native Task/subtask child sessions when you want OpenCode-visible subagent runs and browsable output. ' +
					'Returns a task_id and session_id that can be monitored with bg_status / bg_wait.',
				args: {
					agent: z
						.string()
						.describe('Agent to run in background (e.g. "explore", "librarian", "oracle", "forge")'),
					prompt: z.string().describe('Prompt / instruction for the background agent'),
					context: z.string().optional().describe('Additional context to prepend to the prompt'),
					model: z.string().optional().describe('Model to use (default: agent default)'),
				},
				execute: async (args, toolCtx) => {
					const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
					const model = args.model ?? args.agent
					const task = bgManager.enqueue({
						id,
						parentAgent: 'forge',
						targetAgent: args.agent,
						prompt: args.prompt,
						context: args.context,
						model,
					})

					try {
						const createBody: { title: string; parentID?: string } = {
							title: `bg: ${args.agent} — ${args.prompt.slice(0, 60)}`,
						}
						if (toolCtx.sessionID) createBody.parentID = toolCtx.sessionID

						const createResult = await client.session.create({
							body: createBody,
							query: { directory },
						})

						if (createResult.error || !createResult.data) {
							bgManager.markError(task.id, `Session creation failed: ${JSON.stringify(createResult.error)}`)
							return `Failed to spawn background task:\n${formatTask(bgManager.getById(task.id)!)}`
						}

						const sessionId = (createResult.data as { id: string }).id
						bgManager.markRunning(task.id, sessionId)

						const fullPrompt = args.context ? `${args.context}\n\n---\n\n${args.prompt}` : args.prompt
						const promptBody: Record<string, unknown> = {
							agent: args.agent,
							parts: [{ type: 'text' as const, text: fullPrompt }],
						}
						const parsedModel = parseModelString(args.model)
						if (parsedModel) promptBody.model = parsedModel

						const promptResult = await client.session.promptAsync({
							path: { id: sessionId },
							body: promptBody as { agent: string; parts: Array<{ type: 'text'; text: string }> },
							query: { directory },
						})

						if (promptResult.error) {
							bgManager.markError(task.id, `Prompt failed: ${JSON.stringify(promptResult.error)}`)
							return `Failed to spawn background task:\n${formatTask(bgManager.getById(task.id)!)}`
						}

						const started = (await refreshLiteTask(task.id)) ?? bgManager.getById(task.id)!
						return (
							`Background task spawned (lite mode):\n${formatTask(started)}\n\n` +
							'Use `bg_status` to check progress, `bg_wait` to wait, ' +
							'or `bg_continue` with the task ID to send follow-up messages.'
						)
					} catch (err) {
						bgManager.markError(task.id, `Spawn error: ${err instanceof Error ? err.message : String(err)}`)
						return `Failed to spawn background task:\n${formatTask(bgManager.getById(task.id)!)}`
					}
				},
			}),

			bg_status: tool({
				description:
					'Get status of lightweight background tasks. Omit id to see an overview of all tasks, or provide an id for details.',
				args: {
					id: z.string().optional().describe('Specific task ID to check'),
					limit: z.number().optional().default(20).describe('Max tasks to list in overview'),
				},
				execute: async args => {
					if (args.id) {
						const task = await refreshLiteTask(args.id)
						if (!task) return `Task ${args.id} not found.`
						return formatTask(task)
					}

					const tasks = bgManager.getAll(args.limit)
					for (const task of tasks) {
						await refreshLiteTask(task.id)
					}

					const refreshed = bgManager.getAll(args.limit)
					if (refreshed.length === 0) return 'No background tasks.'

					const running = refreshed.filter(t => t.status === 'running').length
					const pending = refreshed.filter(t => t.status === 'pending').length
					const header = `**Background Tasks (lite mode)** — ${running} running / ${pending} pending\n\n`
					const body = refreshed.map(formatTask).join('\n\n')
					return header + body
				},
			}),

			bg_wait: tool({
				description:
					'Wait for a lightweight background task to complete. Polls up to timeoutMs (default 60s) then returns current status.',
				args: {
					id: z.string().describe('Task ID to wait for'),
					timeout: z.number().optional().default(60_000).describe('Max wait time in ms'),
				},
				execute: async args => {
					const deadline = Date.now() + (args.timeout ?? 60_000)
					const POLL_MS = 2000

					while (Date.now() < deadline) {
						const task = await refreshLiteTask(args.id)
						if (!task) return `Task ${args.id} not found.`
						if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
							return `Task finished:\n${formatTask(task)}`
						}
						await new Promise(r => setTimeout(r, POLL_MS))
					}

					const task = await refreshLiteTask(args.id)
					if (!task) return `Task ${args.id} not found.`
					return `Wait timed out. Current status:\n${formatTask(task)}`
				},
			}),

			bg_continue: tool({
				description:
					'Continue a lightweight background conversation by sending a follow-up prompt to the saved session.',
				args: {
					id: z.string().describe('Task ID to continue'),
					prompt: z.string().describe('Follow-up prompt / instruction for the agent'),
				},
				execute: async args => {
					const task = bgManager.getById(args.id)
					if (!task) return `Task ${args.id} not found.`
					if (!task.sessionId) {
						return `Task ${args.id} has no session yet (status: ${task.status}). Wait for it to start first.`
					}

					const promptResult = await client.session.promptAsync({
						path: { id: task.sessionId },
						body: {
							agent: task.targetAgent,
							parts: [{ type: 'text' as const, text: args.prompt }],
						},
						query: { directory },
					})

					if (promptResult.error) {
						return `Failed to continue task ${args.id}: ${JSON.stringify(promptResult.error)}`
					}

					if (task.status === 'completed' || task.status === 'error') {
						bgManager.markRunning(task.id, task.sessionId)
					}

					return (
						`Sent follow-up to task ${args.id} (agent=${task.targetAgent}, session=${task.sessionId}).\n\n` +
						'Agent continues with full previous context preserved.\n' +
						'Use `bg_status` to monitor or `bg_wait` to wait for completion.'
					)
				},
			}),

			bg_cancel: tool({
				description: 'Cancel a lightweight background task.',
				args: {
					id: z.string().describe('Task ID to cancel'),
				},
				execute: async args => {
					const task = bgManager.getById(args.id)
					if (!task) return `Task ${args.id} not found.`

					const cancelled = bgManager.cancel(args.id)
					if (!cancelled) {
						return `Cannot cancel task ${args.id} — current status: ${task.status}`
					}

					if (task.sessionId) {
						await ctx.v2.session.abort({ sessionID: task.sessionId }).catch(err => {
							logger.log(
								`[background-lite] abort failed for task=${args.id}: ${err instanceof Error ? err.message : String(err)}`,
							)
						})
					}

					return `Task ${args.id} cancelled.`
				},
			}),
		}
	}

	return {
		bg_spawn: tool({
			description:
				'Compatibility background agent launcher. Prefer native Task/subtask child sessions when you want OpenCode-visible subagent runs and browsable output. The agent runs in a separate session and can be monitored, continued, or cancelled.\n\n' +
				'Returns a task_id and session_id. Use session_id with bg_continue to send follow-up messages.',
			args: {
				agent: z
					.string()
					.describe('Agent to run in background (e.g. "explore", "librarian", "oracle", "forge")'),
				prompt: z.string().describe('Prompt / instruction for the background agent'),
				context: z.string().optional().describe('Additional context to prepend to the prompt'),
				model: z.string().optional().describe('Model to use (default: agent default)'),
			},
			execute: async args => {
				const id = `bg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
				const model = args.model ?? args.agent

				const task = await bgSpawner.spawn({
					id,
					parentAgent: 'forge',
					targetAgent: args.agent,
					prompt: args.prompt,
					context: args.context,
					model,
				})

				return (
					`Background task spawned:\n${formatTask(task)}\n\n` +
					'Use `bg_status` to check progress, `bg_wait` to wait, ' +
					'or `bg_continue` with the task ID to send follow-up messages.'
				)
			},
		}),

		bg_status: tool({
			description:
				'Get status of background tasks. Omit id to see an overview of all tasks, or provide an id for details.',
			args: {
				id: z.string().optional().describe('Specific task ID to check'),
				limit: z.number().optional().default(20).describe('Max tasks to list in overview'),
			},
			execute: async args => {
				if (args.id) {
					const task = bgManager.getById(args.id)
					if (!task) return `Task ${args.id} not found.`
					return formatTask(task)
				}

				const util = bgConcurrency.utilisation()
				const tasks = bgManager.getAll(args.limit)

				if (tasks.length === 0) return 'No background tasks.'

				const header = `**Background Tasks** — ${util.running} running / ${util.pending} pending (limit: ${util.maxConcurrent} global, ${util.perModelLimit}/model)\n\n`
				const body = tasks.map(formatTask).join('\n\n')
				return header + body
			},
		}),

		bg_wait: tool({
			description:
				'Wait for a background task to complete. Polls up to timeoutMs (default 60s) then returns current status.',
			args: {
				id: z.string().describe('Task ID to wait for'),
				timeout: z.number().optional().default(60_000).describe('Max wait time in ms'),
			},
			execute: async args => {
				const deadline = Date.now() + (args.timeout ?? 60_000)
				const POLL_MS = 2000

				while (Date.now() < deadline) {
					const task = bgManager.getById(args.id)
					if (!task) return `Task ${args.id} not found.`
					if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
						return `Task finished:\n${formatTask(task)}`
					}
					await new Promise(r => setTimeout(r, POLL_MS))
				}

				const task = bgManager.getById(args.id)
				if (!task) return `Task ${args.id} not found.`
				return `Wait timed out. Current status:\n${formatTask(task)}`
			},
		}),

		bg_continue: tool({
			description:
				'Continue a conversation with a background agent by sending a follow-up prompt.\n\n' +
				'The agent receives the new prompt with full previous context preserved. ' +
				'Works on running or completed tasks. The task is re-marked as running.',
			args: {
				id: z.string().describe('Task ID to continue'),
				prompt: z.string().describe('Follow-up prompt / instruction for the agent'),
			},
			execute: async args => {
				const task = bgManager.getById(args.id)
				if (!task) return `Task ${args.id} not found.`
				if (!task.sessionId) {
					return `Task ${args.id} has no session yet (status: ${task.status}). Wait for it to start first.`
				}

				try {
					// Send follow-up prompt to the existing session
					const promptResult = await ctx.v2.session.promptAsync({
						sessionID: task.sessionId,
						directory: ctx.directory,
						agent: task.targetAgent,
						parts: [{ type: 'text' as const, text: args.prompt }],
					})

					if (promptResult.error) {
						return `Failed to continue task ${args.id}: ${JSON.stringify(promptResult.error)}`
					}

					// Re-mark as running if it was completed
					if (task.status === 'completed' || task.status === 'error') {
						bgManager.markRunning(task.id, task.sessionId)
					}

					return (
						`Sent follow-up to task ${args.id} (agent=${task.targetAgent}, session=${task.sessionId}).\n\n` +
						'Agent continues with full previous context preserved.\n' +
						'Use `bg_status` to monitor or `bg_wait` to wait for completion.'
					)
				} catch (err) {
					return `Failed to continue task: ${err instanceof Error ? err.message : String(err)}`
				}
			},
		}),

		bg_cancel: tool({
			description: 'Cancel a running or pending background task.',
			args: {
				id: z.string().describe('Task ID to cancel'),
			},
			execute: async args => {
				const cancelled = await bgSpawner.cancel(args.id)
				if (!cancelled) {
					const task = bgManager.getById(args.id)
					if (!task) return `Task ${args.id} not found.`
					return `Cannot cancel task ${args.id} — current status: ${task.status}`
				}
				return `Task ${args.id} cancelled.`
			},
		}),
	}
}
