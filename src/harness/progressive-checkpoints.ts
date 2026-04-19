/**
 * Progressive checkpoints — snapshots session state at multiple context-fill
 * thresholds so compaction can restore richer context than a simple summary.
 *
 * Each threshold fires only once per session (bitset tracking). Checkpoints
 * are stored in KV with 24h TTL and enriched into the compactor's
 * summary-frame when compaction occurs.
 */

import type { KvService } from '../services/kv'
import type { Logger } from '../types'
import type { QualityScorer } from './quality-score'

export interface CheckpointsConfig {
	/** Enable progressive checkpoints. Defaults to true. */
	enabled?: boolean
	/** Context fill thresholds (0–100) at which to capture checkpoints. */
	fillThresholds?: number[]
	/** Quality score thresholds below which to capture checkpoints. */
	qualityThresholds?: number[]
}

export interface Checkpoint {
	sessionId: string
	trigger: string
	timestamp: number
	messageCount: number
	totalChars: number
	qualityScore: number
	qualityGrade: string
	activeFiles: string[]
	pendingTodos: string[]
	recentDecisions: string[]
}

const DEFAULT_FILL_THRESHOLDS = [20, 35, 50, 65, 80]
const DEFAULT_QUALITY_THRESHOLDS = [80, 70, 50, 40]

interface SessionCheckpointState {
	firedFill: Set<number>
	firedQuality: Set<number>
	recentDecisions: string[]
	activeFiles: Set<string>
	pendingTodos: string[]
	totalChars: number
	messageCount: number
}

function createSessionState(): SessionCheckpointState {
	return {
		firedFill: new Set(),
		firedQuality: new Set(),
		recentDecisions: [],
		activeFiles: new Set(),
		pendingTodos: [],
		totalChars: 0,
		messageCount: 0,
	}
}

export class ProgressiveCheckpointManager {
	private readonly sessions = new Map<string, SessionCheckpointState>()
	private readonly fillThresholds: number[]
	private readonly qualityThresholds: number[]

	constructor(
		private readonly kvService: KvService,
		private readonly projectId: string,
		private readonly logger: Logger,
		private readonly qualityScorer: QualityScorer | null,
		config?: CheckpointsConfig,
	) {
		this.fillThresholds = config?.fillThresholds ?? DEFAULT_FILL_THRESHOLDS
		this.qualityThresholds = config?.qualityThresholds ?? DEFAULT_QUALITY_THRESHOLDS
	}

	private state(sessionId: string): SessionCheckpointState {
		let s = this.sessions.get(sessionId)
		if (!s) {
			s = createSessionState()
			this.sessions.set(sessionId, s)
		}
		return s
	}

	// --- Signal feeders ---

	recordMessage(sessionId: string, chars: number): void {
		const s = this.state(sessionId)
		s.messageCount++
		s.totalChars += chars
	}

	recordFileActivity(sessionId: string, filePath: string): void {
		const s = this.state(sessionId)
		s.activeFiles.add(filePath)
		// Keep only last 50 active files
		if (s.activeFiles.size > 50) {
			const first = s.activeFiles.values().next().value
			if (first) s.activeFiles.delete(first)
		}
	}

	recordDecision(sessionId: string, decision: string): void {
		const s = this.state(sessionId)
		s.recentDecisions.push(decision)
		if (s.recentDecisions.length > 20) s.recentDecisions.shift()
	}

	updateTodos(sessionId: string, todos: string[]): void {
		this.state(sessionId).pendingTodos = todos
	}

	// --- Threshold checking ---

	/** Check if any threshold was crossed and capture checkpoints. Returns captured trigger names. */
	checkAndCapture(sessionId: string): string[] {
		const s = this.state(sessionId)
		const captured: string[] = []

		// Check fill thresholds
		const estimatedTokens = Math.ceil(s.totalChars / 4)
		const fillPercent = Math.round((estimatedTokens / 200_000) * 100)

		for (const threshold of this.fillThresholds) {
			if (fillPercent >= threshold && !s.firedFill.has(threshold)) {
				s.firedFill.add(threshold)
				const trigger = `fill-${threshold}`
				this.captureCheckpoint(sessionId, trigger, s)
				captured.push(trigger)
			}
		}

		// Check quality thresholds
		if (this.qualityScorer) {
			const result = this.qualityScorer.compute(sessionId)
			for (const threshold of this.qualityThresholds) {
				if (result.score < threshold && !s.firedQuality.has(threshold)) {
					s.firedQuality.add(threshold)
					const trigger = `quality-below-${threshold}`
					this.captureCheckpoint(sessionId, trigger, s, result.score, result.grade)
					captured.push(trigger)
				}
			}
		}

		return captured
	}

	private captureCheckpoint(
		sessionId: string,
		trigger: string,
		s: SessionCheckpointState,
		qualityScore?: number,
		qualityGrade?: string,
	): void {
		const qResult = this.qualityScorer?.compute(sessionId)
		const checkpoint: Checkpoint = {
			sessionId,
			trigger,
			timestamp: Date.now(),
			messageCount: s.messageCount,
			totalChars: s.totalChars,
			qualityScore: qualityScore ?? qResult?.score ?? 100,
			qualityGrade: qualityGrade ?? qResult?.grade ?? 'S',
			activeFiles: Array.from(s.activeFiles),
			pendingTodos: [...s.pendingTodos],
			recentDecisions: [...s.recentDecisions],
		}

		this.kvService.set(this.projectId, `checkpoint:${sessionId}:${trigger}`, checkpoint)
		this.logger.log(
			`[checkpoints] captured ${trigger} for session ${sessionId} (msgs=${s.messageCount}, quality=${checkpoint.qualityScore})`,
		)
	}

	/** Select the richest checkpoint for a session (most messages + highest quality). */
	selectBestCheckpoint(sessionId: string): Checkpoint | null {
		const entries = this.kvService.listByPrefix(this.projectId, `checkpoint:${sessionId}:`)
		if (entries.length === 0) return null

		let best: Checkpoint | null = null
		let bestScore = -1

		for (const entry of entries) {
			const cp = entry.data as Checkpoint | null
			if (!cp) continue
			// Score by: messageCount weight + quality weight
			const score = cp.messageCount * 0.6 + cp.qualityScore * 0.4
			if (score > bestScore) {
				bestScore = score
				best = cp
			}
		}

		return best
	}

	/** Build a restore context block from the best checkpoint for compaction enrichment. */
	buildRestoreContext(sessionId: string): string | null {
		const cp = this.selectBestCheckpoint(sessionId)
		if (!cp) return null

		const lines: string[] = []
		lines.push(`## Checkpoint Restore (captured at ${cp.trigger}, quality ${cp.qualityScore}/${cp.qualityGrade})`)

		if (cp.activeFiles.length > 0) {
			lines.push('')
			lines.push('### Active Files')
			for (const f of cp.activeFiles.slice(-15)) {
				lines.push(`- ${f}`)
			}
		}

		if (cp.pendingTodos.length > 0) {
			lines.push('')
			lines.push('### Pending Tasks')
			for (const t of cp.pendingTodos) {
				lines.push(`- ${t}`)
			}
		}

		if (cp.recentDecisions.length > 0) {
			lines.push('')
			lines.push('### Key Decisions')
			for (const d of cp.recentDecisions.slice(-10)) {
				lines.push(`- ${d}`)
			}
		}

		return lines.join('\n')
	}

	/** Reset session state. */
	reset(sessionId: string): void {
		this.sessions.delete(sessionId)
	}
}
