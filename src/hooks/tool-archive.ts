/**
 * Tool archive hook — intercepts large tool outputs in `tool.execute.after`
 * and replaces them with a compact preview + archive ID.
 *
 * Must run BEFORE harness truncation in the after chain so the preview
 * doesn't get double-processed by the truncator.
 */

import type { Hooks } from '@opencode-ai/plugin'
import type { ToolArchiveService } from '../services/tool-archive'
import type { Logger } from '../types'

interface ToolArchiveHookDeps {
	archiveService: ToolArchiveService
	logger: Logger
	enabled?: boolean
}

export function createToolArchiveAfterHook(deps: ToolArchiveHookDeps): Hooks['tool.execute.after'] {
	return async (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		input: { tool: string; sessionID: string; callID: string; args: any },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		output: { title: string; output: string; metadata: any },
	) => {
		if (deps.enabled === false) return
		if (!output.output || typeof output.output !== 'string') return
		if (deps.archiveService.isExempt(input.tool)) return
		if (output.output.length < deps.archiveService.threshold) return

		const { id, preview, charCount } = deps.archiveService.archive(input.sessionID, input.tool, output.output)

		output.output = [
			preview,
			'',
			`... (${charCount} chars total, truncated)`,
			`[Full result archived as ID: ${id}. Use the \`expand\` tool with id="${id}" to retrieve the complete output.]`,
		].join('\n')
	}
}
