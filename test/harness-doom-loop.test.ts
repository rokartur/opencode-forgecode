import { describe, test, expect } from 'bun:test'
import { DoomLoopDetector, signatureOf } from '../src/harness/doom-loop'

describe('signatureOf', () => {
	test('stable hash for identical args', () => {
		const a = signatureOf('read', { path: '/a' })
		const b = signatureOf('read', { path: '/a' })
		expect(a.name).toBe('read')
		expect(a.argsHash).toBe(b.argsHash)
	})

	test('different args produce different hashes', () => {
		const a = signatureOf('read', { path: '/a' })
		const b = signatureOf('read', { path: '/b' })
		expect(a.argsHash).not.toBe(b.argsHash)
	})

	test('null/undefined args tolerated', () => {
		const a = signatureOf('x', null)
		const b = signatureOf('x', undefined)
		expect(a.argsHash).toBe(b.argsHash)
	})
})

describe('DoomLoopDetector', () => {
	test('returns null below threshold', () => {
		const d = new DoomLoopDetector(3)
		d.record('s1', signatureOf('read', { p: '/a' }))
		d.record('s1', signatureOf('read', { p: '/a' }))
		expect(d.detect('s1')).toBeNull()
	})

	test('detects length-1 pattern at threshold', () => {
		const d = new DoomLoopDetector(3)
		const sig = signatureOf('read', { p: '/a' })
		d.record('s1', sig)
		d.record('s1', sig)
		d.record('s1', sig)
		const reps = d.detect('s1')
		expect(reps).not.toBeNull()
		expect(reps).toBeGreaterThanOrEqual(3)
	})

	test('detects length-3 pattern', () => {
		const d = new DoomLoopDetector(3)
		const a = signatureOf('A', {})
		const b = signatureOf('B', {})
		const c = signatureOf('C', {})
		// ABC repeated 3 times
		for (let i = 0; i < 3; i++) {
			d.record('s1', a)
			d.record('s1', b)
			d.record('s1', c)
		}
		const reps = d.detect('s1')
		expect(reps).not.toBeNull()
		expect(reps).toBeGreaterThanOrEqual(3)
	})

	test('non-repeating sequence not detected', () => {
		const d = new DoomLoopDetector(3)
		d.record('s1', signatureOf('A', {}))
		d.record('s1', signatureOf('B', {}))
		d.record('s1', signatureOf('C', {}))
		d.record('s1', signatureOf('D', {}))
		expect(d.detect('s1')).toBeNull()
	})

	test('sessions are isolated', () => {
		const d = new DoomLoopDetector(3)
		const sig = signatureOf('read', { p: '/a' })
		d.record('s1', sig)
		d.record('s1', sig)
		d.record('s1', sig)
		expect(d.detect('s1')).not.toBeNull()
		expect(d.detect('s2')).toBeNull()
	})

	test('reset clears session state', () => {
		const d = new DoomLoopDetector(3)
		const sig = signatureOf('read', { p: '/a' })
		d.record('s1', sig)
		d.record('s1', sig)
		d.record('s1', sig)
		expect(d.detect('s1')).not.toBeNull()
		d.reset('s1')
		expect(d.detect('s1')).toBeNull()
	})

	test('warning flag is per-session', () => {
		const d = new DoomLoopDetector(3)
		expect(d.hasWarned('s1')).toBe(false)
		d.markWarned('s1')
		expect(d.hasWarned('s1')).toBe(true)
		expect(d.hasWarned('s2')).toBe(false)
		d.reset('s1')
		expect(d.hasWarned('s1')).toBe(false)
	})

	test('reminder renders a non-empty string', async () => {
		const d = new DoomLoopDetector(3)
		const msg = await d.reminder(5)
		expect(typeof msg).toBe('string')
		expect(msg.length).toBeGreaterThan(0)
	})

	test('ring buffer caps at 64 entries', () => {
		const d = new DoomLoopDetector(3)
		for (let i = 0; i < 100; i++) {
			d.record('s1', signatureOf('x', { i }))
		}
		// Tail is all distinct args -> no repeating pattern
		expect(d.detect('s1')).toBeNull()
	})
})
