import { test, expect, beforeEach, afterEach } from 'bun:test'
import { initializeGraphDatabase, closeGraphDatabase } from '../src/graph/database'
import { RepoMap } from '../src/graph/repo-map'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

/**
 * Tests for Etap 9h — Execution flows + knowledge gaps.
 *
 * All tests seed the `files`/`symbols`/`calls` tables directly so we
 * never depend on tree-sitter (unreliable in sandbox). Entry-point
 * heuristics + BFS are exercised end-to-end against SQLite.
 */

let testDir: string
let db: Database
let repoMap: RepoMap

function seedFile(d: Database, path: string, pagerank: number = 0.5, symbolCount: number = 1): number {
	const res = d
		.prepare(
			'INSERT INTO files (path, mtime_ms, language, line_count, is_barrel, indexed_at, pagerank, symbol_count) VALUES (?, 0, ?, 1, 0, 0, ?, ?)',
		)
		.run(path, 'typescript', pagerank, symbolCount)
	return Number(res.lastInsertRowid)
}

function seedSymbol(
	d: Database,
	fileId: number,
	name: string,
	line: number,
	opts: { isExported?: boolean; kind?: string } = {},
): number {
	const res = d
		.prepare('INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported) VALUES (?, ?, ?, ?, ?, ?)')
		.run(fileId, name, opts.kind ?? 'function', line, line, opts.isExported ? 1 : 0)
	return Number(res.lastInsertRowid)
}

function link(
	d: Database,
	callerSym: number,
	calleeName: string,
	calleeSym: number,
	calleeFile: number,
	callLine: number,
	confidence = 1.0,
	tier: 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' = 'EXTRACTED',
) {
	d.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(callerSym, calleeName, calleeSym, calleeFile, callLine, confidence, tier)
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), 'graph-flows-'))
	execSync('git init', { cwd: testDir })
	execSync('git config user.email "t@t"', { cwd: testDir })
	execSync('git config user.name "t"', { cwd: testDir })
	db = initializeGraphDatabase('test-flows', testDir)
	repoMap = new RepoMap({ cwd: testDir, db })
})

afterEach(() => {
	closeGraphDatabase()
	rmSync(testDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------
// Execution flows
// ---------------------------------------------------------------------

test('getExecutionFlows picks `main` as an entry and follows callees', () => {
	const entry = seedFile(db, 'entry.ts', 0.9)
	const util = seedFile(db, 'util.ts', 0.5)
	const mainSym = seedSymbol(db, entry, 'main', 1)
	const helperSym = seedSymbol(db, util, 'helper', 1)
	link(db, mainSym, 'helper', helperSym, util, 5)

	const flows = repoMap.getExecutionFlows()
	expect(flows.length).toBeGreaterThanOrEqual(1)
	const mainFlow = flows.find(f => f.entryName === 'main')!
	expect(mainFlow.entryKind).toBe('main')
	expect(mainFlow.steps.map(s => s.name)).toEqual(['main', 'helper'])
	expect(mainFlow.steps[0].depth).toBe(0)
	expect(mainFlow.steps[1].depth).toBe(1)
	expect(mainFlow.truncated).toBe(false)
})

test('getExecutionFlows detects handler-named symbols as entries', () => {
	const file = seedFile(db, 'server.ts', 0.8)
	seedSymbol(db, file, 'handleRequest', 10)
	seedSymbol(db, file, 'getUsers', 20)
	seedSymbol(db, file, 'postLogin', 30)
	// A non-handler, non-exported helper must NOT be an entry.
	seedSymbol(db, file, 'private_helper', 40, { isExported: false })

	const flows = repoMap.getExecutionFlows()
	const entries = flows.map(f => f.entryName).sort()
	expect(entries).toContain('handleRequest')
	expect(entries).toContain('getUsers')
	expect(entries).toContain('postLogin')
	expect(entries).not.toContain('private_helper')
	for (const f of flows) {
		if (['handleRequest', 'getUsers', 'postLogin'].includes(f.entryName)) {
			expect(f.entryKind).toBe('handler')
		}
	}
})

test('getExecutionFlows sorts by pagerank descending', () => {
	const hot = seedFile(db, 'hot.ts', 0.9)
	const cold = seedFile(db, 'cold.ts', 0.1)
	seedSymbol(db, hot, 'main', 1)
	seedSymbol(db, cold, 'run', 1)

	const flows = repoMap.getExecutionFlows()
	expect(flows[0].entryName).toBe('main')
	expect(flows[0].weight).toBeCloseTo(0.9)
	expect(flows.find(f => f.entryName === 'run')!.weight).toBeCloseTo(0.1)
})

test('getExecutionFlows respects maxDepth and reports truncated=true', () => {
	const a = seedFile(db, 'a.ts', 0.9)
	const b = seedFile(db, 'b.ts', 0.5)
	const c = seedFile(db, 'c.ts', 0.4)
	const d = seedFile(db, 'd.ts', 0.3)
	const s1 = seedSymbol(db, a, 'main', 1)
	const s2 = seedSymbol(db, b, 'step2', 1)
	const s3 = seedSymbol(db, c, 'step3', 1)
	const s4 = seedSymbol(db, d, 'step4', 1)
	link(db, s1, 'step2', s2, b, 5)
	link(db, s2, 'step3', s3, c, 5)
	link(db, s3, 'step4', s4, d, 5)

	const flows = repoMap.getExecutionFlows({ maxDepth: 2 })
	const main = flows.find(f => f.entryName === 'main')!
	// depth 0 (main) + depth 1 (step2) + depth 2 (step3) — step4 cut off.
	expect(main.steps.map(s => s.name)).toEqual(['main', 'step2', 'step3'])
	expect(main.truncated).toBe(true)
})

test('getExecutionFlows skips low-confidence edges (<0.7)', () => {
	const a = seedFile(db, 'a.ts', 0.9)
	const b = seedFile(db, 'b.ts', 0.5)
	const sA = seedSymbol(db, a, 'main', 1)
	const sB = seedSymbol(db, b, 'mystery', 1)
	link(db, sA, 'mystery', sB, b, 5, 0.4, 'AMBIGUOUS')

	const flows = repoMap.getExecutionFlows()
	const main = flows.find(f => f.entryName === 'main')!
	expect(main.steps.map(s => s.name)).toEqual(['main']) // ambiguous edge ignored
})

test('getExecutionFlows returns [] when the graph has no entries', () => {
	// Only a private, non-exported, non-handler, non-test symbol.
	const f = seedFile(db, 'internal.ts', 0.5)
	seedSymbol(db, f, 'doThing', 1, { isExported: false })
	expect(repoMap.getExecutionFlows()).toEqual([])
})

// ---------------------------------------------------------------------
// Knowledge gaps
// ---------------------------------------------------------------------

test('getKnowledgeGaps surfaces high-pagerank untested symbols', () => {
	// 10 files spread across pagerank space; f9 is top p90.
	const files: number[] = []
	for (let i = 0; i < 10; i++) {
		files.push(seedFile(db, `f${i}.ts`, i / 10))
	}
	// Only f9 (rank 0.9) is at/above p90.
	const hotSym = seedSymbol(db, files[9], 'criticalFn', 1)
	// A production caller for the hot symbol.
	const prodFile = seedFile(db, 'prod.ts', 0.3, 1)
	const prodSym = seedSymbol(db, prodFile, 'prodCaller', 1)
	link(db, prodSym, 'criticalFn', hotSym, files[9], 5)

	const gaps = repoMap.getKnowledgeGaps({ percentile: 0.9 })
	expect(gaps.length).toBe(1)
	expect(gaps[0].name).toBe('criticalFn')
	expect(gaps[0].nonTestCallers).toBe(1)
})

test('getKnowledgeGaps excludes symbols called from test files', () => {
	const files: number[] = []
	for (let i = 0; i < 10; i++) {
		files.push(seedFile(db, `f${i}.ts`, i / 10))
	}
	const hot = seedSymbol(db, files[9], 'coveredFn', 1)
	// Test file caller.
	const testFile = seedFile(db, 'suite.test.ts', 0.2)
	const testSym = seedSymbol(db, testFile, 'it_covers', 1)
	link(db, testSym, 'coveredFn', hot, files[9], 5)

	const gaps = repoMap.getKnowledgeGaps({ percentile: 0.9 })
	expect(gaps).toEqual([])
})

test('getKnowledgeGaps handles empty graph gracefully', () => {
	expect(repoMap.getKnowledgeGaps()).toEqual([])
})

test('getKnowledgeGaps honours the limit option', () => {
	// Seed many hot untested symbols.
	const files: number[] = []
	for (let i = 0; i < 5; i++) {
		files.push(seedFile(db, `hot${i}.ts`, 0.95))
	}
	for (let i = 0; i < 5; i++) {
		seedSymbol(db, files[i], `fn${i}`, 1)
	}
	const gaps = repoMap.getKnowledgeGaps({ percentile: 0.5, limit: 2 })
	expect(gaps.length).toBe(2)
})
