/**
 * BackgroundSpawner — creates real OpenCode sessions for background tasks
 * via the v2 SDK, and manages the polling loop for idle detection.
 *
 * Lifecycle:
 *  1. ConcurrencyManager says a task can start.
 *  2. Spawner creates a session, sends the prompt, marks the task running.
 *  3. Poller periodically checks output; after idleTimeoutMs of no change → completed.
 *  4. On error → marks task error.
 */

import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { BackgroundManager, BackgroundTask } from './manager'
import type { ConcurrencyManager } from './concurrency'
import { DEFAULT_POLL_INTERVAL_MS, DEFAULT_IDLE_TIMEOUT_MS } from '../../constants/background'
import {
	parseModelString,
	resolveFallbackModelEntries,
	retryWithModelFallback,
} from '../../utils/model-fallback'
import type { FallbackEntry } from '../../types'

export interface SpawnerConfig {
	pollIntervalMs?: number
	idleTimeoutMs?: number
	/**
	 * Optional listener for lifecycle transitions. Fires when a task
	 * reaches a terminal state (completed, error, cancelled). Used by the
	 * plugin to emit TUI toasts for user visibility.
	 */
	onTaskEvent?: (event: { type: 'completed' | 'error' | 'cancelled'; task: BackgroundTask }) => void
}

export class BackgroundSpawner {
	private pollTimer: ReturnType<typeof setInterval> | null = null
	/** Last known output hash per task — used for idle detection. */
	private lastOutputHash = new Map<string, { hash: string; since: number }>()
	/** Fallback model chains stashed per task, consumed by startTask. */
	private taskFallbacks = new Map<string, Array<string | FallbackEntry>>()
	private readonly pollIntervalMs: number
	private readonly idleTimeoutMs: number
	private readonly onTaskEvent?: SpawnerConfig['onTaskEvent']

	constructor(
		private readonly v2: ReturnType<typeof createV2Client>,
		private readonly bgManager: BackgroundManager,
		private readonly concurrency: ConcurrencyManager,
		private readonly directory: string,
		private readonly logger: { log: (...args: unknown[]) => void },
		config?: SpawnerConfig,
	) {
		this.pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
		this.idleTimeoutMs = config?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
		this.onTaskEvent = config?.onTaskEvent
	}

	/** Safely emit a lifecycle event; errors in the listener are swallowed. */
	private emitEvent(type: 'completed' | 'error' | 'cancelled', taskId: string): void {
		if (!this.onTaskEvent) return
		const task = this.bgManager.getById(taskId)
		if (!task) return
		try {
			this.onTaskEvent({ type, task })
		} catch {
			// Listener errors must not affect spawner operation.
		}
	}

	// ---- public API ----

	/**
	 * Enqueue a task, immediately start it if concurrency allows,
	 * and ensure the poll loop is running.
	 */
	async spawn(params: {
		id: string
		parentAgent: string
		targetAgent: string
		prompt: string
		context?: string
		model: string
		fallbackModels?: Array<string | FallbackEntry>
	}): Promise<BackgroundTask> {
		const task = this.bgManager.enqueue(params)

		// Stash fallback models for use in startTask
		if (params.fallbackModels?.length) {
			this.taskFallbacks.set(task.id, params.fallbackModels)
		}

		// Try to start immediately
		if (this.concurrency.canStart(task.model)) {
			await this.startTask(task.id)
		}

		this.ensurePolling()
		return this.bgManager.getById(task.id)!
	}

	/** Cancel a task; abort the session if running. */
	async cancel(taskId: string): Promise<boolean> {
		const task = this.bgManager.getById(taskId)
		if (!task) return false

		const cancelled = this.bgManager.cancel(taskId)
		if (!cancelled) return false

		if (task.sessionId) {
			try {
				await this.v2.session.abort({ sessionID: task.sessionId })
			} catch {
				// best-effort
			}
		}

		this.lastOutputHash.delete(taskId)
		this.emitEvent('cancelled', taskId)
		return true
	}

	/** Shut down: cancel all running tasks, clear timer. */
	async shutdown(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
		}

		const running = this.bgManager.getByStatus('running')
		for (const task of running) {
			await this.cancel(task.id)
		}

		// Also cancel pending
		const pending = this.bgManager.getByStatus('pending')
		for (const task of pending) {
			this.bgManager.cancel(task.id)
		}
	}

	// ---- internal ----

	private async startTask(taskId: string): Promise<void> {
		const task = this.bgManager.getById(taskId)
		if (!task || task.status !== 'pending') return

		try {
			const createResult = await this.v2.session.create({
				title: `bg: ${task.targetAgent} — ${task.prompt.slice(0, 60)}`,
				directory: this.directory,
			})

			if (createResult.error || !createResult.data) {
				this.bgManager.markError(taskId, `Session creation failed: ${JSON.stringify(createResult.error)}`)
				this.emitEvent('error', taskId)
				return
			}

			const sessionId = createResult.data.id
			this.bgManager.markRunning(taskId, sessionId)

			const fullPrompt = task.context ? `${task.context}\n\n---\n\n${task.prompt}` : task.prompt

			// Resolve model and fallbacks for the prompt
			const primaryModel = parseModelString(task.model)
			const fallbacks = this.taskFallbacks.get(taskId)
			const fallbackModels = resolveFallbackModelEntries(fallbacks)
			this.taskFallbacks.delete(taskId)

			const promptParts = [{ type: 'text' as const, text: fullPrompt }]
			const { result: promptResult, usedModel } = await retryWithModelFallback(
				candidate =>
					this.v2.session.promptAsync({
						sessionID: sessionId,
						directory: this.directory,
						agent: task.targetAgent,
						model: candidate,
						parts: promptParts,
					}),
				() =>
					this.v2.session.promptAsync({
						sessionID: sessionId,
						directory: this.directory,
						agent: task.targetAgent,
						parts: promptParts,
					}),
				primaryModel,
				{ error: (msg: string, err?: unknown) => this.logger.log(msg, err), log: (msg: string) => this.logger.log(msg) },
				{ fallbackModels, maxRetries: 2 },
			)

			if (usedModel && primaryModel && usedModel.modelID !== primaryModel.modelID) {
				this.logger.log(
					`[bg-spawner] task=${taskId} used fallback model ${usedModel.providerID}/${usedModel.modelID}`,
				)
			}

			if (promptResult.error) {
				this.bgManager.markError(taskId, `Prompt failed: ${JSON.stringify(promptResult.error)}`)
				this.emitEvent('error', taskId)
				return
			}

			this.logger.log(`[bg-spawner] started task=${taskId} session=${sessionId} agent=${task.targetAgent}`)
		} catch (err) {
			this.bgManager.markError(taskId, `Spawn error: ${err instanceof Error ? err.message : String(err)}`)
			this.emitEvent('error', taskId)
		}
	}

	private ensurePolling(): void {
		if (this.pollTimer) return
		this.pollTimer = setInterval(() => this.pollCycle(), this.pollIntervalMs)
	}

	private async pollCycle(): Promise<void> {
		try {
			// 1. Drain pending → start if concurrency allows
			const toStart = this.concurrency.drainPending()
			for (const taskId of toStart) {
				await this.startTask(taskId)
			}

			// 2. Check running tasks for idle detection using session.status()
			// and session.messages() per the official OpenCode SDK API.
			// @see https://opencode.ai/docs/sdk — session.status(), session.messages()
			const running = this.bgManager.getByStatus('running')
			const now = Date.now()

			// Batch-fetch session statuses: { [sessionID]: SessionStatus }
			let sessionStatuses: Record<string, { type: string }> = {}
			try {
				const statusResult = await this.v2.session.status()
				if (!statusResult.error && statusResult.data) {
					sessionStatuses = statusResult.data as Record<string, { type: string }>
				}
			} catch {
				// Status fetch failure is non-fatal; fall back to message-based detection
			}

			for (const task of running) {
				if (!task.sessionId) continue

				try {
					// Check session status first (most efficient)
					const status = sessionStatuses[task.sessionId]
					const isIdle = status?.type === 'idle'

					if (isIdle) {
						// Session is idle — fetch messages to get final output
						const msgsResult = await this.v2.session.messages({
							sessionID: task.sessionId,
							directory: this.directory,
							limit: 5,
						})

						const messages = (msgsResult.data ?? []) as Array<{
							info: { role: string }
							parts: Array<{ type: string; text?: string }>
						}>

						const lastAssistant = messages.filter(m => m.info.role === 'assistant').pop()

						const summary = lastAssistant
							? lastAssistant.parts
									.filter(p => p.type === 'text' && p.text)
									.map(p => p.text!)
									.join('\n')
									.slice(0, 500)
							: '(no output)'

						this.bgManager.markCompleted(task.id, summary)
						this.lastOutputHash.delete(task.id)
						this.logger.log(`[bg-spawner] idle-completed task=${task.id}`)
						this.emitEvent('completed', task.id)
						continue
					}

					// Session is still busy — use messages endpoint for output tracking
					const msgsResult = await this.v2.session.messages({
						sessionID: task.sessionId,
						directory: this.directory,
						limit: 3,
					})

					const messages = (msgsResult.data ?? []) as Array<{
						info: { role: string }
						parts: Array<{ type: string; text?: string }>
					}>

					const lastMsg = messages[messages.length - 1]
					const outputHash = lastMsg ? `${messages.length}:${JSON.stringify(lastMsg.parts).length}` : ''

					const prev = this.lastOutputHash.get(task.id)
					if (prev && prev.hash === outputHash) {
						// Same output — check idle timeout as fallback
						if (now - prev.since >= this.idleTimeoutMs) {
							const summary = lastMsg
								? lastMsg.parts
										.filter(p => p.type === 'text' && p.text)
										.map(p => p.text!)
										.join('\n')
										.slice(0, 500)
								: '(no output)'
							this.bgManager.markCompleted(task.id, summary)
							this.lastOutputHash.delete(task.id)
							this.logger.log(`[bg-spawner] idle-timeout-completed task=${task.id}`)
							this.emitEvent('completed', task.id)
						}
					} else {
						// Output changed — reset idle timer and update summary
						const summary = lastMsg
							? lastMsg.parts
									.filter(p => p.type === 'text' && p.text)
									.map(p => p.text!)
									.join('\n')
									.slice(0, 500)
							: ''
						this.bgManager.updateSummary(task.id, summary)
						this.lastOutputHash.set(task.id, { hash: outputHash, since: now })
					}
				} catch {
					// Polling errors are not fatal — retry next cycle
				}
			}

			// 3. Stop polling if nothing is pending or running
			if (running.length === 0 && this.bgManager.countPending() === 0) {
				if (this.pollTimer) {
					clearInterval(this.pollTimer)
					this.pollTimer = null
				}
			}
		} catch {
			// Poll cycle errors are not fatal
		}
	}
}
