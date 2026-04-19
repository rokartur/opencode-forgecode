/**
 * Port of the forgecode truncation helpers.
 *
 * These run inside `tool.execute.after` to trim the output that opencode would
 * otherwise pipe straight back into the model context. The goal is parity with
 * forgecode's defaults, not byte-perfect equivalence.
 *
 *   - shell / bash  → head+tail line clipping with per-line clipping
 *   - search / grep → cap total lines
 *   - fetch         → cap total characters
 */

const DEFAULTS = {
	shell: { prefixLines: 200, suffixLines: 200, maxLineLength: 500 },
	search: { maxLines: 200, maxLineLength: 400 },
	fetch: { maxChars: 40_000 },
}

export function truncateShell(content: string, opts: Partial<typeof DEFAULTS.shell> = {}): string {
	const { prefixLines, suffixLines, maxLineLength } = { ...DEFAULTS.shell, ...opts }
	const raw = content.split('\n')
	let truncatedLineCount = 0
	const lines = raw.map(line => {
		if (line.length > maxLineLength) {
			truncatedLineCount++
			return `${line.slice(0, maxLineLength)}...[${line.length - maxLineLength} more chars truncated]`
		}
		return line
	})
	const total = lines.length
	if (total <= prefixLines + suffixLines) {
		return lines.join('\n')
	}
	const hidden = total - prefixLines - suffixLines
	const head = lines.slice(0, prefixLines)
	const tail = lines.slice(total - suffixLines)
	const banner = `...[${hidden} lines hidden${truncatedLineCount > 0 ? `; ${truncatedLineCount} long lines clipped` : ''}]...`
	return [...head, banner, ...tail].join('\n')
}

export function truncateSearch(content: string, opts: Partial<typeof DEFAULTS.search> = {}): string {
	const { maxLines, maxLineLength } = { ...DEFAULTS.search, ...opts }
	const raw = content.split('\n')

	// Per-line clipping — minified JS/CSS matches can blow up the context window
	let clippedLineCount = 0
	const clipped = raw.map(line => {
		if (line.length > maxLineLength) {
			clippedLineCount++
			return `${line.slice(0, maxLineLength)}...[${line.length - maxLineLength} more chars truncated]`
		}
		return line
	})

	if (clipped.length <= maxLines) {
		return clipped.join('\n')
	}

	// Count match distribution per file (prefix before first ':') so agent sees
	// the density before the cutoff rather than an arbitrary truncation.
	const fileCounts = new Map<string, number>()
	for (const line of clipped) {
		const idx = line.indexOf(':')
		if (idx > 0) {
			const file = line.slice(0, idx)
			fileCounts.set(file, (fileCounts.get(file) ?? 0) + 1)
		}
	}
	const hidden = clipped.length - maxLines
	const banner =
		fileCounts.size > 0
			? `...[${hidden} more matches truncated across ${fileCounts.size} files${clippedLineCount > 0 ? `; ${clippedLineCount} long lines clipped` : ''}]`
			: `...[${hidden} more matches truncated${clippedLineCount > 0 ? `; ${clippedLineCount} long lines clipped` : ''}]`
	return [...clipped.slice(0, maxLines), banner].join('\n')
}

export function truncateFetch(content: string, opts: Partial<typeof DEFAULTS.fetch> = {}): string {
	const { maxChars } = { ...DEFAULTS.fetch, ...opts }
	if (content.length <= maxChars) return content
	return `${content.slice(0, maxChars)}\n...[${content.length - maxChars} chars truncated]`
}

/**
 * Routes based on the tool name. Unknown tools are returned unchanged.
 */
export function truncateForTool(tool: string, content: string): string {
	switch (tool) {
		case 'bash':
		case 'shell':
			return truncateShell(content)
		case 'grep':
		case 'glob':
		case 'fs_search':
		case 'sem_search':
			return truncateSearch(content)
		case 'webfetch':
		case 'fetch':
			return truncateFetch(content)
		default:
			return content
	}
}
