/**
 * Session recovery — resilience layer that wraps model calls with
 * context-overflow recovery, timeout backoff, and 5xx/overload fallback.
 *
 * Integrates with the existing model-fallback chain and provides an audit
 * trail for every recovery action taken.
 */

import type { Logger } from '../types'
import { classifyModelError } from '../utils/model-fallback'

export type RecoveryAction =
	| 'compaction_retry'
	| 'timeout_backoff'
	| 'overload_backoff'
	| 'provider_fallback'
	| 'context_window_fallback'

export interface RecoveryEvent {
	timestamp: number
	sessionId: string
	action: RecoveryAction
	model?: string
	detail: string
	success: boolean
}

export interface SessionRecoveryPolicy {
	/** Maximum retries on context overflow (after compaction). Default: 2 */
	maxContextRetries: number
	/** Maximum retries on timeout with exponential backoff. Default: 3 */
	maxTimeoutRetries: number
	/** Initial backoff in ms for timeout retries. Default: 1000 */
	initialBackoffMs: number
	/** Maximum backoff in ms. Default: 30000 */
	maxBackoffMs: number
	/** Maximum retries on 5xx/overload. Default: 3 */
	maxOverloadRetries: number
}

const DEFAULT_POLICY: SessionRecoveryPolicy = {
	maxContextRetries: 2,
	maxTimeoutRetries: 3,
	initialBackoffMs: 1000,
	maxBackoffMs: 30000,
	maxOverloadRetries: 3,
}

export interface RecoveryCallbacks {
	/** Called when context overflow is detected — should compact/prune and return true if recovery succeeded. */
	onContextOverflow?: () => Promise<boolean>
	/** Called to log/audit recovery events. */
	onRecoveryEvent?: (event: RecoveryEvent) => void
}

export class SessionRecoveryManager {
	private policy: SessionRecoveryPolicy
	private logger: Logger
	private events: RecoveryEvent[] = []

	constructor(logger: Logger, policy?: Partial<SessionRecoveryPolicy>) {
		this.logger = logger
		this.policy = { ...DEFAULT_POLICY, ...policy }
	}

	/**
	 * Get all recovery events recorded during this session.
	 */
	getEvents(): readonly RecoveryEvent[] {
		return this.events
	}

	/**
	 * Clear recorded events (e.g. on session reset).
	 */
	clearEvents(): void {
		this.events = []
	}

	/**
	 * Wrap a model call with recovery logic.
	 *
	 * The `execute` callback is called repeatedly with increasing delay on
	 * transient failures. For context-overflow errors, `callbacks.onContextOverflow`
	 * is called first to attempt in-place recovery (compaction/pruning).
	 */
	async withRecovery<T>(
		sessionId: string,
		modelId: string | undefined,
		execute: () => Promise<T>,
		callbacks?: RecoveryCallbacks,
	): Promise<T> {
		let contextRetries = 0
		let timeoutRetries = 0
		let overloadRetries = 0
		let backoffMs = this.policy.initialBackoffMs

		while (true) {
			try {
				return await execute()
			} catch (err) {
				const classified = classifyModelError(err)

				switch (classified.kind) {
					case 'context_window': {
						if (contextRetries >= this.policy.maxContextRetries) {
							this.record(
								sessionId,
								'context_window_fallback',
								modelId,
								'exhausted context retries',
								false,
								callbacks,
							)
							throw err
						}
						contextRetries++
						this.record(
							sessionId,
							'compaction_retry',
							modelId,
							`attempt ${contextRetries}/${this.policy.maxContextRetries}`,
							true,
							callbacks,
						)

						if (callbacks?.onContextOverflow) {
							const recovered = await callbacks.onContextOverflow()
							if (!recovered) {
								this.record(
									sessionId,
									'context_window_fallback',
									modelId,
									'compaction did not free enough context',
									false,
									callbacks,
								)
								throw err
							}
						}
						continue
					}

					case 'timeout': {
						if (timeoutRetries >= this.policy.maxTimeoutRetries) {
							this.record(
								sessionId,
								'timeout_backoff',
								modelId,
								'exhausted timeout retries',
								false,
								callbacks,
							)
							throw err
						}
						timeoutRetries++
						this.record(
							sessionId,
							'timeout_backoff',
							modelId,
							`attempt ${timeoutRetries}/${this.policy.maxTimeoutRetries}, backoff ${backoffMs}ms`,
							true,
							callbacks,
						)
						await sleep(backoffMs)
						backoffMs = Math.min(backoffMs * 2, this.policy.maxBackoffMs)
						continue
					}

					case 'overloaded': {
						if (overloadRetries >= this.policy.maxOverloadRetries) {
							this.record(
								sessionId,
								'overload_backoff',
								modelId,
								'exhausted overload retries',
								false,
								callbacks,
							)
							throw err
						}
						overloadRetries++
						const overloadBackoff = Math.min(
							this.policy.initialBackoffMs * Math.pow(2, overloadRetries),
							this.policy.maxBackoffMs,
						)
						this.record(
							sessionId,
							'overload_backoff',
							modelId,
							`attempt ${overloadRetries}/${this.policy.maxOverloadRetries}, backoff ${overloadBackoff}ms`,
							true,
							callbacks,
						)
						await sleep(overloadBackoff)
						continue
					}

					default:
						// provider errors or unknown — don't retry, let the fallback chain handle it
						this.record(sessionId, 'provider_fallback', modelId, classified.message, false, callbacks)
						throw err
				}
			}
		}
	}

	private record(
		sessionId: string,
		action: RecoveryAction,
		model: string | undefined,
		detail: string,
		success: boolean,
		callbacks?: RecoveryCallbacks,
	): void {
		const event: RecoveryEvent = {
			timestamp: Date.now(),
			sessionId,
			action,
			model,
			detail,
			success,
		}
		this.events.push(event)
		this.logger.log(`[recovery] ${action}: ${detail} (model=${model ?? 'default'}, success=${success})`)
		callbacks?.onRecoveryEvent?.(event)
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}
