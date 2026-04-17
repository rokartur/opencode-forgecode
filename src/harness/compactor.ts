/**
 * Port of `forge_app::compact::Compactor` for opencode's plugin surface.
 *
 * The opencode plugin only exposes the `experimental.session.compacting` hook,
 * so we do not need the eviction/retention windowing logic — opencode already
 * decided which tail needs to be compacted and supplies it to us. We focus on:
 *
 *   1. Converting opencode messages into `ForgeMessage` shape
 *   2. Running the summary transformer pipeline
 *   3. Rendering the `summary-frame` template
 *
 * The result is written to `output.prompt`, fully replacing opencode's default
 * compaction prompt (strategy chosen in the plan: "overwrite with summary-frame").
 */

import { render } from './templates'
import { summaryTransform } from './transformers'
import type { ForgeMessage } from './types'

export interface CompactOptions {
	workingDir: string
}

export async function renderSummaryFrame(messages: ForgeMessage[], opts: CompactOptions): Promise<string> {
	const nonDroppable = messages.filter(m => !m.droppable)
	const transformed = summaryTransform(nonDroppable, opts.workingDir)
	return render('summary-frame', { messages: transformed })
}

/**
 * Best-effort conversion from an opencode message-part payload to a
 * `ForgeMessage`. Opencode's types are intentionally loose at this layer of the
 * plugin API, so we tolerate unknowns and only extract what the summary-frame
 * template actually consumes.
 */
export function toForgeMessage(raw: unknown): ForgeMessage | null {
	if (!raw || typeof raw !== 'object') return null
	const m = raw as Record<string, unknown>
	const role = m.role as ForgeMessage['role'] | undefined
	if (!role) return null

	const contents: ForgeMessage['contents'] = []
	const parts = Array.isArray(m.parts) ? m.parts : Array.isArray(m.contents) ? m.contents : []
	for (const part of parts) {
		if (!part || typeof part !== 'object') continue
		const p = part as Record<string, unknown>
		const type = p.type as string | undefined
		if (type === 'text' && typeof p.text === 'string') {
			contents.push({ text: p.text })
			continue
		}
		if (type === 'tool' || type === 'tool-invocation' || type === 'tool_call') {
			const name = (p.tool ?? p.name) as string | undefined
			const args = (p.args ?? p.input ?? {}) as Record<string, unknown>
			if (!name) continue
			contents.push({
				tool_call: {
					name,
					tool: mapToolVariant(name, args),
				},
			})
		}
	}
	return {
		role,
		contents,
		droppable: Boolean(m.droppable),
		reasoning_details: m.reasoning_details,
	}
}

function mapToolVariant(name: string, args: Record<string, unknown>): import('./types.ts').ForgeToolCall['tool'] {
	const path = (args.filePath ?? args.path ?? args.file) as string | undefined
	const pattern = (args.pattern ?? args.query) as string | undefined
	const command = (args.command ?? args.cmd) as string | undefined
	switch (name) {
		case 'read':
			return path ? { file_read: { path } } : {}
		case 'write':
		case 'edit':
		case 'multi_patch':
			return path ? { file_update: { path } } : {}
		case 'remove':
		case 'fs_remove':
			return path ? { file_remove: { path } } : {}
		case 'grep':
		case 'glob':
		case 'fs_search':
			return pattern ? { search: { pattern } } : {}
		case 'sem_search':
			return {
				sem_search: {
					queries: Array.isArray(args.queries)
						? (args.queries as Array<{ use_case: string }>)
						: pattern
							? [{ use_case: pattern }]
							: [],
				},
			}
		case 'bash':
		case 'shell':
			return command ? { shell: { command } } : {}
		case 'skill':
		case 'skill_fetch':
			return typeof args.name === 'string' ? { skill: { name: args.name } } : {}
		case 'todowrite':
		case 'todo_write':
			return { todo_write: { changes: [] } }
		default:
			if (name.startsWith('mcp_') || name.includes('.mcp.')) {
				return { mcp: { name } }
			}
			return {}
	}
}
