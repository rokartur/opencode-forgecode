// Suggested questions (Etap 9k).
//
// Pure generator that turns graph analysis outputs into short natural
// language prompts the TUI can surface after a session starts. The
// module is deliberately IO-free and has no dependency on graphService
// or SQLite — callers collect the analysis results once and hand them
// in. This keeps the ranking rules trivial to unit-test and lets us
// swap templates without touching graph plumbing.

import type { SurpriseEdgeResult, BridgeEdgeResult, ExecutionFlow, KnowledgeGapResult } from './types'

export interface SuggestedQuestion {
	/** The user-facing prompt. */
	text: string
	/** Anomaly category that produced this question. */
	kind: 'surprise' | 'bridge' | 'untested' | 'flow'
	/** 0..1 ranking score — higher = more interesting. */
	score: number
	/** File paths referenced in the question, for in-TUI highlighting. */
	focusPaths: string[]
}

export interface SuggestInput {
	surprises?: readonly SurpriseEdgeResult[]
	bridges?: readonly BridgeEdgeResult[]
	untested?: readonly KnowledgeGapResult[]
	flows?: readonly ExecutionFlow[]
}

export interface SuggestOptions {
	/** Max questions returned, after cross-category de-duplication. Default 5. */
	limit?: number
	/** Per-category cap before interleaving. Default 2. */
	perCategory?: number
}

/**
 * Generates ranked, de-duplicated suggested questions from graph
 * anomaly outputs. Deterministic for a given input — sorting is total
 * (score desc, then path, then text) so snapshot tests are stable.
 */
export function generateSuggestedQuestions(input: SuggestInput, opts: SuggestOptions = {}): SuggestedQuestion[] {
	const limit = opts.limit ?? 5
	const perCategory = opts.perCategory ?? 2

	const candidates: SuggestedQuestion[] = []

	// --- Surprise edges ----------------------------------------------
	// These are cross-community calls with unusually low weight — a
	// strong hint the edge is load-bearing but poorly understood.
	for (const s of (input.surprises ?? []).slice(0, perCategory)) {
		candidates.push({
			text: `Why does \`${basename(s.from)}\` call \`${basename(s.to)}\`? It looks like an out-of-module dependency.`,
			kind: 'surprise',
			// Lower weights are more surprising; invert+squash into [0,1].
			score: 1 - squash(s.weight),
			focusPaths: [s.from, s.to],
		})
	}

	// --- Bridges ------------------------------------------------------
	// Articulation points — removing them disconnects modules. Good
	// candidates for asking "what happens if X breaks?".
	for (const b of (input.bridges ?? []).slice(0, perCategory)) {
		candidates.push({
			text: `\`${basename(b.from)}\` is a bridge between modules — what blast radius would breaking it cause?`,
			kind: 'bridge',
			// Bridge weight isn't normalised; squash into [0,1].
			score: squash(b.weight),
			focusPaths: [b.from, b.to],
		})
	}

	// --- Untested hotspots -------------------------------------------
	for (const u of (input.untested ?? []).slice(0, perCategory)) {
		candidates.push({
			text: `\`${u.name}\` in \`${basename(u.path)}\` is a high-PageRank symbol with no tests — should we add coverage?`,
			kind: 'untested',
			score: clamp01(u.pagerank),
			focusPaths: [u.path],
		})
	}

	// --- Execution flows ---------------------------------------------
	// Only surface flows that actually traverse multiple layers —
	// single-step flows aren't interesting enough to ask about.
	for (const f of (input.flows ?? []).filter(x => x.steps.length >= 3).slice(0, perCategory)) {
		const tail = f.steps[f.steps.length - 1]
		candidates.push({
			text: `Walk me through the \`${f.entryName}\` ${f.entryKind} flow (ends in \`${tail.name}\`).`,
			kind: 'flow',
			score: clamp01(f.weight),
			focusPaths: [f.entryPath, tail.path],
		})
	}

	// Deterministic total order — required so multiple calls on the
	// same input produce identical output.
	candidates.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		const pathCmp = (a.focusPaths[0] ?? '').localeCompare(b.focusPaths[0] ?? '')
		if (pathCmp !== 0) return pathCmp
		return a.text.localeCompare(b.text)
	})

	// De-dup by exact question text (different analyses can surface the
	// same hotspot twice).
	const seen = new Set<string>()
	const out: SuggestedQuestion[] = []
	for (const c of candidates) {
		if (seen.has(c.text)) continue
		seen.add(c.text)
		out.push(c)
		if (out.length >= limit) break
	}
	return out
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function basename(p: string): string {
	const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
	return idx === -1 ? p : p.slice(idx + 1)
}

function clamp01(n: number): number {
	if (!Number.isFinite(n)) return 0
	if (n < 0) return 0
	if (n > 1) return 1
	return n
}

/** log1p-based squash into [0,1] for unbounded metrics like betweenness. */
function squash(n: number): number {
	if (!Number.isFinite(n) || n <= 0) return 0
	// 1 - 1/(1+ln(1+x)) grows gently and never reaches 1.
	return 1 - 1 / (1 + Math.log1p(n))
}
