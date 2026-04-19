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
	}): Promise<BackgroundTask> {
		const task = this.bgManager.enqueue(params)

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

			const promptResult = await this.v2.session.promptAsync({
				sessionID: sessionId,
				directory: this.directory,
				agent: task.targetAgent,
				parts: [{ type: 'text' as const, text: fullPrompt }],
			})

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

			// 2. Check running tasks for idle detection
			const running = this.bgManager.getByStatus('running')
			const now = Date.now()

			for (const task of running) {
				if (!task.sessionId) continue

				try {
					// Fetch latest output
					const sessResult = await this.v2.session.get({ sessionID: task.sessionId })
					if (sessResult.error || !sessResult.data) continue

					// Cast through unknown — runtime shape may include messages
					const session = sessResult.data as Record<string, unknown>
					const messages = (session.messages ?? []) as Array<{ role: string; content: unknown }>
					const lastMsg = messages[messages.length - 1]
					const outputHash = lastMsg ? `${messages.length}:${JSON.stringify(lastMsg).length}` : ''

					const prev = this.lastOutputHash.get(task.id)
					if (prev && prev.hash === outputHash) {
						// Same output — check idle timeout
						if (now - prev.since >= this.idleTimeoutMs) {
							// Idle detected → mark completed
							const summary = lastMsg
								? (typeof lastMsg.content === 'string'
										? lastMsg.content
										: JSON.stringify(lastMsg.content)
									).slice(0, 500)
								: '(no output)'
							this.bgManager.markCompleted(task.id, summary)
							this.lastOutputHash.delete(task.id)
							this.logger.log(`[bg-spawner] idle-completed task=${task.id}`)
							this.emitEvent('completed', task.id)
						}
					} else {
						// Output changed — reset idle timer
						const summary = lastMsg
							? (typeof lastMsg.content === 'string'
									? lastMsg.content
									: JSON.stringify(lastMsg.content)
								).slice(0, 500)
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
