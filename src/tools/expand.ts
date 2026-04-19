/**
 * `expand` tool — retrieves full content of archived tool results.
 *
 * When a tool output exceeds the archive threshold, it is stored on disk and
 * replaced with a short preview. This tool lets the model retrieve the full
 * output when it actually needs the complete content.
 */

import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import type { ToolArchiveService } from '../services/tool-archive'

const z = tool.schema

export function createExpandTools(
	ctx: ToolContext,
	archiveService: ToolArchiveService | null,
): Record<string, ReturnType<typeof tool>> {
	if (!archiveService) return {}

	return {
		expand: tool({
			description:
				'Retrieve the full output of a previously archived tool result. ' +
				'When a tool result was too large, it was archived and replaced with a preview + an archive ID. ' +
				'Use this tool with that ID to get the complete output. ' +
				'Use action="list" to see all archived results for this session.',
			args: {
				id: z
					.string()
					.optional()
					.describe('The archive ID to retrieve (from the "[Full result archived as ID: ...]" message)'),
				action: z
					.enum(['get', 'list'])
					.optional()
					.describe('Action to perform. "get" (default) retrieves by ID, "list" shows all archives.'),
			},
			execute: async (args, context) => {
				const action = args.action ?? 'get'

				if (action === 'list') {
					const entries = archiveService.list(context.sessionID)
					if (entries.length === 0) {
						return 'No archived results for this session.'
					}
					const lines = entries.map(
						e =>
							`- ID: ${e.id} | Tool: ${e.toolName} | Size: ${e.charCount} chars | ${new Date(e.archivedAt).toISOString()}`,
					)
					return `Archived results (${entries.length}):\n${lines.join('\n')}`
				}

				// get
				if (!args.id) {
					return 'Error: `id` is required. Use action="list" to see available archive IDs.'
				}

				const full = archiveService.retrieve(args.id)
				if (full === null) {
					return `Archive not found for ID: ${args.id}. It may have expired (24h TTL). Use action="list" to see available archives.`
				}

				ctx.logger.log(`[expand] retrieved archive ${args.id} (${full.length} chars)`)
				return full
			},
		}),
	}
}
