/**
 * Shared rendering helpers for grep-style tool outputs.
 *
 * Used by both the sandbox (`sandbox-fs.ts`) and host (`host-fs.ts`)
 * implementations so that agents see a consistent, token-efficient format:
 *
 *   Found N matches
 *   path/to/file.ts:
 *     L12: <snippet>
 *     L47: <snippet>
 *   ...
 */

export interface GrepMatch {
	/** 1-based line number. */
	line: number
	/** Rendered snippet (already clipped to the desired length). */
	text: string
}

export interface GrepFileMatches {
	path: string
	matches: GrepMatch[]
}

export interface RenderOptions {
	/** When true, append the "Results truncated" footer. */
	truncated?: boolean
	/** Limit used upstream (shown in the truncation footer). */
	limit?: number
}

/** Render grouped grep output. `totalMatches` counts pre-group rows. */
export function renderGrepResults(grouped: GrepFileMatches[], totalMatches: number, opts: RenderOptions = {}): string {
	if (grouped.length === 0 || totalMatches === 0) return 'No matches found'

	const parts: string[] = []
	parts.push(`Found ${totalMatches} matches`)
	for (const { path, matches } of grouped) {
		parts.push(`${path}:`)
		for (const m of matches) {
			parts.push(`  L${m.line}: ${m.text}`)
		}
		parts.push('')
	}
	if (opts.truncated) {
		const limit = opts.limit ?? totalMatches
		parts.push(
			`(Results truncated: showing ${limit} of possibly more matches. Consider using a more specific path or pattern.)`,
		)
	}
	return parts.join('\n').trimEnd()
}

/** Clip a line of text to a max length, preserving a truncation marker. */
export function clipLine(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text
	return `${text.slice(0, maxLen)}...[+${text.length - maxLen} chars]`
}

/**
 * Given the full matched line and the submatch byte offsets, return a window
 * of `contextChars` characters around the first submatch. Used to avoid dumping
 * entire minified lines into the context window.
 */
export function windowAroundSubmatch(
	line: string,
	submatchStart: number,
	submatchEnd: number,
	contextChars = 30,
): string {
	const start = Math.max(0, submatchStart - contextChars)
	const end = Math.min(line.length, submatchEnd + contextChars)
	const prefix = start > 0 ? '…' : ''
	const suffix = end < line.length ? '…' : ''
	return prefix + line.slice(start, end) + suffix
}
