/**
 * Host-side `grep` / `glob` fast path — wraps ripgrep (`rg`) and renders
 * a token-efficient, grouped output analogous to the sandbox variant.
 *
 * Activated by `src/hooks/host-tools.ts` only when:
 *   - `rg` is available on PATH, and
 *   - the current session is NOT running in a sandbox (sandbox-tools.ts
 *     handles grep/glob inside containers separately).
 *
 * Gracefully falls through (returns null) when `rg` is not available, so the
 * caller can fall back to opencode's built-in implementation.
 */

import { spawnSync } from 'child_process'
import {
	renderGrepResults,
	clipLine,
	windowAroundSubmatch,
	type GrepFileMatches,
	type GrepMatch,
} from './search-render'

const RG_TIMEOUT_MS = 30_000
const RG_MAX_BUFFER = 10 * 1024 * 1024 // 10 MB
const MATCH_LIMIT = 100
const MAX_COLUMNS = 300
const CONTEXT_CHARS = 30
const SNIPPET_MAX_LEN = 400

let rgAvailability: { available: boolean; version?: string } | null = null

/** Probe whether `rg` is installed. Result is memoised for the process lifetime. */
export function isRipgrepAvailable(): boolean {
	if (rgAvailability) return rgAvailability.available
	try {
		const result = spawnSync('rg', ['--version'], {
			timeout: 5000,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		rgAvailability =
			result.status === 0 && result.stdout
				? { available: true, version: result.stdout.split('\n')[0]?.trim() }
				: { available: false }
	} catch {
		rgAvailability = { available: false }
	}
	return rgAvailability.available
}

/** Resets the cached probe (tests only). */
export function __resetRipgrepProbeForTests(): void {
	rgAvailability = null
}

export interface HostGlobOptions {
	path?: string
	cwd: string
}

export interface HostGrepOptions {
	path?: string
	include?: string
	cwd: string
}

/**
 * List files matching a glob pattern using `rg --files --glob`.
 * Returns `null` when `rg` is unavailable so callers can fall back.
 */
export function executeHostGlob(pattern: string, opts: HostGlobOptions): string | null {
	if (!isRipgrepAvailable()) return null

	const args = ['--files', '--hidden', '--no-messages', '--glob', pattern]
	if (opts.path) args.push(opts.path)

	const result = spawnSync('rg', args, {
		cwd: opts.cwd,
		timeout: RG_TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: RG_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	if (result.error) {
		return `Glob failed: ${result.error.message}`
	}
	// rg exits 1 when no match — that's not an error for us.
	const stdout = result.stdout?.trim() ?? ''
	if (!stdout) return 'No files found'

	const lines = stdout.split('\n').filter(Boolean)
	const truncated = lines.length > MATCH_LIMIT
	const shown = truncated ? lines.slice(0, MATCH_LIMIT) : lines

	let output = shown.join('\n')
	if (truncated) {
		output += `\n\n(Results truncated: showing first ${MATCH_LIMIT} of ${lines.length} files. Use a more specific path or pattern.)`
	}
	return output
}

/**
 * Search for a regex pattern using `rg --json`. Renders each match as a
 * submatch-centred window (±30 chars) rather than the full line, which is
 * critical for minified / long-line repositories.
 */
export function executeHostGrep(pattern: string, opts: HostGrepOptions): string | null {
	if (!isRipgrepAvailable()) return null

	const args = ['--json', '--hidden', '--no-messages', '--smart-case', `--max-columns=${MAX_COLUMNS}`, '-e', pattern]
	if (opts.include) {
		args.push('--glob', opts.include)
	}
	if (opts.path) {
		args.push(opts.path)
	}

	const result = spawnSync('rg', args, {
		cwd: opts.cwd,
		timeout: RG_TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: RG_MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})

	if (result.error) {
		return `Grep failed: ${result.error.message}`
	}

	const stdout = result.stdout ?? ''
	if (!stdout.trim()) return 'No matches found'

	return parseRipgrepJson(stdout)
}

/** Parse ripgrep's `--json` event stream. Exported for unit tests. */
export function parseRipgrepJson(stdout: string): string {
	const grouped = new Map<string, GrepMatch[]>()
	let totalMatches = 0
	let truncated = false

	for (const rawLine of stdout.split('\n')) {
		if (!rawLine) continue
		let evt: RipgrepEvent
		try {
			evt = JSON.parse(rawLine) as RipgrepEvent
		} catch {
			continue
		}
		if (evt.type !== 'match') continue
		if (totalMatches >= MATCH_LIMIT) {
			truncated = true
			break
		}
		const m = evt.data
		const path = m.path?.text
		const lineNum = m.line_number
		if (!path || typeof lineNum !== 'number') continue

		const lineText = m.lines?.text ?? ''
		let snippet: string
		const firstSub = m.submatches?.[0]
		if (firstSub) {
			snippet = windowAroundSubmatch(lineText, firstSub.start, firstSub.end, CONTEXT_CHARS)
		} else {
			snippet = lineText
		}
		snippet = clipLine(snippet.replace(/\n+$/u, ''), SNIPPET_MAX_LEN)

		const bucket = grouped.get(path) ?? []
		bucket.push({ line: lineNum, text: snippet })
		grouped.set(path, bucket)
		totalMatches++
	}

	if (totalMatches === 0) return 'No matches found'

	const result: GrepFileMatches[] = []
	for (const [path, matches] of grouped) result.push({ path, matches })
	return renderGrepResults(result, totalMatches, { truncated, limit: MATCH_LIMIT })
}

// --- ripgrep JSON event shapes (only the fields we actually use) ---
interface RipgrepEvent {
	type: 'begin' | 'match' | 'context' | 'end' | 'summary'
	data: {
		path?: { text?: string }
		line_number?: number
		lines?: { text?: string }
		submatches?: Array<{ start: number; end: number; match?: { text?: string } }>
	}
}
