/**
 * Symbol-aware code chunker for embedding indexing.
 *
 * Chunks code by semantic boundaries (functions, classes, methods)
 * rather than fixed line counts. Reuses graph symbol data when available.
 *
 * Fallback: line-based chunking with overlap when symbol data unavailable.
 */

export interface CodeChunk {
	/** Unique ID for the chunk. */
	id: string
	/** File path relative to project root. */
	filePath: string
	/** Start line (1-based). */
	startLine: number
	/** End line (1-based, inclusive). */
	endLine: number
	/** The actual text content of the chunk. */
	content: string
	/** Symbol name if this chunk corresponds to a symbol. */
	symbolName?: string
	/** Symbol kind (function, class, method, etc). */
	symbolKind?: string
}

export interface ChunkerConfig {
	/** Max chunk size in characters. Larger symbols get split. Default: 2000. */
	maxChunkSize?: number
	/** Line-based chunk size (fallback). Default: 50 lines. */
	linesPerChunk?: number
	/** Overlap lines between chunks (fallback). Default: 10. */
	overlapLines?: number
}

export interface SymbolInfo {
	name: string
	kind: string
	startLine: number
	endLine: number
}

/**
 * Chunk a file's content using symbol boundaries.
 * Falls back to line-based chunking when no symbols are provided.
 */
export function chunkFile(
	filePath: string,
	content: string,
	symbols?: SymbolInfo[],
	config: ChunkerConfig = {},
): CodeChunk[] {
	const maxChunkSize = config.maxChunkSize ?? 2000
	const linesPerChunk = config.linesPerChunk ?? 50
	const overlapLines = config.overlapLines ?? 10

	if (symbols && symbols.length > 0) {
		return chunkBySymbols(filePath, content, symbols, maxChunkSize)
	}

	return chunkByLines(filePath, content, linesPerChunk, overlapLines, maxChunkSize)
}

function chunkBySymbols(filePath: string, content: string, symbols: SymbolInfo[], maxChunkSize: number): CodeChunk[] {
	const lines = content.split('\n')
	const chunks: CodeChunk[] = []

	// Sort symbols by start line
	const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine)

	// Track covered lines to fill gaps
	let lastEnd = 0

	for (const sym of sorted) {
		const start = Math.max(sym.startLine - 1, 0) // 0-based
		const end = Math.min(sym.endLine, lines.length)

		// Fill gap before this symbol
		if (start > lastEnd) {
			const gapContent = lines.slice(lastEnd, start).join('\n')
			if (gapContent.trim().length > 0) {
				chunks.push(
					...splitIfNeeded(
						{
							id: `${filePath}:${lastEnd + 1}-${start}`,
							filePath,
							startLine: lastEnd + 1,
							endLine: start,
							content: gapContent,
						},
						maxChunkSize,
						filePath,
					),
				)
			}
		}

		// Symbol chunk
		const symContent = lines.slice(start, end).join('\n')
		chunks.push(
			...splitIfNeeded(
				{
					id: `${filePath}:${sym.name}:${start + 1}-${end}`,
					filePath,
					startLine: start + 1,
					endLine: end,
					content: symContent,
					symbolName: sym.name,
					symbolKind: sym.kind,
				},
				maxChunkSize,
				filePath,
			),
		)

		lastEnd = Math.max(lastEnd, end)
	}

	// Fill trailing gap
	if (lastEnd < lines.length) {
		const trailContent = lines.slice(lastEnd).join('\n')
		if (trailContent.trim().length > 0) {
			chunks.push(
				...splitIfNeeded(
					{
						id: `${filePath}:${lastEnd + 1}-${lines.length}`,
						filePath,
						startLine: lastEnd + 1,
						endLine: lines.length,
						content: trailContent,
					},
					maxChunkSize,
					filePath,
				),
			)
		}
	}

	return chunks
}

function chunkByLines(
	filePath: string,
	content: string,
	linesPerChunk: number,
	overlapLines: number,
	maxChunkSize: number,
): CodeChunk[] {
	const lines = content.split('\n')
	const chunks: CodeChunk[] = []
	let i = 0

	while (i < lines.length) {
		const end = Math.min(i + linesPerChunk, lines.length)
		const chunkContent = lines.slice(i, end).join('\n')

		if (chunkContent.trim().length > 0) {
			chunks.push(
				...splitIfNeeded(
					{
						id: `${filePath}:${i + 1}-${end}`,
						filePath,
						startLine: i + 1,
						endLine: end,
						content: chunkContent,
					},
					maxChunkSize,
					filePath,
				),
			)
		}

		const prevI = i
		i = end - overlapLines
		// Ensure forward progress: if overlap pushes i back to or before prevI, jump to end
		if (i <= prevI) i = end
	}

	return chunks
}

/**
 * Split a chunk that exceeds maxChunkSize into smaller parts.
 */
function splitIfNeeded(chunk: CodeChunk, maxChunkSize: number, filePath: string): CodeChunk[] {
	if (chunk.content.length <= maxChunkSize) return [chunk]

	const lines = chunk.content.split('\n')
	const parts: CodeChunk[] = []
	let start = 0

	while (start < lines.length) {
		let end = start
		let size = 0

		while (end < lines.length && size + lines[end].length + 1 <= maxChunkSize) {
			size += lines[end].length + 1
			end++
		}

		if (end === start) end = start + 1 // At least one line

		const partContent = lines.slice(start, end).join('\n')
		const globalStart = chunk.startLine + start
		const globalEnd = chunk.startLine + end - 1

		parts.push({
			id: `${filePath}:${globalStart}-${globalEnd}`,
			filePath,
			startLine: globalStart,
			endLine: globalEnd,
			content: partContent,
			symbolName: chunk.symbolName,
			symbolKind: chunk.symbolKind,
		})

		start = end
	}

	return parts
}

/**
 * Batch-chunk multiple files at once.
 */
export function chunkFiles(
	files: Array<{ filePath: string; content: string; symbols?: SymbolInfo[] }>,
	config: ChunkerConfig = {},
): CodeChunk[] {
	return files.flatMap(f => chunkFile(f.filePath, f.content, f.symbols, config))
}

// ---------------------------------------------------------------------
// Smart chunking — token-aware rollup (Etap 9l)
// ---------------------------------------------------------------------

export interface RollupConfig {
	/**
	 * Chunks smaller than this many tokens are candidates for merging
	 * with their neighbour. Default: 50.
	 */
	minChunkTokens?: number
	/**
	 * Upper bound after merging — we will stop growing a chunk once
	 * adding the next neighbour would exceed this. Default: 400.
	 */
	maxChunkTokens?: number
	/**
	 * Token estimator. Default uses `char/4` which is a reasonable
	 * proxy for BPE-style tokenizers (cl100k, o200k) on source code
	 * without pulling in a 5MB tokenizer table.
	 */
	estimateTokens?: (text: string) => number
}

/** `char/4` token estimate — cheap, dependency-free, accurate within ~10-15% for code. */
export function estimateTokensCharQuarter(text: string): number {
	return Math.ceil(text.length / 4)
}

/**
 * Rolls up small adjacent chunks **from the same file** into larger
 * merged chunks, preserving line contiguity. Improves embedding
 * quality by avoiding hundreds of tiny helper-function chunks that
 * dominate the index with near-identical content.
 *
 * Rules:
 *   1. Iterate chunks in original order; group by file.
 *   2. Merge a chunk with the previous merged group iff:
 *        • they are in the same file,
 *        • their line ranges are contiguous (prev.endLine + 1 == cur.startLine),
 *        • at least one of them is under `minChunkTokens`,
 *        • merging doesn't exceed `maxChunkTokens`.
 *   3. When symbols differ, the merged chunk drops `symbolName`/`symbolKind`
 *      because it no longer represents a single symbol.
 *
 * The input array is not mutated.
 */
export function rollupSmallChunks(chunks: CodeChunk[], config: RollupConfig = {}): CodeChunk[] {
	const minTok = config.minChunkTokens ?? 50
	const maxTok = config.maxChunkTokens ?? 400
	const estimate = config.estimateTokens ?? estimateTokensCharQuarter

	const out: CodeChunk[] = []
	for (const chunk of chunks) {
		const last = out.length > 0 ? out[out.length - 1] : null
		if (!last || last.filePath !== chunk.filePath) {
			out.push({ ...chunk })
			continue
		}
		const contiguous = last.endLine + 1 === chunk.startLine
		if (!contiguous) {
			out.push({ ...chunk })
			continue
		}
		const lastTok = estimate(last.content)
		const curTok = estimate(chunk.content)
		// Only consider merging when at least one side is tiny — otherwise
		// two medium chunks would glom into a single oversized one.
		if (lastTok >= minTok && curTok >= minTok) {
			out.push({ ...chunk })
			continue
		}
		// Would the merged chunk still fit under the cap?
		// (+1 for the joining newline)
		if (estimate(last.content) + estimate(chunk.content) + 1 > maxTok) {
			out.push({ ...chunk })
			continue
		}
		// Perform merge in place on `out[out.length-1]`.
		const mergedContent = last.content + '\n' + chunk.content
		const sameSymbol =
			last.symbolName !== undefined &&
			last.symbolName === chunk.symbolName &&
			last.symbolKind === chunk.symbolKind
		out[out.length - 1] = {
			// Preserve the first chunk's id prefix but expand the range for traceability.
			id: `${chunk.filePath}:${last.startLine}-${chunk.endLine}`,
			filePath: chunk.filePath,
			startLine: last.startLine,
			endLine: chunk.endLine,
			content: mergedContent,
			symbolName: sameSymbol ? last.symbolName : undefined,
			symbolKind: sameSymbol ? last.symbolKind : undefined,
		}
	}
	return out
}
