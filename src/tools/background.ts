/**
 * Background task tools — spawn, monitor, wait, continue, and cancel background agent tasks.
 *
 * Supports multi-turn conversations with background agents via bg_continue:
 * send follow-up prompts to running/completed sessions, preserving full context.
 */

import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import type { BackgroundSpawner } from '../runtime/background/spawner'
import type { BackgroundManager } from '../runtime/background/manager'
import type { ConcurrencyManager } from '../runtime/background/concurrency'

const z = tool.schema

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
	const { bgSpawner, bgManager, bgConcurrency } = ctx

	const DISABLED_MSG =
		'Background task runtime is disabled. Enable it via `background.enabled: true` in forge-config.'

	if (!bgSpawner || !bgManager || !bgConcurrency) {
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

	return {
		bg_spawn: tool({
			description:
				'Spawn a background agent task. The agent runs in a separate session and can be monitored, continued, or cancelled.\n\n' +
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
