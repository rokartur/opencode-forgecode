/**
 * Background task tools — spawn, monitor, wait, and cancel background agent tasks.
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
}): string {
	const age = Math.round((Date.now() - t.createdAt) / 1000)
	let line = `**${t.id}** [${t.status}] agent=${t.targetAgent} model=${t.model} (${age}s ago)`
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
				'Spawn a background agent task. The agent runs in a separate session and can be monitored or cancelled.',
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
				const model = args.model ?? args.agent // Use agent name as model key if no model specified

				const task = await bgSpawner.spawn({
					id,
					parentAgent: 'forge', // TODO: get from session context
					targetAgent: args.agent,
					prompt: args.prompt,
					context: args.context,
					model,
				})

				return `Background task spawned:\n${formatTask(task)}\n\nUse \`bg_status\` to check progress or \`bg_wait\` to wait for completion.`
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
