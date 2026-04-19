/**
 * `quality` tool — reports the current context quality score for the session.
 */

import { tool } from '@opencode-ai/plugin'
import type { ToolContext } from './types'
import type { QualityScorer } from '../harness/quality-score'
import { formatQualityReport } from '../harness/quality-score'

const z = tool.schema

export function createQualityTools(
	_ctx: ToolContext,
	qualityScorer: QualityScorer | null,
): Record<string, ReturnType<typeof tool>> {
	if (!qualityScorer) return {}

	return {
		quality: tool({
			description:
				'Show the current context quality score for this session. ' +
				'Returns a 0–100 composite score with letter grade (S/A/B/C/D/F) ' +
				'and per-signal breakdown. Use this to check if context is degrading.',
			args: {},
			execute: async (_args, context) => {
				const result = qualityScorer.compute(context.sessionID)
				return formatQualityReport(result)
			},
		}),
	}
}
