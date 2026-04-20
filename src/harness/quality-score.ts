/**
 * Context quality scorer — computes a composite quality signal for the current
 * session based on 7 weighted metrics. Produces a 0–100 score with letter
 * grades (S/A/B/C/D/F) and per-signal breakdowns.
 *
 * Follows the `DoomLoopDetector` per-session state pattern from
 * `src/harness/doom-loop.ts`.
 */

import type { Logger } from '../types'

export interface QualityScoreConfig {
	/** Enable quality scoring. Defaults to true. */
	enabled?: boolean
	/** Score threshold below which to emit nudge. Defaults to 60. */
	nudgeThreshold?: number
	/** Cooldown between nudges in milliseconds. Defaults to 5 minutes. */
	nudgeCooldownMs?: number
	/** Max nudges per session. Defaults to 3. */
	maxNudgesPerSession?: number
}

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D' | 'F'

export interface QualitySignals {
	contextFill: number
	staleReads: number
	bloatedResults: number
	compactionDepth: number
	duplicates: number
	decisionDensity: number
	loopDetections: number
}

export interface QualityResult {
	score: number
	grade: Grade
	signals: QualitySignals
}

interface FileReadRecord {
	firstReadAt: number
	lastReadAt: number
	mtime: number
}

interface SessionQualityState {
	toolCallCount: number
	fileReads: Map<string, FileReadRecord>
	largeResultCount: number
	referencedResults: Set<string>
	compactionCount: number
	duplicateSystemMsgs: number
	totalChars: number
	messageCount: number
	decisionMessageCount: number
	loopDetections: number
	lastScore: number | null
	lastNudgeAt: number
	nudgeCount: number
	suppressNextNudge: boolean
}

function createState(): SessionQualityState {
	return {
		toolCallCount: 0,
		fileReads: new Map(),
		largeResultCount: 0,
		referencedResults: new Set(),
		compactionCount: 0,
		duplicateSystemMsgs: 0,
		totalChars: 0,
		messageCount: 0,
		decisionMessageCount: 0,
		loopDetections: 0,
		lastScore: null,
		lastNudgeAt: 0,
		nudgeCount: 0,
		suppressNextNudge: false,
	}
}

function toGrade(score: number): Grade {
	if (score >= 90) return 'S'
	if (score >= 80) return 'A'
	if (score >= 70) return 'B'
	if (score >= 60) return 'C'
	if (score >= 50) return 'D'
	return 'F'
}

/** Rough tokens estimate: ~4 chars per token. */
function estimateTokens(chars: number): number {
	return Math.ceil(chars / 4)
}

// Long-session tuning: modern models (gpt-5, claude-opus-4, gemini-2.5) have
// 200K-1M+ context windows.  Setting 500K here means contextFill signals
// won't trigger prematurely on large sessions that are well within budget.
const DEFAULT_MAX_TOKENS = 500_000

export class QualityScorer {
	private readonly sessions = new Map<string, SessionQualityState>()

	constructor(_logger: Logger) {
		// Logger reserved for future diagnostic output.
	}

	private state(sessionId: string): SessionQualityState {
		let s = this.sessions.get(sessionId)
		if (!s) {
			s = createState()
			this.sessions.set(sessionId, s)
		}
		return s
	}

	// --- Signal feeders ---

	recordToolCall(sessionId: string): void {
		this.state(sessionId).toolCallCount++
	}

	recordFileRead(sessionId: string, filePath: string, mtime: number): void {
		const s = this.state(sessionId)
		const existing = s.fileReads.get(filePath)
		if (existing) {
			existing.lastReadAt = Date.now()
			if (mtime !== existing.mtime) {
				// File was modified externally — stale read potential
				existing.mtime = mtime
			}
		} else {
			s.fileReads.set(filePath, { firstReadAt: Date.now(), lastReadAt: Date.now(), mtime })
		}
	}

	recordLargeResult(sessionId: string, _toolCallId: string): void {
		const s = this.state(sessionId)
		s.largeResultCount++
	}

	recordResultReference(sessionId: string, toolCallId: string): void {
		this.state(sessionId).referencedResults.add(toolCallId)
	}

	recordCompaction(sessionId: string): void {
		const s = this.state(sessionId)
		s.compactionCount++
		s.suppressNextNudge = true // Don't warn right after compaction
	}

	recordLoopDetection(sessionId: string): void {
		this.state(sessionId).loopDetections++
	}

	recordMessage(sessionId: string, content: string, isDecision: boolean): void {
		const s = this.state(sessionId)
		s.messageCount++
		s.totalChars += content.length
		if (isDecision) s.decisionMessageCount++
	}

	recordDuplicateSystem(sessionId: string): void {
		this.state(sessionId).duplicateSystemMsgs++
	}

	// --- Score computation ---

	compute(sessionId: string): QualityResult {
		const s = this.state(sessionId)

		// Signal 1: Context fill (0–1, lower is better)
		const tokenEstimate = estimateTokens(s.totalChars)
		const contextFill = Math.min(1, tokenEstimate / DEFAULT_MAX_TOKENS)
		const contextFillScore = 1 - contextFill

		// Signal 2: Stale reads (files read multiple times with same mtime)
		const staleCount = Array.from(s.fileReads.values()).filter(
			r => r.lastReadAt - r.firstReadAt > 30_000, // Re-read after 30s
		).length
		const staleRatio = s.fileReads.size > 0 ? staleCount / s.fileReads.size : 0
		const staleScore = 1 - Math.min(1, staleRatio)

		// Signal 3: Bloated results (large results that were never referenced)
		const unusedRatio =
			s.largeResultCount > 0 ? Math.max(0, s.largeResultCount - s.referencedResults.size) / s.largeResultCount : 0
		const bloatedScore = 1 - Math.min(1, unusedRatio)

		// Signal 4: Compaction depth (exponential penalty)
		const compactionScore = 1 - Math.min(1, 1 - Math.pow(0.4, Math.max(1, s.compactionCount)))

		// Signal 5: Duplicate system injections
		const dupScore = 1 - Math.min(1, s.duplicateSystemMsgs / 10)

		// Signal 6: Decision density (higher is better)
		const decisionDensity = s.messageCount > 0 ? s.decisionMessageCount / s.messageCount : 1
		const decisionScore = Math.min(1, decisionDensity * 5) // Scale: 20%+ decisions = perfect

		// Signal 7: Loop detections
		const loopScore = 1 - Math.min(1, s.loopDetections / 3)

		// Weighted composite
		const signals: QualitySignals = {
			contextFill: Math.round(contextFillScore * 100),
			staleReads: Math.round(staleScore * 100),
			bloatedResults: Math.round(bloatedScore * 100),
			compactionDepth: Math.round(compactionScore * 100),
			duplicates: Math.round(dupScore * 100),
			decisionDensity: Math.round(decisionScore * 100),
			loopDetections: Math.round(loopScore * 100),
		}

		const score = Math.round(
			contextFillScore * 20 +
				staleScore * 20 +
				bloatedScore * 20 +
				compactionScore * 15 +
				dupScore * 10 +
				decisionScore * 8 +
				loopScore * 7,
		)

		const result: QualityResult = {
			score,
			grade: toGrade(score),
			signals,
		}

		s.lastScore = score
		return result
	}

	// --- Nudge logic ---

	shouldNudge(sessionId: string, config?: QualityScoreConfig): { nudge: boolean; result: QualityResult } {
		const result = this.compute(sessionId)
		const s = this.state(sessionId)

		const threshold = config?.nudgeThreshold ?? 60
		const cooldown = config?.nudgeCooldownMs ?? 5 * 60 * 1000
		// Long-session tuning: allow up to 10 nudges (was 3) so multi-hour
		// sessions keep getting quality feedback throughout their lifecycle.
		const maxNudges = config?.maxNudgesPerSession ?? 10

		if (s.suppressNextNudge) {
			s.suppressNextNudge = false
			return { nudge: false, result }
		}

		if (s.nudgeCount >= maxNudges) return { nudge: false, result }
		if (Date.now() - s.lastNudgeAt < cooldown) return { nudge: false, result }

		let shouldNudge = false

		// Trigger: score dropped below threshold
		if (result.score < threshold) shouldNudge = true

		// Trigger: score dropped ≥15 since last check
		if (s.lastScore !== null && s.lastScore - result.score >= 15) shouldNudge = true

		if (shouldNudge) {
			s.nudgeCount++
			s.lastNudgeAt = Date.now()
		}

		return { nudge: shouldNudge, result }
	}

	/** Reset state for a session. */
	reset(sessionId: string): void {
		this.sessions.delete(sessionId)
	}

	/** Get raw state for debugging. */
	getState(sessionId: string): SessionQualityState | undefined {
		return this.sessions.get(sessionId)
	}
}

export function formatQualityReport(result: QualityResult): string {
	const lines = [
		`Context Quality: ${result.score}/100 (${result.grade})`,
		'',
		'Signal breakdown:',
		`  Context fill:      ${result.signals.contextFill}/100 (weight: 20%)`,
		`  Stale reads:       ${result.signals.staleReads}/100 (weight: 20%)`,
		`  Bloated results:   ${result.signals.bloatedResults}/100 (weight: 20%)`,
		`  Compaction depth:  ${result.signals.compactionDepth}/100 (weight: 15%)`,
		`  Duplicates:        ${result.signals.duplicates}/100 (weight: 10%)`,
		`  Decision density:  ${result.signals.decisionDensity}/100 (weight: 8%)`,
		`  Loop detections:   ${result.signals.loopDetections}/100 (weight: 7%)`,
	]

	if (result.score < 60) {
		lines.push('')
		lines.push('⚠️  Quality is degraded. Consider using /compact or starting a new session.')
	}

	return lines.join('\n')
}
