/**
 * Tool result archive — stores large tool outputs on disk (via KV) and
 * replaces them with a compact preview + archive ID. The model can later
 * retrieve the full output through the `expand` tool.
 *
 * This reduces context window usage by keeping only a short preview of
 * grep/search/shell outputs that are rarely referenced in full.
 */

import type { KvService } from './kv'
import type { Logger } from '../types'

export interface ToolArchiveConfig {
	/** Enable tool result archiving. Defaults to true. */
	enabled?: boolean
	/** Minimum output size (chars) to trigger archiving. Defaults to 4096. */
	thresholdChars?: number
	/** TTL for archived entries in milliseconds. Defaults to 24h. */
	ttlMs?: number
	/** Tools whose output should never be archived. */
	exemptTools?: string[]
}

export interface ArchivedEntry {
	id: string
	sessionId: string
	toolName: string
	fullOutput: string
	preview: string
	charCount: number
	archivedAt: number
}

const DEFAULT_EXEMPT_TOOLS = new Set([
	'plan-read',
	'plan-write',
	'plan-append',
	'plan-edit',
	'review-read',
	'expand',
	'graph-status',
	'loop-status',
	'quality',
])

let idCounter = 0

function generateId(): string {
	const ts = Date.now().toString(36)
	const seq = (idCounter++).toString(36)
	return `${ts}-${seq}`.slice(-8)
}

function buildPreview(output: string, lineCount = 5): string {
	const lines = output.split('\n')
	const previewLines = lines.slice(0, lineCount)
	return previewLines.join('\n')
}

export interface ToolArchiveService {
	archive(sessionId: string, toolName: string, output: string): { id: string; preview: string; charCount: number }
	retrieve(id: string): string | null
	list(sessionId?: string): Array<{ id: string; toolName: string; charCount: number; archivedAt: number }>
	isExempt(toolName: string): boolean
	readonly threshold: number
}

export function createToolArchiveService(
	kvService: KvService,
	projectId: string,
	logger: Logger,
	config?: ToolArchiveConfig,
): ToolArchiveService {
	const threshold = config?.thresholdChars ?? 4096
	const exemptTools = new Set([...DEFAULT_EXEMPT_TOOLS, ...(config?.exemptTools ?? [])])

	return {
		threshold,

		isExempt(toolName: string): boolean {
			return exemptTools.has(toolName)
		},

		archive(sessionId: string, toolName: string, output: string) {
			const id = generateId()
			const preview = buildPreview(output)
			const charCount = output.length
			const entry: ArchivedEntry = {
				id,
				sessionId,
				toolName,
				fullOutput: output,
				preview,
				charCount,
				archivedAt: Date.now(),
			}
			kvService.set(projectId, `archive:${id}`, entry)
			logger.log(`[tool-archive] archived ${toolName} result (${charCount} chars) as ${id}`)
			return { id, preview, charCount }
		},

		retrieve(id: string): string | null {
			const entry = kvService.get<ArchivedEntry>(projectId, `archive:${id}`)
			if (!entry) return null
			return entry.fullOutput
		},

		list(sessionId?: string) {
			const entries = kvService.listByPrefix(projectId, 'archive:')
			return entries
				.map(e => {
					const d = e.data as ArchivedEntry | null
					if (!d) return null
					if (sessionId && d.sessionId !== sessionId) return null
					return { id: d.id, toolName: d.toolName, charCount: d.charCount, archivedAt: d.archivedAt }
				})
				.filter((e): e is NonNullable<typeof e> => e !== null)
				.sort((a, b) => b.archivedAt - a.archivedAt)
		},
	}
}
