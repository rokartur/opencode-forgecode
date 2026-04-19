import { test, expect, beforeEach, afterEach } from 'bun:test'
import { initializeGraphDatabase, closeGraphDatabase } from '../src/graph/database'
import { RepoMap } from '../src/graph/repo-map'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

/**
 * Tests for Etap 9b — Edge confidence tiers.
 *
 * We avoid depending on a full `scan()` (tree-sitter wasm loading is
 * brittle in sandboxed environments) and exercise the SQL layer directly:
 *   - migration adds `confidence` / `tier` columns idempotently
 *   - `getCallers` / `getCallees` return the new fields
 *   - `minConfidence` filter prunes rows below the threshold
 *   - legacy rows inserted without the new columns default to EXTRACTED/1.0
 */

let testDir: string
let db: Database
let repoMap: RepoMap

function seedFileAndSymbol(
	d: Database,
	path: string,
	symbolName: string,
	line: number,
	kind: string = 'function',
): { fileId: number; symbolId: number } {
	const fileRes = d
		.prepare(
			'INSERT INTO files (path, mtime_ms, language, line_count, is_barrel, indexed_at) VALUES (?, 0, ?, 1, 0, 0)',
		)
		.run(path, 'typescript')
	const fileId = Number(fileRes.lastInsertRowid)
	const symRes = d
		.prepare('INSERT INTO symbols (file_id, name, kind, line, end_line, is_exported) VALUES (?, ?, ?, ?, ?, 1)')
		.run(fileId, symbolName, kind, line, line)
	const symbolId = Number(symRes.lastInsertRowid)
	return { fileId, symbolId }
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), 'graph-confidence-'))
	execSync('git init', { cwd: testDir })
	execSync('git config user.email "t@t"', { cwd: testDir })
	execSync('git config user.name "t"', { cwd: testDir })
	db = initializeGraphDatabase('test-confidence', testDir)
	repoMap = new RepoMap({ cwd: testDir, db })
	// `getCallers` / `getCallees` build SQL on the fly and don't depend on
	// tree-sitter or cached prepared statements, so we can skip
	// `repoMap.initialize()` here.
})

afterEach(() => {
	closeGraphDatabase()
	rmSync(testDir, { recursive: true, force: true })
})

test('migration adds confidence/tier columns idempotently', () => {
	const cols = db.prepare('PRAGMA table_info(calls)').all() as Array<{
		name: string
		type: string
	}>
	const names = cols.map(c => c.name)
	expect(names).toContain('confidence')
	expect(names).toContain('tier')
	const conf = cols.find(c => c.name === 'confidence')!
	const tier = cols.find(c => c.name === 'tier')!
	expect(conf.type.toUpperCase()).toContain('REAL')
	expect(tier.type.toUpperCase()).toContain('TEXT')

	// Re-initialise: must not throw or duplicate columns.
	initializeGraphDatabase('test-confidence', testDir)
	const cols2 = db.prepare('PRAGMA table_info(calls)').all() as Array<{ name: string }>
	expect(cols2.filter(c => c.name === 'confidence').length).toBe(1)
	expect(cols2.filter(c => c.name === 'tier').length).toBe(1)
})

test('getCallers/getCallees surface tier and confidence', () => {
	const a = seedFileAndSymbol(db, 'a.ts', 'main', 10)
	const b = seedFileAndSymbol(db, 'b.ts', 'helper', 20)

	db.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(a.symbolId, 'helper', b.symbolId, b.fileId, 11, 1.0, 'EXTRACTED')

	db.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(a.symbolId, 'ghost', null, b.fileId, 12, 0.7, 'INFERRED')

	const callees = repoMap.getCallees('a.ts', 10)
	expect(callees.length).toBe(2)
	const helper = callees.find(c => c.calleeName === 'helper')!
	const ghost = callees.find(c => c.calleeName === 'ghost')!
	expect(helper.tier).toBe('EXTRACTED')
	expect(helper.confidence).toBe(1.0)
	expect(ghost.tier).toBe('INFERRED')
	expect(ghost.confidence).toBeCloseTo(0.7, 5)

	const callers = repoMap.getCallers('b.ts', 20)
	const fromMain = callers.find(c => c.callerName === 'main')!
	expect(fromMain).toBeDefined()
	expect(fromMain.tier).toBe('EXTRACTED')
	expect(fromMain.confidence).toBe(1.0)
})

test('minConfidence filter excludes low-tier edges', () => {
	const a = seedFileAndSymbol(db, 'a.ts', 'main', 10)
	const b = seedFileAndSymbol(db, 'b.ts', 'helper', 20)

	db.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(a.symbolId, 'helper', b.symbolId, b.fileId, 11, 1.0, 'EXTRACTED')

	db.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line, confidence, tier) VALUES (?, ?, ?, ?, ?, ?, ?)',
	).run(a.symbolId, 'ghost', null, b.fileId, 12, 0.7, 'INFERRED')

	const all = repoMap.getCallees('a.ts', 10)
	expect(all.map(c => c.calleeName).sort()).toEqual(['ghost', 'helper'])

	const strict = repoMap.getCallees('a.ts', 10, 1.0)
	expect(strict.map(c => c.calleeName)).toEqual(['helper'])

	const midBar = repoMap.getCallees('a.ts', 10, 0.5)
	expect(midBar.map(c => c.calleeName).sort()).toEqual(['ghost', 'helper'])
})

test('rows inserted without confidence/tier fall back to column defaults', () => {
	const a = seedFileAndSymbol(db, 'a.ts', 'main', 10)
	const b = seedFileAndSymbol(db, 'b.ts', 'helper', 20)

	// Legacy-style INSERT without the new columns: DEFAULT values should apply.
	db.prepare(
		'INSERT INTO calls (caller_symbol_id, callee_name, callee_symbol_id, callee_file_id, line) VALUES (?, ?, ?, ?, ?)',
	).run(a.symbolId, 'helper', b.symbolId, b.fileId, 11)

	const callees = repoMap.getCallees('a.ts', 10)
	expect(callees.length).toBe(1)
	expect(callees[0].tier).toBe('EXTRACTED')
	expect(callees[0].confidence).toBe(1.0)
})
