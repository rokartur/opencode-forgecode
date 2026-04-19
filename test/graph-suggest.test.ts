import { test, expect } from 'bun:test'
import { generateSuggestedQuestions } from '../src/graph/suggest'
import type { SurpriseEdgeResult, BridgeEdgeResult, ExecutionFlow, KnowledgeGapResult } from '../src/graph/types'

const surprise = (from: string, to: string, weight = 0.1): SurpriseEdgeResult => ({
	from,
	to,
	weight,
	communityFrom: 1,
	communityTo: 2,
})

const bridge = (from: string, to: string, weight = 5): BridgeEdgeResult => ({ from, to, weight })

const untested = (name: string, path: string, pagerank = 0.8): KnowledgeGapResult => ({
	name,
	path,
	line: 1,
	pagerank,
	nonTestCallers: 3,
})

const flow = (
	entryName: string,
	entryPath: string,
	tailName: string,
	tailPath: string,
	weight = 0.7,
): ExecutionFlow => ({
	entryName,
	entryPath,
	entryLine: 1,
	entryKind: 'handler',
	weight,
	truncated: false,
	steps: [
		{ depth: 0, name: entryName, path: entryPath, line: 1 },
		{ depth: 1, name: 'middle', path: entryPath, line: 10 },
		{ depth: 2, name: tailName, path: tailPath, line: 20 },
	],
})

test('generateSuggestedQuestions returns [] for empty input', () => {
	expect(generateSuggestedQuestions({})).toEqual([])
})

test('includes one question per populated category', () => {
	const out = generateSuggestedQuestions({
		surprises: [surprise('src/a.ts', 'src/b.ts')],
		bridges: [bridge('src/core.ts', 'src/ui.ts')],
		untested: [untested('hotFn', 'src/hot.ts')],
		flows: [flow('handleRequest', 'src/server.ts', 'writeResponse', 'src/io.ts')],
	})
	const kinds = out.map(q => q.kind).sort()
	expect(kinds).toEqual(['bridge', 'flow', 'surprise', 'untested'])
})

test('uses basename rather than full path in question text', () => {
	const [q] = generateSuggestedQuestions({
		untested: [untested('fn', 'src/nested/deep/file.ts', 0.95)],
	})
	expect(q.text).toContain('`file.ts`')
	expect(q.text).not.toContain('src/nested/deep')
	// But focusPaths preserve the full path for navigation.
	expect(q.focusPaths).toEqual(['src/nested/deep/file.ts'])
})

test('skips execution flows shorter than 3 steps', () => {
	const short: ExecutionFlow = {
		entryName: 'x',
		entryPath: 'src/x.ts',
		entryLine: 1,
		entryKind: 'main',
		weight: 0.9,
		truncated: false,
		steps: [
			{ depth: 0, name: 'x', path: 'src/x.ts', line: 1 },
			{ depth: 1, name: 'y', path: 'src/x.ts', line: 2 },
		],
	}
	const out = generateSuggestedQuestions({ flows: [short] })
	expect(out).toEqual([])
})

test('respects perCategory cap before sorting', () => {
	const surprises = Array.from({ length: 10 }, (_, i) => surprise(`src/a${i}.ts`, `src/b${i}.ts`, 0.1))
	const out = generateSuggestedQuestions({ surprises }, { perCategory: 2, limit: 100 })
	expect(out.length).toBe(2)
})

test('respects overall limit across categories', () => {
	const out = generateSuggestedQuestions(
		{
			surprises: [surprise('a', 'b'), surprise('c', 'd')],
			bridges: [bridge('e', 'f'), bridge('g', 'h')],
			untested: [untested('u1', 'i.ts'), untested('u2', 'j.ts')],
		},
		{ limit: 3 },
	)
	expect(out.length).toBe(3)
})

test('sorts by score descending then path then text', () => {
	const out = generateSuggestedQuestions({
		untested: [
			untested('low', 'src/low.ts', 0.2),
			untested('high', 'src/high.ts', 0.95),
			untested('mid', 'src/mid.ts', 0.5),
		],
	})
	expect(out.map(q => q.score)).toEqual(out.map(q => q.score).sort((a, b) => b - a))
	expect(out[0].text).toContain('`high`')
})

test('de-duplicates identical question text', () => {
	// Two untested entries whose basename+name produce identical text.
	const dup1 = untested('dupFn', 'src/a.ts', 0.9)
	const dup2: KnowledgeGapResult = { ...dup1, path: 'src/a.ts' }
	const out = generateSuggestedQuestions({ untested: [dup1, dup2] })
	expect(out.length).toBe(1)
})

test('is deterministic — same input produces same output', () => {
	const input = {
		surprises: [surprise('a', 'b', 0.1), surprise('c', 'd', 0.2)],
		bridges: [bridge('e', 'f', 5), bridge('g', 'h', 10)],
		untested: [untested('x', 'u.ts', 0.9)],
	}
	const a = generateSuggestedQuestions(input)
	const b = generateSuggestedQuestions(input)
	expect(a).toEqual(b)
})

test('scores are clamped to [0,1]', () => {
	const out = generateSuggestedQuestions({
		untested: [untested('hot', 'p.ts', 5.0)], // pathological pagerank > 1
		bridges: [bridge('a', 'b', 10_000)], // large weight
	})
	for (const q of out) {
		expect(q.score).toBeGreaterThanOrEqual(0)
		expect(q.score).toBeLessThanOrEqual(1)
	}
})

test('surprise score grows as edge weight shrinks', () => {
	const rare = generateSuggestedQuestions({ surprises: [surprise('a', 'b', 0.01)] })[0]
	const common = generateSuggestedQuestions({ surprises: [surprise('a', 'b', 100)] })[0]
	expect(rare.score).toBeGreaterThan(common.score)
})
