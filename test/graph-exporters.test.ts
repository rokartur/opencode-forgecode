import { test, expect } from 'bun:test'
import { toGraphML, toMermaid, toCypher, type ExportGraph } from '../src/graph/exporters'

/**
 * Tests for Etap 9e — Graph exporters (GraphML / Mermaid / Cypher).
 *
 * All three formats emit from the same `ExportGraph` projection, so
 * tests use a shared fixture and verify format-specific invariants.
 */

const fixture: ExportGraph = {
	nodes: [
		{ id: 'src/a.ts', label: 'A', attributes: { lang: 'typescript', size: 120 } },
		{ id: 'src/b.ts', label: 'B' },
		{ id: 'src/weird-name.ts', label: 'Weird & Co' },
	],
	edges: [
		{ from: 'src/a.ts', to: 'src/b.ts', weight: 3 },
		{ from: 'src/a.ts', to: 'src/weird-name.ts', weight: 1, attributes: { kind: 'import' } },
	],
}

// ---------------------------------------------------------------------
// GraphML
// ---------------------------------------------------------------------

test('toGraphML emits header, key declarations, nodes, and edges', () => {
	const out = toGraphML(fixture)
	expect(out.startsWith('<?xml')).toBe(true)
	expect(out).toContain('<graphml ')
	expect(out).toContain('edgedefault="directed"')
	// Node ids preserved verbatim (as attribute, XML-escaped).
	expect(out).toContain('<node id="src/a.ts">')
	expect(out).toContain('<node id="src/b.ts">')
	// Custom attributes declared as <key>.
	expect(out).toMatch(/<key[^/>]*attr\.name="lang"[^/>]*attr\.type="string"/)
	expect(out).toMatch(/<key[^/>]*attr\.name="size"[^/>]*attr\.type="double"/)
	// Edge weight rendered.
	expect(out).toContain('<data key="e_weight">3</data>')
})

test('toGraphML XML-escapes labels and attribute values', () => {
	const out = toGraphML(fixture)
	expect(out).toContain('Weird &amp; Co')
	expect(out).not.toContain('Weird & Co') // raw `&` forbidden in XML
})

// ---------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------

test('toMermaid emits flowchart LR header by default', () => {
	const out = toMermaid(fixture)
	expect(out.split('\n')[0]).toBe('flowchart LR')
})

test('toMermaid respects direction option', () => {
	expect(toMermaid(fixture, { direction: 'TD' }).split('\n')[0]).toBe('flowchart TD')
})

test('toMermaid sanitises ids but preserves labels', () => {
	const out = toMermaid(fixture)
	// `src/a.ts` must become `src_a_ts` (no slashes/dots in Mermaid ids).
	expect(out).toContain('src_a_ts["A"]')
	// Original label preserved.
	expect(out).toContain('["Weird & Co"]')
})

test('toMermaid emits weighted edges only when weight ≠ 1', () => {
	const out = toMermaid(fixture)
	expect(out).toContain('src_a_ts -->|3| src_b_ts')
	// weight=1 on a→weird → no label on edge
	expect(out).toMatch(/src_a_ts --> src_weird_name_ts/)
})

test('toMermaid disambiguates collisions from sanitisation', () => {
	const collide: ExportGraph = {
		nodes: [
			{ id: 'a/b.ts', label: 'X' },
			{ id: 'a.b.ts', label: 'Y' },
		],
		edges: [],
	}
	const out = toMermaid(collide)
	// Both sanitise to `a_b_ts`; second must get a numeric suffix.
	expect(out).toMatch(/a_b_ts\["X"\]/)
	expect(out).toMatch(/a_b_ts_1\["Y"\]/)
})

// ---------------------------------------------------------------------
// Cypher
// ---------------------------------------------------------------------

test('toCypher emits MERGE for every node and edge', () => {
	const out = toCypher(fixture)
	expect((out.match(/MERGE \(:File/g) ?? []).length).toBe(3)
	expect((out.match(/MERGE \(a\)-\[:IMPORTS/g) ?? []).length).toBe(2)
})

test('toCypher quotes paths with single-quote escaping', () => {
	const g: ExportGraph = {
		nodes: [{ id: "a'weird.ts", label: "a'" }],
		edges: [],
	}
	const out = toCypher(g)
	expect(out).toContain("path: 'a\\'weird.ts'")
})

test('toCypher honours custom nodeLabel/relationshipType', () => {
	const out = toCypher(fixture, { nodeLabel: 'Module', relationshipType: 'CALLS' })
	expect(out).toContain('MERGE (:Module')
	expect(out).toContain('-[:CALLS')
})

test('toCypher serialises numeric attributes without quotes', () => {
	const out = toCypher(fixture)
	// size=120 on src/a.ts → must appear as `size: 120` not `'120'`.
	expect(out).toMatch(/size: 120/)
})

// ---------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------

test('all exporters handle empty graphs gracefully', () => {
	const empty: ExportGraph = { nodes: [], edges: [] }
	expect(toGraphML(empty)).toContain('<graph ')
	expect(toMermaid(empty)).toBe('flowchart LR')
	expect(toCypher(empty)).toBe('')
})
