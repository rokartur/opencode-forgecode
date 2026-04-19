import { test, expect, beforeEach, afterEach } from 'bun:test'
import { initializeGraphDatabase, closeGraphDatabase } from '../src/graph/database'
import { RepoMap } from '../src/graph/repo-map'
import { detectCommunities, detectBridges, detectSurpriseEdges, type GraphEdgeRow } from '../src/graph/communities'
import type { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

/**
 * Tests for Etap 9d — Community detection, bridges, and surprise edges.
 *
 * Pure algorithm tests exercise the `communities.ts` module directly;
 * integration tests seed the SQLite `edges` table and run the RepoMap
 * wrapper end-to-end.
 */

// --------------------------------------------------------------------
// Pure algorithm tests
// --------------------------------------------------------------------

test('detectCommunities clusters two densely connected triangles', () => {
	// Cluster A: a1-a2-a3 triangle, Cluster B: b1-b2-b3 triangle,
	// with a single low-weight bridge a1→b1.
	const edges: GraphEdgeRow[] = [
		{ source: 'a1', target: 'a2', weight: 5 },
		{ source: 'a2', target: 'a3', weight: 5 },
		{ source: 'a3', target: 'a1', weight: 5 },
		{ source: 'b1', target: 'b2', weight: 5 },
		{ source: 'b2', target: 'b3', weight: 5 },
		{ source: 'b3', target: 'b1', weight: 5 },
		{ source: 'a1', target: 'b1', weight: 1 },
	]
	const { assignment, communities } = detectCommunities(edges)

	// Two communities expected.
	expect(communities.length).toBe(2)
	// a1/a2/a3 share a community distinct from b1/b2/b3.
	const ca = assignment.get('a1')!
	expect(assignment.get('a2')).toBe(ca)
	expect(assignment.get('a3')).toBe(ca)
	const cb = assignment.get('b1')!
	expect(assignment.get('b2')).toBe(cb)
	expect(assignment.get('b3')).toBe(cb)
	expect(ca).not.toBe(cb)

	// Internal/external weight tallied correctly: each triangle = 3 edges × 5 = 15 internal.
	for (const c of communities) {
		expect(c.internalWeight).toBe(15)
		expect(c.externalWeight).toBe(1) // the single bridge
	}
})

test('detectCommunities is deterministic on identical input', () => {
	const edges: GraphEdgeRow[] = [
		{ source: 'x', target: 'y', weight: 1 },
		{ source: 'y', target: 'z', weight: 1 },
	]
	const run1 = detectCommunities(edges)
	const run2 = detectCommunities(edges)
	expect([...run1.assignment.entries()].sort()).toEqual([...run2.assignment.entries()].sort())
})

test('detectCommunities handles empty edge list', () => {
	const { assignment, communities } = detectCommunities([])
	expect(assignment.size).toBe(0)
	expect(communities).toEqual([])
})

test('detectBridges finds the single edge connecting two triangles', () => {
	const edges: GraphEdgeRow[] = [
		{ source: 'a1', target: 'a2', weight: 1 },
		{ source: 'a2', target: 'a3', weight: 1 },
		{ source: 'a3', target: 'a1', weight: 1 },
		{ source: 'b1', target: 'b2', weight: 1 },
		{ source: 'b2', target: 'b3', weight: 1 },
		{ source: 'b3', target: 'b1', weight: 1 },
		{ source: 'a1', target: 'b1', weight: 3 },
	]
	const bridges = detectBridges(edges)
	expect(bridges).toEqual([{ from: 'a1', to: 'b1', weight: 3 }])
})

test('detectBridges finds every edge of a path graph', () => {
	// Path a-b-c-d: all 3 edges are bridges.
	const edges: GraphEdgeRow[] = [
		{ source: 'a', target: 'b', weight: 1 },
		{ source: 'b', target: 'c', weight: 1 },
		{ source: 'c', target: 'd', weight: 1 },
	]
	const bridges = detectBridges(edges)
	expect(bridges.length).toBe(3)
	expect(bridges.map(b => `${b.from}-${b.to}`).sort()).toEqual(['a-b', 'b-c', 'c-d'])
})

test('detectBridges finds none in a triangle', () => {
	const edges: GraphEdgeRow[] = [
		{ source: 'a', target: 'b', weight: 1 },
		{ source: 'b', target: 'c', weight: 1 },
		{ source: 'c', target: 'a', weight: 1 },
	]
	expect(detectBridges(edges)).toEqual([])
})

test('detectSurpriseEdges flags low-weight cross-community edges only', () => {
	const edges: GraphEdgeRow[] = [
		{ source: 'a1', target: 'a2', weight: 10 },
		{ source: 'a2', target: 'a3', weight: 10 },
		{ source: 'a3', target: 'a1', weight: 10 },
		{ source: 'b1', target: 'b2', weight: 10 },
		{ source: 'b2', target: 'b3', weight: 10 },
		{ source: 'b3', target: 'b1', weight: 10 },
		// Single low-weight cross edge = surprise.
		{ source: 'a1', target: 'b1', weight: 1 },
	]
	const { assignment, communities } = detectCommunities(edges)
	// Sanity: the low cross-edge must not dissolve the two clusters.
	expect(communities.length).toBe(2)
	const surprises = detectSurpriseEdges(edges, assignment, { percentile: 0.25 })
	expect(surprises.length).toBe(1)
	expect(surprises[0]).toMatchObject({ from: 'a1', to: 'b1', weight: 1 })
	expect(surprises[0].communityFrom).not.toBe(surprises[0].communityTo)
})

// --------------------------------------------------------------------
// Integration tests against seeded SQLite `edges` table
// --------------------------------------------------------------------

let testDir: string
let db: Database
let repoMap: RepoMap

function seedFile(d: Database, path: string): number {
	const res = d
		.prepare(
			'INSERT INTO files (path, mtime_ms, language, line_count, is_barrel, indexed_at) VALUES (?, 0, ?, 1, 0, 0)',
		)
		.run(path, 'typescript')
	return Number(res.lastInsertRowid)
}

function seedEdge(d: Database, source: number, target: number, weight: number) {
	d.prepare(
		'INSERT OR REPLACE INTO edges (source_file_id, target_file_id, weight, confidence) VALUES (?, ?, ?, 1.0)',
	).run(source, target, weight)
}

beforeEach(() => {
	testDir = mkdtempSync(join(tmpdir(), 'graph-communities-'))
	execSync('git init', { cwd: testDir })
	execSync('git config user.email "t@t"', { cwd: testDir })
	execSync('git config user.name "t"', { cwd: testDir })
	db = initializeGraphDatabase('test-communities', testDir)
	repoMap = new RepoMap({ cwd: testDir, db })
})

afterEach(() => {
	closeGraphDatabase()
	rmSync(testDir, { recursive: true, force: true })
})

test('RepoMap.getCommunityAnalysis loads edges from DB and clusters', () => {
	const a1 = seedFile(db, 'a1.ts')
	const a2 = seedFile(db, 'a2.ts')
	const a3 = seedFile(db, 'a3.ts')
	const b1 = seedFile(db, 'b1.ts')
	const b2 = seedFile(db, 'b2.ts')
	const b3 = seedFile(db, 'b3.ts')
	seedEdge(db, a1, a2, 5)
	seedEdge(db, a2, a3, 5)
	seedEdge(db, a3, a1, 5)
	seedEdge(db, b1, b2, 5)
	seedEdge(db, b2, b3, 5)
	seedEdge(db, b3, b1, 5)
	seedEdge(db, a1, b1, 1)

	const result = repoMap.getCommunityAnalysis()
	expect(result.communities.length).toBe(2)
	const sizes = result.communities.map(c => c.size).sort()
	expect(sizes).toEqual([3, 3])
	expect(result.bridges).toEqual([{ from: 'a1.ts', to: 'b1.ts', weight: 1 }])
})

test('RepoMap convenience wrappers return matching subsets', () => {
	const a = seedFile(db, 'a.ts')
	const b = seedFile(db, 'b.ts')
	const c = seedFile(db, 'c.ts')
	seedEdge(db, a, b, 1)
	seedEdge(db, b, c, 1)

	const communities = repoMap.getCommunities()
	const bridges = repoMap.getBridges()
	// Path graph → all internal edges are bridges.
	expect(bridges.length).toBe(2)
	// Single connected component → single community.
	expect(communities.length).toBe(1)
	expect(communities[0].files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
})

test('RepoMap.getCommunityAnalysis handles empty graph gracefully', () => {
	const result = repoMap.getCommunityAnalysis()
	expect(result.communities).toEqual([])
	expect(result.bridges).toEqual([])
	expect(result.surprises).toEqual([])
})
