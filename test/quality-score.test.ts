/**
 * Tests for context quality scorer.
 */

import { describe, expect, test } from 'bun:test'
import { QualityScorer, formatQualityReport } from '../src/harness/quality-score'

const noop = (..._args: unknown[]) => {}
const logger = { log: noop, debug: noop, error: noop } as any

describe('QualityScorer', () => {
	test('fresh session scores high', () => {
		const scorer = new QualityScorer(logger)
		const result = scorer.compute('sess1')
		expect(result.score).toBeGreaterThanOrEqual(80)
		expect(result.grade).toBe('S')
	})

	test('score degrades with compaction', () => {
		const scorer = new QualityScorer(logger)
		scorer.recordCompaction('sess1')
		scorer.recordCompaction('sess1')
		scorer.recordCompaction('sess1')
		const result = scorer.compute('sess1')
		expect(result.score).toBeLessThan(100)
		expect(result.signals.compactionDepth).toBeLessThan(100)
	})

	test('score degrades with loop detections', () => {
		const scorer = new QualityScorer(logger)
		scorer.recordLoopDetection('sess1')
		scorer.recordLoopDetection('sess1')
		scorer.recordLoopDetection('sess1')
		const result = scorer.compute('sess1')
		expect(result.signals.loopDetections).toBe(0) // 3/3 = fully penalized
	})

	test('large unused results penalize bloat signal', () => {
		const scorer = new QualityScorer(logger)
		scorer.recordLargeResult('sess1', 'c1')
		scorer.recordLargeResult('sess1', 'c2')
		scorer.recordLargeResult('sess1', 'c3')
		// None referenced
		const result = scorer.compute('sess1')
		expect(result.signals.bloatedResults).toBeLessThan(100)
	})

	test('referencing results improves bloat signal', () => {
		const scorer = new QualityScorer(logger)
		scorer.recordLargeResult('sess1', 'c1')
		scorer.recordLargeResult('sess1', 'c2')
		scorer.recordResultReference('sess1', 'c1')
		scorer.recordResultReference('sess1', 'c2')
		const result = scorer.compute('sess1')
		expect(result.signals.bloatedResults).toBe(100) // All referenced
	})

	test('grade boundaries', () => {
		const scorer = new QualityScorer(logger)
		// Fresh session with decisions
		scorer.recordMessage('s', 'go', true)
		const r = scorer.compute('s')
		expect(['S', 'A']).toContain(r.grade)
	})

	test('formatQualityReport produces readable output', () => {
		const scorer = new QualityScorer(logger)
		const result = scorer.compute('sess1')
		const report = formatQualityReport(result)
		expect(report).toContain('Context Quality:')
		expect(report).toContain('Signal breakdown:')
	})

	test('shouldNudge respects cooldown', () => {
		const scorer = new QualityScorer(logger)
		// Force poor quality
		scorer.recordLoopDetection('s')
		scorer.recordLoopDetection('s')
		scorer.recordLoopDetection('s')
		scorer.recordCompaction('s')
		scorer.recordCompaction('s')
		scorer.recordCompaction('s')
		scorer.recordLargeResult('s', 'a')
		scorer.recordLargeResult('s', 'b')
		scorer.recordLargeResult('s', 'c')

		const { nudge: first } = scorer.shouldNudge('s', { nudgeThreshold: 100, nudgeCooldownMs: 60000 })
		// First check after compaction is suppressed
		expect(first).toBe(false)

		const { nudge: second } = scorer.shouldNudge('s', { nudgeThreshold: 100, nudgeCooldownMs: 60000 })
		// Now it should nudge since suppress is cleared
		expect(second).toBe(true)

		const { nudge: third } = scorer.shouldNudge('s', { nudgeThreshold: 100, nudgeCooldownMs: 60000 })
		// Cooldown prevents immediate re-nudge
		expect(third).toBe(false)
	})

	test('reset clears session state', () => {
		const scorer = new QualityScorer(logger)
		scorer.recordCompaction('s')
		scorer.recordCompaction('s')
		scorer.reset('s')
		const result = scorer.compute('s')
		expect(result.score).toBeGreaterThanOrEqual(80)
	})

	test('sessions are independent', () => {
		const scorer = new QualityScorer(logger)
		scorer.recordLoopDetection('s1')
		scorer.recordLoopDetection('s1')
		scorer.recordLoopDetection('s1')
		const r1 = scorer.compute('s1')
		const r2 = scorer.compute('s2')
		expect(r2.score).toBeGreaterThan(r1.score)
	})
})
