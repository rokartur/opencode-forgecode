import type { Logger, CompactionConfig } from '../types'
import type { PluginInput } from '@opencode-ai/plugin'
import { buildCustomCompactionPrompt } from './compaction-utils'

export interface SessionHooks {
	onMessage: (input: unknown, output: unknown) => Promise<void>
	onEvent: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
	onCompacting: (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>
}

interface ChatMessageInput {
	sessionID?: string
}

interface EventInput {
	event: {
		type: string
		properties?: Record<string, unknown>
	}
}

interface CompactingInput {
	sessionID: string
}

interface CompactingOutput {
	context: string[]
	prompt?: string
}

const LOGGED_EVENTS = new Set(['session.compacted', 'session.status', 'session.updated', 'session.created'])

function formatEventProperties(props?: Record<string, unknown>): string {
	if (!props) return ''
	try {
		return ' ' + JSON.stringify(props)
	} catch {
		return ''
	}
}

const DEFAULT_COMPACTION_CONFIG: CompactionConfig = {
	customPrompt: true,
	// Long-session tuning: increased from 4000 to 16000 so the summary-frame
	// retains more working context (file paths, decisions, todo state) when
	// compaction fires.  Overridden by forge-config.jsonc `maxContextTokens: 0`
	// which means "no plugin-side limit" — this default only applies when the
	// config key is missing entirely.
	maxContextTokens: 16_000,
}

export function createSessionHooks(
	projectId: string,
	logger: Logger,
	_ctx: PluginInput,
	config?: CompactionConfig,
): SessionHooks {
	const initializedSessions = new Set<string>()
	const compactionConfig = { ...DEFAULT_COMPACTION_CONFIG, ...config }

	return {
		async onMessage(input, _output) {
			const chatInput = input as ChatMessageInput
			const sessionId = chatInput.sessionID
			if (!sessionId) return
			if (!initializedSessions.has(sessionId)) {
				logger.log(`Session initialized: ${sessionId} (project ${projectId})`)
				initializedSessions.add(sessionId)
			}
		},
		async onEvent(input: EventInput) {
			const { event } = input
			if (event && LOGGED_EVENTS.has(event.type)) {
				logger.log(`Event received: ${event.type}${formatEventProperties(event.properties)}`)
			}
			if (event?.type !== 'session.compacted') return

			const sessionId = (event.properties?.sessionId as string) ?? (event.properties?.sessionID as string)
			if (!sessionId) {
				logger.log(`session.compacted event missing sessionId`)
				return
			}

			logger.log(`Session compacted for project ${projectId}`)
		},
		async onCompacting(input: CompactingInput, output: CompactingOutput) {
			const { sessionID: sessionId } = input
			logger.log(`Compacting hook fired for project ${projectId}, session ${sessionId}`)

			if (compactionConfig.customPrompt) {
				output.prompt = buildCustomCompactionPrompt()
				logger.log(`Compacting: set custom compaction prompt`)
			}
		},
	}
}
