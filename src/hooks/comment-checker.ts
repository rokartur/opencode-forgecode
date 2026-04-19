/**
 * Comment Checker hook — wires the CommentChecker into tool.execute.after
 * to detect AI-slop comments in code written by agents.
 *
 * Only activates on mutating tools (write, edit, patch, multi_patch) and
 * only when the output looks like it contains code.
 *
 * Default: enabled with severity 'warn'.
 */

import { CommentChecker } from '../runtime/comment-checker'
import type { CommentCheckerConfig, Logger, PluginConfig } from '../types'

const MUTATING_TOOLS = new Set(['write', 'edit', 'patch', 'multi_patch'])

export interface CommentCheckerHooks {
	/** Call from tool.execute.after — appends warning to output when slop detected. */
	toolAfter: (input: { sessionID: string; tool: string }, output: { output: string }) => void
}

export function createCommentCheckerHooks(logger: Logger, config: PluginConfig): CommentCheckerHooks {
	const checkerConfig: CommentCheckerConfig = config.commentChecker ?? {}
	const checker = new CommentChecker(logger, checkerConfig)
	const severity = checkerConfig.severity ?? 'warn'

	return {
		toolAfter(input, output) {
			if (!checker.isEnabled()) return
			if (!MUTATING_TOOLS.has(input.tool)) return
			if (!output || typeof output.output !== 'string') return

			// Only check outputs that look like they contain code (have comment markers)
			const text = output.output
			if (!text.includes('//') && !text.includes('#') && !text.includes('/*')) return

			const result = checker.check(text)
			if (!result.warning) return

			if (severity === 'block') {
				output.output = [
					'❌ Comment Checker BLOCKED this edit — AI-slop comments detected.',
					'',
					result.warning,
					'',
					'Rewrite the code with clean, meaningful comments (or no comments at all).',
				].join('\n')
			} else {
				// Append warning after the output
				output.output = text + '\n\n' + result.warning
			}
		},
	}
}
