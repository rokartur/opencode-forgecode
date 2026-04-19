/**
 * ConcurrencyManager — enforces global and per-model concurrency limits
 * for background tasks.  Tasks that exceed the limit stay `pending` until
 * a running slot frees up.
 */

import type { BackgroundManager } from './manager'
import { DEFAULT_MAX_CONCURRENT, DEFAULT_PER_MODEL_LIMIT } from '../../constants/background'

export interface ConcurrencyLimits {
	maxConcurrent: number
	perModelLimit: number
}

export class ConcurrencyManager {
	private readonly maxConcurrent: number
	private readonly perModelLimit: number

	constructor(
		private readonly bgManager: BackgroundManager,
		limits?: Partial<ConcurrencyLimits>,
	) {
		this.maxConcurrent = limits?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
		this.perModelLimit = limits?.perModelLimit ?? DEFAULT_PER_MODEL_LIMIT
	}

	/**
	 * Can a task with the given model start right now?
	 * Checks both global running count and per-model running count.
	 */
	canStart(model: string): boolean {
		if (this.bgManager.countRunning() >= this.maxConcurrent) return false
		if (this.bgManager.countRunningForModel(model) >= this.perModelLimit) return false
		return true
	}

	/**
	 * Try to promote as many pending tasks to running as the limits allow.
	 * Returns the IDs of tasks that should be started.
	 */
	drainPending(): string[] {
		const pending = this.bgManager.getByStatus('pending')
		const toStart: string[] = []

		for (const task of pending) {
			if (this.bgManager.countRunning() + toStart.length >= this.maxConcurrent) break
			if (this.bgManager.countRunningForModel(task.model) >= this.perModelLimit) continue
			toStart.push(task.id)
		}

		return toStart
	}

	/** Current utilisation snapshot. */
	utilisation(): { running: number; pending: number; maxConcurrent: number; perModelLimit: number } {
		return {
			running: this.bgManager.countRunning(),
			pending: this.bgManager.countPending(),
			maxConcurrent: this.maxConcurrent,
			perModelLimit: this.perModelLimit,
		}
	}
}
