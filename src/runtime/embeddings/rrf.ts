/**
 * Reciprocal Rank Fusion (RRF) — combine multiple ranked lists into one.
 *
 * Reference: Cormack, Clarke, Büttcher (2009), "Reciprocal Rank Fusion
 * outperforms Condorcet and individual Rank Learning Methods."
 *
 * Formula: score(d) = Σ 1 / (k + rank_i(d))
 * where k is a constant (default 60) that dampens high-rank dominance.
 *
 * Used to combine BM25 keyword ranking and dense-vector cosine ranking
 * without score normalization (scales are incomparable).
 */

export interface RankedItem<T> {
	/** Stable identifier used to dedupe across lists. */
	id: string
	/** Original item payload, returned in fused result. */
	item: T
}

export interface FusedResult<T> {
	id: string
	item: T
	score: number
	/** Rank (1-based) in each input list, or undefined if absent. */
	ranks: Record<string, number>
}

/**
 * Fuse multiple ranked lists. Lists are keyed by name (e.g., "semantic", "keyword")
 * for debuggability. Items ordered best-first in each list.
 *
 * Returns items sorted by fused score descending.
 */
export function reciprocalRankFusion<T>(
	lists: Record<string, RankedItem<T>[]>,
	opts: { k?: number; topK?: number } = {},
): FusedResult<T>[] {
	const k = opts.k ?? 60
	const merged = new Map<string, FusedResult<T>>()

	for (const [listName, items] of Object.entries(lists)) {
		for (let i = 0; i < items.length; i++) {
			const rank = i + 1
			const contribution = 1 / (k + rank)
			const existing = merged.get(items[i].id)
			if (existing) {
				existing.score += contribution
				existing.ranks[listName] = rank
			} else {
				merged.set(items[i].id, {
					id: items[i].id,
					item: items[i].item,
					score: contribution,
					ranks: { [listName]: rank },
				})
			}
		}
	}

	const fused = [...merged.values()].sort((a, b) => b.score - a.score)
	return opts.topK ? fused.slice(0, opts.topK) : fused
}
