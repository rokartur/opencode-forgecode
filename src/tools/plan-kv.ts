import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'

const z = tool.schema

/**
 * Soft size limit per single `plan-write` / `plan-append` call.
 *
 * Large monolithic plan content makes the LLM stream huge tool arguments in a
 * single tool-call, which regularly trips the provider's request timeout or
 * SSE chunk timeout and surfaces as "Tool execution aborted. The operation
 * timed out." Enforcing a soft cap nudges the model toward incremental writes
 * via `plan-append` instead of one giant `plan-write`.
 */
const MAX_CONTENT_BYTES = 8_000

function sizeHint(content: string): string {
	return `${content.length} chars / ${content.split('\n').length} lines`
}

export function createPlanTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
	const { kvService, projectId, logger, loopService } = ctx

	function resolvePlanKey(sessionID: string): string {
		const loopName = loopService.resolveLoopName(sessionID)
		if (loopName) {
			return `plan:${loopName}`
		}
		return `plan:${sessionID}`
	}

	return {
		'plan-write': tool({
			description:
				'Write or overwrite the entire plan content for the current session. Auto-resolves key to plan:{sessionID}. ' +
				'For large plans, prefer writing a skeleton here (Objective + Phase headings) and then adding sections via `plan-append` ' +
				`to avoid provider timeouts. Soft limit: ${MAX_CONTENT_BYTES} chars per call.`,
			args: {
				content: z.string().describe('The plan content to write'),
			},
			execute: async (args, context) => {
				const started = Date.now()

				if (args.content.length > MAX_CONTENT_BYTES) {
					logger.log(
						`plan-write: rejected oversized write (${sizeHint(args.content)} > ${MAX_CONTENT_BYTES} chars)`,
					)
					return (
						`Error: plan content is ${args.content.length} chars (limit ${MAX_CONTENT_BYTES}). ` +
						`Write only the plan skeleton (Objective, Loop Name, empty Phase headings) with plan-write, ` +
						`then append each section separately using plan-append to avoid timeouts.`
					)
				}

				const key = resolvePlanKey(context.sessionID)
				kvService.set(projectId, key, args.content)

				logger.log(`plan-write: stored plan at ${key} (${sizeHint(args.content)}, ${Date.now() - started}ms)`)

				return `Plan stored (${args.content.split('\n').length} lines, ${args.content.length} chars)`
			},
		}),

		'plan-append': tool({
			description:
				'Append content to the existing plan for the current session. Prefer this over `plan-write` for adding ' +
				'individual sections (phases, verification, risks, etc.) — it lets you build large plans incrementally ' +
				'across multiple small tool-calls instead of one giant write. Creates the plan if it does not yet exist. ' +
				`Soft limit: ${MAX_CONTENT_BYTES} chars per call.`,
			args: {
				content: z.string().describe('The content to append to the plan'),
				section: z
					.string()
					.optional()
					.describe(
						'Optional section heading. When provided, "\\n\\n## {section}\\n" is inserted before the content.',
					),
			},
			execute: async (args, context) => {
				const started = Date.now()

				if (args.content.length > MAX_CONTENT_BYTES) {
					logger.log(
						`plan-append: rejected oversized append (${sizeHint(args.content)} > ${MAX_CONTENT_BYTES} chars)`,
					)
					return (
						`Error: append content is ${args.content.length} chars (limit ${MAX_CONTENT_BYTES}). ` +
						`Split it into multiple plan-append calls (one per subsection) to avoid timeouts.`
					)
				}

				const key = resolvePlanKey(context.sessionID)
				const existing = kvService.get<string>(projectId, key) ?? ''

				const prefix = args.section ? `\n\n## ${args.section}\n` : ''
				const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''
				const updated = existing + separator + prefix + args.content

				kvService.set(projectId, key, updated)

				const totalLines = updated.split('\n').length
				const addedLines = args.content.split('\n').length

				logger.log(
					`plan-append: appended to ${key} (${sizeHint(args.content)}, total ${totalLines} lines, ${Date.now() - started}ms)`,
				)

				return `Plan appended (${addedLines} lines added, total ${totalLines} lines)`
			},
		}),

		'plan-edit': tool({
			description:
				'Edit the plan by finding old_string and replacing with new_string. By default, old_string must be unique. ' +
				'Use `replace_all: true` to replace every occurrence, or `occurrence: N` (1-based) to target a specific match.',
			args: {
				old_string: z.string().describe('The string to find in the plan'),
				new_string: z.string().describe('The string to replace it with'),
				replace_all: z
					.boolean()
					.optional()
					.describe('If true, replace every occurrence instead of requiring uniqueness'),
				occurrence: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('1-based index of the occurrence to replace when old_string is not unique'),
			},
			execute: async (args, context) => {
				const key = resolvePlanKey(context.sessionID)
				const existing = kvService.get<string>(projectId, key)

				if (existing === null) {
					return `No plan found for session ${context.sessionID}`
				}

				const parts = existing.split(args.old_string)
				const occurrences = parts.length - 1
				if (occurrences === 0) {
					return `old_string not found in plan`
				}

				let updated: string
				let replaced: number
				if (args.replace_all) {
					updated = parts.join(args.new_string)
					replaced = occurrences
				} else if (args.occurrence !== undefined) {
					if (args.occurrence > occurrences) {
						return `occurrence ${args.occurrence} out of range: only ${occurrences} match${occurrences === 1 ? '' : 'es'} found`
					}
					const idx = args.occurrence - 1
					const before = parts.slice(0, idx + 1).join(args.old_string)
					const after = parts.slice(idx + 1).join(args.old_string)
					updated = before + args.new_string + after
					replaced = 1
				} else if (occurrences > 1) {
					return (
						`old_string found ${occurrences} times - must be unique, ` +
						`or pass replace_all: true, or occurrence: N (1-${occurrences})`
					)
				} else {
					updated = parts.join(args.new_string)
					replaced = 1
				}

				kvService.set(projectId, key, updated)

				const lineCount = updated.split('\n').length
				logger.log(
					`plan-edit: updated plan at ${key} (${replaced} replacement${replaced === 1 ? '' : 's'}, ${lineCount} lines)`,
				)

				return `Plan updated (${replaced} replacement${replaced === 1 ? '' : 's'}, ${lineCount} lines)`
			},
		}),

		'plan-read': tool({
			description:
				'Read the plan for the current session or a specified loop name. Supports pagination with offset/limit and pattern search.',
			args: {
				offset: z.number().optional().describe('Line number to start from (1-indexed)'),
				limit: z.number().optional().describe('Maximum number of lines to return'),
				pattern: z.string().optional().describe('Regex pattern to search for in plan content'),
				loop_name: z
					.string()
					.optional()
					.describe(
						'Optional loop name to read plan:{loop_name} directly instead of resolving from the current session',
					),
			},
			execute: async (args, context) => {
				const key = args.loop_name ? `plan:${args.loop_name}` : resolvePlanKey(context.sessionID)
				const value = kvService.get<string>(projectId, key)

				if (value === null) {
					logger.log(`plan-read: no plan found for session ${context.sessionID}`)
					return `No plan found for current session`
				}

				logger.log(`plan-read: retrieved plan from ${key}`)

				if (args.pattern) {
					let regex: RegExp
					try {
						regex = new RegExp(args.pattern)
					} catch (e) {
						return `Invalid regex pattern: ${(e as Error).message}`
					}

					const lines = value.split('\n')
					const matches: Array<{ lineNum: number; text: string }> = []

					for (let i = 0; i < lines.length; i++) {
						if (regex.test(lines[i])) {
							matches.push({ lineNum: i + 1, text: lines[i] })
						}
					}

					if (matches.length === 0) {
						return 'No matches found in plan'
					}

					return `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:\n\n${matches.map(m => `  Line ${m.lineNum}: ${m.text}`).join('\n')}`
				}

				const lines = value.split('\n')
				const totalLines = lines.length

				let resultLines = lines
				if (args.offset !== undefined) {
					const startIdx = args.offset - 1
					resultLines = resultLines.slice(Math.max(0, startIdx))
				}
				if (args.limit !== undefined) {
					resultLines = resultLines.slice(0, args.limit)
				}

				const numberedLines = resultLines.map((line, i) => {
					const originalLineNum = args.offset !== undefined ? args.offset + i : i + 1
					return `${originalLineNum}: ${line}`
				})

				const header = `(${totalLines} lines total)`
				return `${header}\n${numberedLines.join('\n')}`
			},
		}),
	}
}
