// Community detection, bridges, and surprise edges (Etap 9d).
//
// All algorithms here are pure over a small in-memory adjacency list
// projection of the file-level `edges` table. No extra NPM dependency.
//
// Design choices:
//
// - **Label Propagation** (synchronous, deterministic) is used instead
//   of Louvain. It's O(E * iterations), has no modularity-tuning
//   parameter, and produces stable output for identical input when we
//   break ties by lowest node id. For the scale we care about
//   (~10k files) it converges in <20 iterations.
// - **Tarjan's bridge-finding** runs in O(V + E) over the undirected
//   projection. Directed import edges (`A → B`) become undirected for
//   the purpose of "would removing this disconnect the graph?".
// - **Surprise edges** are derived from the community assignment:
//   an edge `A → B` is surprising iff community(A) ≠ community(B)
//   AND its weight is below a percentile threshold (default p25).

import type { BridgeEdgeResult, CommunityResult, SurpriseEdgeResult } from './types'

export interface GraphEdgeRow {
	source: string
	target: string
	weight: number
}

/**
 * Runs synchronous Label Propagation over an undirected projection of
 * the given edges. Returns a `Map<path, communityId>` and a summary
 * list ordered by community size descending.
 */
export function detectCommunities(
	edges: GraphEdgeRow[],
	opts: { maxIterations?: number } = {},
): { assignment: Map<string, number>; communities: CommunityResult[] } {
	const maxIterations = opts.maxIterations ?? 30

	// Build undirected adjacency (sum weights for parallel directed edges).
	const neighbours = new Map<string, Map<string, number>>()
	const touch = (a: string, b: string, w: number) => {
		let m = neighbours.get(a)
		if (!m) {
			m = new Map()
			neighbours.set(a, m)
		}
		m.set(b, (m.get(b) ?? 0) + w)
	}
	for (const e of edges) {
		if (e.source === e.target) continue
		touch(e.source, e.target, e.weight)
		touch(e.target, e.source, e.weight)
	}

	// Stable node order → deterministic tie-breaking.
	const nodes = [...neighbours.keys()].sort()
	const labelOf = new Map<string, string>()
	for (const n of nodes) labelOf.set(n, n)

	// **Asynchronous** label propagation: updates take effect within the
	// same iteration. Pure synchronous LP oscillates on bipartite-like
	// structures (e.g. path graphs); asynchronous LP converges reliably
	// and — because we iterate nodes in sorted order and break score
	// ties lexicographically — remains fully deterministic.
	for (let iter = 0; iter < maxIterations; iter++) {
		let changed = false
		for (const n of nodes) {
			const nbrs = neighbours.get(n)!
			if (nbrs.size === 0) continue
			const score = new Map<string, number>()
			for (const [m, w] of nbrs) {
				const l = labelOf.get(m)!
				score.set(l, (score.get(l) ?? 0) + w)
			}
			let bestLabel = labelOf.get(n)!
			let bestScore = -Infinity
			const sorted = [...score.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
			for (const [l, s] of sorted) {
				if (s > bestScore) {
					bestScore = s
					bestLabel = l
				}
			}
			if (bestLabel !== labelOf.get(n)) {
				labelOf.set(n, bestLabel)
				changed = true
			}
		}
		if (!changed) break
	}

	// Compact labels → small integer ids ordered by community size.
	const buckets = new Map<string, string[]>()
	for (const [node, label] of labelOf) {
		let arr = buckets.get(label)
		if (!arr) {
			arr = []
			buckets.set(label, arr)
		}
		arr.push(node)
	}
	const ordered = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length)

	const assignment = new Map<string, number>()
	const communities: CommunityResult[] = []
	for (let i = 0; i < ordered.length; i++) {
		const [, files] = ordered[i]
		files.sort()
		for (const f of files) assignment.set(f, i)
		communities.push({
			id: i,
			size: files.length,
			files,
			internalWeight: 0,
			externalWeight: 0,
		})
	}

	// Second pass: tally internal vs external edge weight per community.
	for (const e of edges) {
		if (e.source === e.target) continue
		const ca = assignment.get(e.source)
		const cb = assignment.get(e.target)
		if (ca === undefined || cb === undefined) continue
		if (ca === cb) {
			communities[ca].internalWeight += e.weight
		} else {
			communities[ca].externalWeight += e.weight
			communities[cb].externalWeight += e.weight
		}
	}

	return { assignment, communities }
}

/**
 * Tarjan's bridge algorithm over the undirected projection of the
 * given directed edges. Returns edges whose removal would disconnect
 * at least two previously-connected nodes.
 */
export function detectBridges(edges: GraphEdgeRow[]): BridgeEdgeResult[] {
	// Build undirected adjacency; remember one representative weight per
	// unordered pair for the output row.
	const adj = new Map<string, Set<string>>()
	const pairWeight = new Map<string, number>()
	const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`)

	for (const e of edges) {
		if (e.source === e.target) continue
		let sa = adj.get(e.source)
		if (!sa) {
			sa = new Set()
			adj.set(e.source, sa)
		}
		sa.add(e.target)
		let sb = adj.get(e.target)
		if (!sb) {
			sb = new Set()
			adj.set(e.target, sb)
		}
		sb.add(e.source)
		const k = pairKey(e.source, e.target)
		pairWeight.set(k, Math.max(pairWeight.get(k) ?? 0, e.weight))
	}

	const nodes = [...adj.keys()].sort()
	const disc = new Map<string, number>()
	const low = new Map<string, number>()
	const parent = new Map<string, string | null>()
	const bridges: BridgeEdgeResult[] = []
	let timer = 0

	// Iterative DFS to avoid stack overflow on deep import chains.
	function dfs(start: string) {
		type Frame = { node: string; iter: Iterator<string>; parent: string | null }
		const stack: Frame[] = []
		disc.set(start, timer)
		low.set(start, timer)
		timer++
		parent.set(start, null)
		stack.push({ node: start, iter: adj.get(start)!.values(), parent: null })

		while (stack.length > 0) {
			const top = stack[stack.length - 1]
			const next = top.iter.next()
			if (next.done) {
				stack.pop()
				if (stack.length > 0) {
					const below = stack[stack.length - 1]
					const lowTop = low.get(top.node)!
					const lowBelow = low.get(below.node)!
					if (lowTop < lowBelow) low.set(below.node, lowTop)
					if (lowTop > disc.get(below.node)!) {
						const k = pairKey(below.node, top.node)
						bridges.push({
							from: below.node < top.node ? below.node : top.node,
							to: below.node < top.node ? top.node : below.node,
							weight: pairWeight.get(k) ?? 1,
						})
					}
				}
				continue
			}
			const v = next.value
			if (!disc.has(v)) {
				disc.set(v, timer)
				low.set(v, timer)
				timer++
				parent.set(v, top.node)
				stack.push({ node: v, iter: adj.get(v)!.values(), parent: top.node })
			} else if (v !== top.parent) {
				const lowTop = low.get(top.node)!
				const dv = disc.get(v)!
				if (dv < lowTop) low.set(top.node, dv)
			}
		}
	}

	for (const n of nodes) {
		if (!disc.has(n)) dfs(n)
	}

	bridges.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
	return bridges
}

/**
 * Returns edges that cross community boundaries AND have a weight at
 * or below `percentile` of all edge weights. These are architectural
 * smoke: a one-off link between otherwise-unrelated subsystems.
 */
export function detectSurpriseEdges(
	edges: GraphEdgeRow[],
	assignment: Map<string, number>,
	opts: { percentile?: number } = {},
): SurpriseEdgeResult[] {
	const p = opts.percentile ?? 0.25
	if (edges.length === 0) return []
	const weights = edges.map(e => e.weight).sort((a, b) => a - b)
	const cutIdx = Math.max(0, Math.floor(weights.length * p) - 1)
	const threshold = weights[cutIdx]

	const out: SurpriseEdgeResult[] = []
	for (const e of edges) {
		if (e.source === e.target) continue
		const ca = assignment.get(e.source)
		const cb = assignment.get(e.target)
		if (ca === undefined || cb === undefined) continue
		if (ca === cb) continue
		if (e.weight > threshold) continue
		out.push({
			from: e.source,
			to: e.target,
			weight: e.weight,
			communityFrom: ca,
			communityTo: cb,
		})
	}
	out.sort((a, b) =>
		a.weight !== b.weight
			? a.weight - b.weight
			: a.from < b.from
				? -1
				: a.from > b.from
					? 1
					: a.to < b.to
						? -1
						: a.to > b.to
							? 1
							: 0,
	)
	return out
}
