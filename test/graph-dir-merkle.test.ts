import { test, expect } from 'bun:test'
import {
	computeDirRollup,
	diffDirRollups,
	makeSkippablePredicate,
	serialiseRollup,
	deserialiseRollup,
	type FileHashRow,
} from '../src/graph/dir-merkle'

/**
 * Tests for Etap 9g — Dir-level Merkle rollup.
 *
 * All tests operate on synthetic `{ path, hash }` inputs; this module
 * is pure and must not touch the filesystem.
 */

test('computeDirRollup is deterministic on identical input', () => {
	const files: FileHashRow[] = [
		{ path: 'src/a.ts', hash: 'aa' },
		{ path: 'src/b.ts', hash: 'bb' },
		{ path: 'src/sub/c.ts', hash: 'cc' },
	]
	const r1 = computeDirRollup(files)
	const r2 = computeDirRollup(files)
	expect([...r1.hashes.entries()].sort()).toEqual([...r2.hashes.entries()].sort())
})

test('computeDirRollup input order does not affect hashes', () => {
	const forward: FileHashRow[] = [
		{ path: 'src/a.ts', hash: 'aa' },
		{ path: 'src/b.ts', hash: 'bb' },
		{ path: 'src/sub/c.ts', hash: 'cc' },
	]
	const reversed = [...forward].reverse()
	const r1 = computeDirRollup(forward)
	const r2 = computeDirRollup(reversed)
	for (const k of r1.hashes.keys()) {
		expect(r2.hashes.get(k)).toBe(r1.hashes.get(k)!)
	}
})

test('computeDirRollup populates all ancestor directories', () => {
	const files: FileHashRow[] = [{ path: 'a/b/c/d.ts', hash: 'x' }]
	const r = computeDirRollup(files)
	const dirs = [...r.hashes.keys()].sort()
	expect(dirs).toEqual(['', 'a', 'a/b', 'a/b/c'])
})

test('diffDirRollups flags a single changed file up its ancestor chain only', () => {
	const before = computeDirRollup([
		{ path: 'src/a.ts', hash: 'aa' },
		{ path: 'src/sub/b.ts', hash: 'bb' },
		{ path: 'lib/c.ts', hash: 'cc' },
	])
	// Only `src/sub/b.ts` changes.
	const after = computeDirRollup([
		{ path: 'src/a.ts', hash: 'aa' },
		{ path: 'src/sub/b.ts', hash: 'bb2' },
		{ path: 'lib/c.ts', hash: 'cc' },
	])
	const diff = diffDirRollups(before, after)
	// Root + src + src/sub should be marked changed; lib must stay unchanged.
	expect(diff.changedDirs.sort()).toEqual(['', 'src', 'src/sub'])
	expect(diff.unchangedDirs).toContain('lib')
	expect(diff.addedDirs).toEqual([])
	expect(diff.removedDirs).toEqual([])
})

test('diffDirRollups detects added and removed directories', () => {
	const before = computeDirRollup([{ path: 'a/x.ts', hash: 'x' }])
	const after = computeDirRollup([
		{ path: 'a/x.ts', hash: 'x' },
		{ path: 'b/y.ts', hash: 'y' },
	])
	const diff = diffDirRollups(before, after)
	expect(diff.addedDirs).toEqual(['b'])
	expect(diff.removedDirs).toEqual([])

	const diffReverse = diffDirRollups(after, before)
	expect(diffReverse.removedDirs).toEqual(['b'])
	expect(diffReverse.addedDirs).toEqual([])
})

test('diffDirRollups is empty when nothing changes', () => {
	const rows: FileHashRow[] = [
		{ path: 'a/x.ts', hash: '1' },
		{ path: 'b/y.ts', hash: '2' },
	]
	const diff = diffDirRollups(computeDirRollup(rows), computeDirRollup(rows))
	expect(diff.changedDirs).toEqual([])
	expect(diff.addedDirs).toEqual([])
	expect(diff.removedDirs).toEqual([])
	// unchangedDirs should cover every dir: '', 'a', 'b'
	expect(diff.unchangedDirs.sort()).toEqual(['', 'a', 'b'])
})

test('makeSkippablePredicate skips files under unchanged ancestors', () => {
	const unchanged = new Set(['lib', 'lib/sub'])
	const skip = makeSkippablePredicate(unchanged)
	expect(skip('lib/a.ts')).toBe(true)
	expect(skip('lib/sub/b.ts')).toBe(true)
	expect(skip('src/a.ts')).toBe(false)
	// Root sentinel should not be treated as "always unchanged" unless explicitly set.
	expect(skip('top.ts')).toBe(false)
})

test('serialiseRollup/deserialiseRollup roundtrip preserves hashes', () => {
	const r = computeDirRollup([
		{ path: 'a/x.ts', hash: '1' },
		{ path: 'b/y.ts', hash: '2' },
	])
	const blob = serialiseRollup(r)
	expect(blob.version).toBe(1)
	const restored = deserialiseRollup(blob)
	for (const [k, v] of r.hashes) {
		expect(restored.hashes.get(k)).toBe(v)
	}
})

test('deserialiseRollup rejects unknown version', () => {
	expect(() => deserialiseRollup({ version: 2 as unknown as 1, hashes: {} })).toThrow(/version/i)
})

test('moving a file between dirs changes both source and destination hashes', () => {
	const before = computeDirRollup([
		{ path: 'src/x.ts', hash: 'xx' },
		{ path: 'lib/y.ts', hash: 'yy' },
	])
	const after = computeDirRollup([
		{ path: 'lib/x.ts', hash: 'xx' },
		{ path: 'lib/y.ts', hash: 'yy' },
	])
	const diff = diffDirRollups(before, after)
	// src: removed, lib: changed
	expect(diff.removedDirs).toEqual(['src'])
	expect(diff.changedDirs).toContain('lib')
	expect(diff.changedDirs).toContain('')
})
