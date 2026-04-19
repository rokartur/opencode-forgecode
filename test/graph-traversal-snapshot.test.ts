import { test, expect, beforeEach, afterEach } from 'bun:test'
import { initializeGraphDatabase, closeGraphDatabase } from '../src/graph/database'
import { RepoMap } from '../src/graph/repo-map'
import { saveSnapshot, loadSnapshot, listSnapshots, diffSnapshotsByLabel } from '../src/graph/snapshot'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

/**
 * Tests for Etap 9c — Traversal + snapshot/diff.
 *
 * We seed the SQLite layer directly (files/symbols/calls) so we can
 * exercise `traverse`, `snapshot`, and `diffSnapshots` without depending
 * on `scan()`/tree-sitter (brittle under sandbox).
 */

let testDir: string
let db: Database
let repoMap: RepoMap

function seed(d: Database, path: string, symbolName: string, line: number): { fileId: number; symbolId: number } {
	const fileRes = d
		.prepare(
			'INSERT INTO files (path, mtime_ms, language, line_count, is_barrel, indexed_at, pagerank, symbol_count) VALUES (?, 0, ?, 1, 0, 0, ?, 1)',
		)
		.run(path, 'typescript', 0.5)
	const fileId = Number(fileRes.lastInsertRowid)
	const symRes = d
		.prepare('INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported) VALUES (?, ?, ?, ?, ?, 1)')
		.run(fileId, symbolName, 'function', line, line)
	const symbolId = Number(symRes.lastInsertRowid)
	return { fileId, symbolId }
}

function link(
	d: Database,
	callerSymId: number,
	calleeName: string,
	calleeSymId: number,
	calleeFileId: number,
	callLine: number,
	confidence: number,
	tier: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS',
) {
	d.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(callerSymId, calleeName, calleeSymId, calleeFileId, callLine, confidence, tier)
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), 'graph-traverse-'))
	execSync('git init', { cwd: testDir })
	execSync('git config user.email "t@t"', { cwd: testDir })
	execSync('git config user.name "t"', { cwd: testDir })
	db = initializeGraphDatabase('test-traverse', testDir)
	repoMap = new RepoMap({ cwd: testDir, db })
})

afterEach(() => {
	closeGraphDatabase()
	rmSync(testDir, { recursive: true, force: true })
})

test('traverse(out) walks callee chain A→B→C honouring maxDepth', () => {
	const a = seed(db, 'a.ts', 'A', 1)
	const b = seed(db, 'b.ts', 'B', 1)
	const c = seed(db, 'c.ts', 'C', 1)
	link(db, a.symbolId, 'B', b.symbolId, b.fileId, 10, 1.0, 'EXTRACTED')
	link(db, b.symbolId, 'C', c.symbolId, c.fileId, 20, 1.0, 'EXTRACTED')

	const full = repoMap.traverse({ path: 'a.ts', line: 1, direction: 'out', maxDepth: 5 })
	expect(full.root.name).toBe('A')
	expect(full.nodes.map(n => n.name).sort()).toEqual(['B', 'C'])
	expect(full.nodes.find(n => n.name === 'B')!.depth).toBe(1)
	expect(full.nodes.find(n => n.name === 'C')!.depth).toBe(2)
	expect(full.truncated).toBe(false)

	const shallow = repoMap.traverse({ path: 'a.ts', line: 1, direction: 'out', maxDepth: 1 })
	expect(shallow.nodes.map(n => n.name)).toEqual(['B'])
})

test('traverse respects minConfidence filter', () => {
	const a = seed(db, 'a.ts', 'A', 1)
	const b = seed(db, 'b.ts', 'B', 1)
	const c = seed(db, 'c.ts', 'C', 1)
	link(db, a.symbolId, 'B', b.symbolId, b.fileId, 10, 1.0, 'EXTRACTED')
	// Low-confidence inferred edge — must be pruned with minConfidence=1.0
	link(db, b.symbolId, 'C', c.symbolId, c.fileId, 20, 0.5, 'INFERRED')

	const extractedOnly = repoMap.traverse({
		path: 'a.ts',
		line: 1,
		direction: 'out',
		maxDepth: 5,
		minConfidence: 1.0,
	})
	expect(extractedOnly.nodes.map(n => n.name)).toEqual(['B'])

	const all = repoMap.traverse({ path: 'a.ts', line: 1, direction: 'out', maxDepth: 5 })
	expect(all.nodes.map(n => n.name).sort()).toEqual(['B', 'C'])
	const cNode = all.nodes.find(n => n.name === 'C')!
	expect(cNode.edgeTier).toBe('INFERRED')
	expect(cNode.edgeConfidence).toBeCloseTo(0.5)
})

test('traverse(in) walks callers', () => {
	const a = seed(db, 'a.ts', 'A', 1)
	const b = seed(db, 'b.ts', 'B', 1)
	link(db, a.symbolId, 'B', b.symbolId, b.fileId, 10, 1.0, 'EXTRACTED')

	const callers = repoMap.traverse({ path: 'b.ts', line: 1, direction: 'in', maxDepth: 2 })
	expect(callers.root.name).toBe('B')
	expect(callers.nodes.map(n => n.name)).toEqual(['A'])
})

test('traverse stops on maxTokens budget', () => {
	const a = seed(db, 'a.ts', 'A', 1)
	const b = seed(db, 'someLongSymbolName.ts', 'someLongSymbolName', 1)
	link(db, a.symbolId, 'someLongSymbolName', b.symbolId, b.fileId, 10, 1.0, 'EXTRACTED')

	const tiny = repoMap.traverse({
		path: 'a.ts',
		line: 1,
		direction: 'out',
		maxDepth: 5,
		maxTokens: 5, // name+path far exceed 5 chars
	})
	expect(tiny.truncated).toBe(true)
	expect(tiny.stopReason).toBe('maxTokens')
	expect(tiny.nodes).toEqual([])
})

test('traverse returns empty result for unknown start', () => {
	const r = repoMap.traverse({ path: 'nope.ts', line: 99, direction: 'out' })
	expect(r.nodes).toEqual([])
	expect(r.truncated).toBe(false)
})

test('snapshot captures files + stats + topSymbols', () => {
	const a = seed(db, 'a.ts', 'A', 1)
	const b = seed(db, 'b.ts', 'B', 1)
	link(db, a.symbolId, 'B', b.symbolId, b.fileId, 10, 1.0, 'EXTRACTED')

	const snap = repoMap.snapshot('before')
	expect(snap.version).toBe(1)
	expect(snap.label).toBe('before')
	expect(snap.stats.files).toBe(2)
	expect(snap.stats.symbols).toBe(2)
	expect(snap.stats.calls).toBe(1)
	expect(Object.keys(snap.files).sort()).toEqual(['a.ts', 'b.ts'])
	expect(snap.files['a.ts'].symbolsHash).toMatch(/^[0-9a-f]+$/)
	expect(snap.topSymbols.length).toBeGreaterThan(0)
})

test('saveSnapshot/loadSnapshot/listSnapshots roundtrip', () => {
	seed(db, 'a.ts', 'A', 1)
	const snap = repoMap.snapshot('v1')
	const file = saveSnapshot(testDir, snap)
	expect(file.endsWith('v1.json')).toBe(true)

	const loaded = loadSnapshot(testDir, 'v1')
	expect(loaded.label).toBe('v1')
	expect(loaded.stats.files).toBe(1)

	const labels = listSnapshots(testDir)
	expect(labels).toContain('v1')
})

test('diffSnapshotsByLabel detects added/removed/changed files', () => {
	const a1 = seed(db, 'a.ts', 'A', 1)
	seed(db, 'b.ts', 'B', 1)
	saveSnapshot(testDir, repoMap.snapshot('v1'))

	// Mutate: drop b.ts, add c.ts, change a.ts symbol layout
	db.prepare("DELETE FROM symbols WHERE file_id = (SELECT id FROM files WHERE path = 'b.ts')").run()
	db.prepare("DELETE FROM files WHERE path = 'b.ts'").run()
	seed(db, 'c.ts', 'C', 1)
	db.prepare('INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported) VALUES (?, ?, ?, ?, ?, 1)').run(
		a1.fileId,
		'A2',
		'function',
		5,
		5,
	)
	saveSnapshot(testDir, repoMap.snapshot('v2'))

	const diff = diffSnapshotsByLabel(testDir, 'v1', 'v2')
	expect(diff.labelA).toBe('v1')
	expect(diff.labelB).toBe('v2')
	expect(diff.files.added).toEqual(['c.ts'])
	expect(diff.files.removed).toEqual(['b.ts'])
	expect(diff.files.changed).toEqual(['a.ts'])
	expect(diff.stats.filesDelta).toBe(0) // -1 (b.ts) + 1 (c.ts)
	// Start: A, B = 2 symbols. End: A, A2, C = 3 symbols. Delta +1.
	expect(diff.stats.symbolsDelta).toBe(1)
})

test('RepoMap.diffSnapshots is a pure function over two snapshots', () => {
	seed(db, 'a.ts', 'A', 1)
	const s1 = repoMap.snapshot('s1')
	seed(db, 'b.ts', 'B', 1)
	const s2 = repoMap.snapshot('s2')

	const diff = RepoMap.diffSnapshots(s1, s2)
	expect(diff.files.added).toEqual(['b.ts'])
	expect(diff.files.removed).toEqual([])
	expect(diff.stats.filesDelta).toBe(1)
	expect(diff.stats.symbolsDelta).toBe(1)
})
