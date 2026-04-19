/**
 * Auto-retry for **non-loop** sessions that fail with a transient provider
 * timeout. The loop event handler (`src/hooks/loop.ts`) already takes care of
 * loop sessions — it marks `modelFailed` and falls through to the fallback
 * chain on the next iteration. Non-loop sessions (plain muse/sage/forge chat,
 * plan-execute dispatch, agent-as-tool, ...) have no such safety net, so a
 * single SSE timeout surfaces as "Tool execution aborted / The operation
 * timed out" and the user has to manually re-send.
 *
 * This hook performs **one** retry per user message on:
 *   - classified kind === 'timeout' AND
 *   - error name is NOT MessageAbortedError / AbortError (those mean the user
 *     pressed Esc — we must not re-dispatch automatically).
 *
 * Budget: 1 retry per messageID, 2s backoff. Prevents infinite retry storms
 * when the provider is genuinely down.
 */

import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { LoopService } from '../services/loop'
import type { Logger } from '../types'
import { classifyModelError } from '../utils/model-fallback'

interface LastPromptEntry {
	messageId: string
	text: string
	agent?: string
}

export interface SessionRetryHookDeps {
	loopService: LoopService
	v2: OpencodeClient
	directory: string
	logger: Logger
	/** Optional override for the retry backoff (ms). Default 2000. */
	backoffMs?: number
}

export interface SessionRetryHooks {
	onMessagesTransform: (output: {
		messages: Array<{
			info: { role: string; agent?: string; id?: string; sessionID?: string }
			parts: Array<Record<string, unknown>>
		}>
	}) => void
	onEvent: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
	/** Testing helper. */
	__reset(): void
}

export function createSessionRetryHooks(deps: SessionRetryHookDeps): SessionRetryHooks {
	const lastPrompt = new Map<string, LastPromptEntry>()
	const retriedMessages = new Set<string>()
	const backoffMs = deps.backoffMs ?? 2_000

	return {
		onMessagesTransform(output) {
			for (let i = output.messages.length - 1; i >= 0; i--) {
				const m = output.messages[i]
				if (m.info.role !== 'user') continue
				const sessionId = m.info.sessionID
				const messageId = m.info.id
				if (!sessionId || !messageId) return
				const text = extractText(m.parts)
				if (!text) return
				lastPrompt.set(sessionId, { messageId, text, agent: m.info.agent })
				return
			}
		},

		async onEvent(input) {
			const ev = input.event
			if (ev?.type !== 'session.error') return

			const errorProps = ev.properties as {
				sessionID?: string
				error?: { name?: string; data?: { message?: string } }
			}
			const sessionId = errorProps?.sessionID
			if (!sessionId) return

			// Loop sessions have their own error handling — skip.
			if (deps.loopService.resolveLoopName(sessionId)) return

			const errorName = errorProps?.error?.name ?? ''
			const errorMessage = errorProps?.error?.data?.message ?? errorName
			// Provider stream-timeouts (e.g. tool-call args taking too long to stream,
			// surfaces in the TUI as "Tool execution aborted / The operation timed out")
			// frequently bubble up with `name === 'MessageAbortedError'` — the same
			// name the server uses for a user Esc. Distinguish them by the message:
			// a real user abort has no timeout-y text, while stream timeouts carry
			// "timed out", "operation timed out", "deadline exceeded", etc.
			const looksLikeTimeoutMessage =
				/timed out|timeout|operation timed out|deadline exceeded|etimedout|econnreset|stream.*(abort|closed|ended)/i.test(
					errorMessage,
				)
			const isAbortName = errorName === 'MessageAbortedError' || errorName === 'AbortError'
			if (isAbortName && !looksLikeTimeoutMessage) return

			const classified = classifyModelError(errorMessage)
			if (classified.kind !== 'timeout' && !(isAbortName && looksLikeTimeoutMessage)) return

			const entry = lastPrompt.get(sessionId)
			if (!entry) {
				deps.logger.debug(`session-retry: no cached prompt for session ${sessionId}, skipping`)
				return
			}

			if (retriedMessages.has(entry.messageId)) {
				deps.logger.log(`session-retry: message ${entry.messageId} already retried once, not retrying again`)
				return
			}
			retriedMessages.add(entry.messageId)

			deps.logger.log(
				`session-retry: auto-retrying session ${sessionId} after timeout (message ${entry.messageId})`,
			)

			await new Promise(resolve => setTimeout(resolve, backoffMs))

			try {
				const result = await deps.v2.session.promptAsync({
					sessionID: sessionId,
					directory: deps.directory,
					parts: [{ type: 'text', text: entry.text }],
					...(entry.agent && { agent: entry.agent }),
				})
				if (result.error) {
					deps.logger.error(`session-retry: retry failed for session ${sessionId}`, result.error)
				} else {
					deps.logger.log(`session-retry: retry dispatched for session ${sessionId}`)
				}
			} catch (err) {
				deps.logger.error(`session-retry: retry threw for session ${sessionId}`, err)
			}
		},

		__reset() {
			lastPrompt.clear()
			retriedMessages.clear()
		},
	}
}

function extractText(parts: Array<Record<string, unknown>>): string | null {
	const chunks: string[] = []
	for (const p of parts) {
		if (p.type === 'text' && typeof p.text === 'string') {
			chunks.push(p.text)
		}
	}
	if (chunks.length === 0) return null
	return chunks.join('\n').trim() || null
}
