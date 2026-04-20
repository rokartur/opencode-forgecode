/**
 * Hook factory that wires the forge harness into the opencode plugin surface.
 *
 * Produces `before` / `after` callbacks for `tool.execute.*` plus an event
 * handler that feeds todo updates into the pending-todo tracker and emits a
 * doom-loop reminder through the TUI when the detector fires.
 *
 * The compactor is exposed separately because the plugin entrypoint owns the
 * `experimental.session.compacting` hook and needs to call the renderer
 * directly.
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { HarnessConfig, Logger } from '../types'
import {
	captureSnapshot,
	DoomLoopDetector,
	PendingTodosTracker,
	renderSummaryFrame,
	signatureOf,
	toForgeMessage,
	truncateForTool,
	type ForgeMessage,
	type ForgePendingTodo,
} from '../harness'

const MUTATING_TOOLS = new Set(['write', 'edit', 'multi_patch', 'patch', 'ast-rewrite'])

/** Cap on any callback into opencode (TUI append) — prevents hook from ever blocking a tool call. */
const APPEND_PROMPT_TIMEOUT_MS = 2_000

const DEFAULT_CONFIG: Required<Omit<HarnessConfig, 'truncation'>> & {
	truncation: Required<NonNullable<HarnessConfig['truncation']>>
} = {
	enabled: true,
	doomLoopThreshold: 3,
	pendingTodosReminder: true,
	snapshots: true,
	compaction: true,
	hashAnchoredPatch: true,
	plugins: [],
	truncation: {
		enabled: true,
	},
}

interface HarnessHookDeps {
	logger: Logger
	projectId: string
	directory: string
	dataDir: string
	config?: HarnessConfig
	/**
	 * Optional callback used to surface doom-loop reminders in the TUI. When
	 * omitted the reminder is only logged — the plugin entrypoint supplies a
	 * real implementation that calls `client.tui.appendPrompt()`.
	 */
	appendPrompt?: (sessionId: string, text: string) => Promise<void> | void
}

export interface HarnessHooks {
	toolBefore: (input: { sessionID: string; tool: string; args: unknown }) => Promise<void>
	toolAfter: (input: { sessionID: string; tool: string }, output: { output: string }) => Promise<void>
	onEvent: (input: { event: { type: string; properties?: Record<string, unknown> } }) => Promise<void>
	compact: (input: { sessionID: string }, output: { context: string[]; prompt?: string }) => Promise<void>
	/**
	 * Called by the plugin entrypoint whenever it has fresh `experimental.chat.messages.transform`
	 * output — feeds the latest message list into the compactor's message cache
	 * so compaction can see them without an extra round-trip.
	 */
	rememberMessages: (sessionId: string, messages: unknown[]) => void
}

interface SessionState {
	messages: unknown[]
}

export function createHarnessHooks(deps: HarnessHookDeps): HarnessHooks {
	const cfg = mergeConfig(deps.config)
	const logger = deps.logger
	const detector = new DoomLoopDetector(cfg.doomLoopThreshold)
	const todos = new PendingTodosTracker()
	const sessions = new Map<string, SessionState>()

	const state = (sessionId: string): SessionState => {
		const existing = sessions.get(sessionId)
		if (existing) return existing
		const s: SessionState = { messages: [] }
		sessions.set(sessionId, s)
		return s
	}

	const reset = (sessionId: string): void => {
		sessions.delete(sessionId)
		detector.reset(sessionId)
		todos.reset(sessionId)
	}

	return {
		async toolBefore(input) {
			if (!cfg.enabled) return
			const { sessionID, tool, args } = input

			if (cfg.snapshots && MUTATING_TOOLS.has(tool)) {
				const path = extractPath(args)
				if (path) {
					try {
						const abs = resolve(deps.directory, path)
						await captureSnapshot(abs, {
							dataDir: deps.dataDir,
							sessionId: sessionID,
							workingDir: deps.directory,
						})
					} catch (err) {
						logger.debug(`harness: snapshot capture failed for ${path}`, err)
					}
				}
			}

			detector.record(sessionID, signatureOf(tool, args))
			const reps = detector.detect(sessionID)
			if (reps !== null && !detector.hasWarned(sessionID)) {
				detector.markWarned(sessionID)
				const text = await detector.reminder(reps)
				logger.log(`harness: doom-loop detected (${reps}x) for session ${sessionID}`)
				if (deps.appendPrompt) {
					try {
						await withTimeout(
							Promise.resolve(deps.appendPrompt(sessionID, text)),
							APPEND_PROMPT_TIMEOUT_MS,
							'appendPrompt',
						)
					} catch (err) {
						logger.debug('harness: appendPrompt failed or timed out', err)
					}
				}
			}
		},

		async toolAfter(_input, output) {
			if (!cfg.enabled || !cfg.truncation.enabled) return
			if (!output || typeof output.output !== 'string') return
			const truncated = truncateForTool(_input.tool, output.output)
			if (truncated !== output.output) {
				output.output = truncated
			}
		},

		async onEvent(input) {
			if (!cfg.enabled) return
			const ev = input.event
			if (!ev) return

			if (ev.type === 'session.idle' || ev.type === 'session.completed') {
				const sessionId = String(ev.properties?.sessionId ?? ev.properties?.sessionID ?? '')
				if (!sessionId) return
				if (cfg.pendingTodosReminder) {
					const reminder = await todos.buildReminder(sessionId)
					if (reminder && deps.appendPrompt) {
						try {
							await withTimeout(
								Promise.resolve(deps.appendPrompt(sessionId, reminder)),
								APPEND_PROMPT_TIMEOUT_MS,
								'appendPrompt',
							)
							logger.log(`harness: pending-todos reminder sent for ${sessionId}`)
						} catch (err) {
							logger.debug('harness: appendPrompt pending-todos failed or timed out', err)
						}
					}
				}
				return
			}

			if (ev.type === 'todo.updated' || ev.type === 'todos.updated') {
				const sessionId = String(ev.properties?.sessionId ?? ev.properties?.sessionID ?? '')
				if (!sessionId) return
				const raw = ev.properties?.todos
				if (!Array.isArray(raw)) return
				const parsed = raw
					.map((t): ForgePendingTodo | null => {
						if (!t || typeof t !== 'object') return null
						const tr = t as Record<string, unknown>
						const status = tr.status as ForgePendingTodo['status'] | undefined
						const content = typeof tr.content === 'string' ? tr.content : null
						if (!status || !content) return null
						return { status, content }
					})
					.filter((t): t is ForgePendingTodo => t !== null)
				todos.update(sessionId, parsed)
				return
			}

			if (ev.type === 'session.deleted' || ev.type === 'session.ended') {
				const sessionId = String(ev.properties?.sessionId ?? ev.properties?.sessionID ?? '')
				if (sessionId) reset(sessionId)
			}
		},

		async compact(input, output) {
			if (!cfg.enabled || !cfg.compaction) return
			const { sessionID } = input
			const msgs = state(sessionID).messages
			if (msgs.length === 0) {
				logger.debug(`harness: no cached messages for session ${sessionID}, skipping summary-frame`)
				return
			}
			const forgeMsgs = msgs.map(m => toForgeMessage(m)).filter((m): m is ForgeMessage => m !== null)
			if (forgeMsgs.length === 0) return
			output.prompt = await renderSummaryFrame(forgeMsgs, { workingDir: deps.directory })
			logger.log(`harness: summary-frame applied for session ${sessionID}`)
		},

		rememberMessages(sessionId, messages) {
			if (!cfg.enabled || !cfg.compaction) return
			state(sessionId).messages = messages
		},
	}
}

function mergeConfig(user?: HarnessConfig): typeof DEFAULT_CONFIG {
	return {
		enabled: user?.enabled ?? DEFAULT_CONFIG.enabled,
		doomLoopThreshold: user?.doomLoopThreshold ?? DEFAULT_CONFIG.doomLoopThreshold,
		pendingTodosReminder: user?.pendingTodosReminder ?? DEFAULT_CONFIG.pendingTodosReminder,
		snapshots: user?.snapshots ?? DEFAULT_CONFIG.snapshots,
		compaction: user?.compaction ?? DEFAULT_CONFIG.compaction,
		hashAnchoredPatch: user?.hashAnchoredPatch ?? DEFAULT_CONFIG.hashAnchoredPatch,
		plugins: user?.plugins ?? DEFAULT_CONFIG.plugins,
		truncation: {
			enabled: user?.truncation?.enabled ?? DEFAULT_CONFIG.truncation.enabled,
		},
	}
}

function extractPath(args: unknown): string | null {
	if (!args || typeof args !== 'object') return null
	const r = args as Record<string, unknown>
	const path = r.filePath ?? r.path ?? r.file
	return typeof path === 'string' ? path : null
}

/**
 * Race a promise against a timeout. Rejects with a descriptive Error if the
 * promise does not settle within `ms`. Used to cap any callback into opencode
 * (e.g. `client.tui.appendPrompt`) so a hung host can never block a tool call.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | null = null
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/** Stable hash for request-args used in metrics/logs (unused by runtime). */
export function hashArgs(args: unknown): string {
	try {
		return createHash('sha1')
			.update(JSON.stringify(args ?? {}))
			.digest('hex')
			.slice(0, 12)
	} catch {
		return 'unhashable'
	}
}
