// Jupyter (.ipynb) and Svelte (.svelte) code extractors (Etap 9f).
//
// Rationale: we don't want to ship tree-sitter grammars for Jupyter
// JSON or Svelte component syntax — both are fragile in sandboxed
// environments and add build-time complexity. Instead we extract the
// **code-bearing regions** of these files and hand the result back as
// plain-language snippets the existing TS/Python pipeline already
// knows how to index.
//
// The outputs are **line-aligned** (`startLine` is the 1-indexed line
// of the first code line inside the original file). This lets the
// symbol extractor preserve navigation offsets.

export interface ExtractedBlock {
	/** Language the block should be parsed as (`typescript`, `python`, …). */
	language: string
	/** Source code without the wrapping syntax. */
	source: string
	/** 1-indexed start line inside the original file. */
	startLine: number
	/** 1-indexed end line inside the original file. */
	endLine: number
	/** Optional provenance hint, e.g. `script[lang=ts]` or `cell[3]`. */
	origin: string
}

// ---------------------------------------------------------------------
// Jupyter Notebook (.ipynb)
// ---------------------------------------------------------------------

interface JupyterCellShape {
	cell_type?: string
	source?: string | string[]
	metadata?: { language?: string; kernelspec?: { language?: string } }
}

interface JupyterNotebookShape {
	cells?: JupyterCellShape[]
	metadata?: { kernelspec?: { language?: string }; language_info?: { name?: string } }
}

/** Normalises either "foo\nbar\n" or ["foo\n", "bar\n"] into a single string. */
function normaliseSource(src: string | string[] | undefined): string {
	if (src === undefined) return ''
	if (typeof src === 'string') return src
	return src.join('')
}

/**
 * Extracts every `code`-typed cell from a Jupyter notebook. Cells are
 * concatenated with preserved inter-cell gaps so that code inside each
 * cell keeps its original line offsets.
 */
export function extractJupyterCells(raw: string, filename = 'notebook.ipynb'): ExtractedBlock[] {
	let parsed: JupyterNotebookShape
	try {
		parsed = JSON.parse(raw) as JupyterNotebookShape
	} catch (e) {
		throw new Error(`invalid notebook JSON (${filename}): ${(e as Error).message}`)
	}
	if (!parsed.cells || !Array.isArray(parsed.cells)) return []

	// Kernel language drives fallback when a cell lacks its own metadata.
	// `python` is the overwhelming default for `.ipynb`.
	const fallbackLang = parsed.metadata?.kernelspec?.language ?? parsed.metadata?.language_info?.name ?? 'python'

	const out: ExtractedBlock[] = []
	// Jupyter notebooks don't carry file-level line info; we synthesise
	// monotonically-increasing `startLine`s so downstream consumers still
	// produce unique navigation targets.
	let virtualLine = 1
	let cellIndex = 0
	for (const cell of parsed.cells) {
		cellIndex++
		if (cell.cell_type !== 'code') continue
		const source = normaliseSource(cell.source)
		if (source.trim().length === 0) {
			virtualLine += 1 // skip but keep offsets monotonic
			continue
		}
		const cellLang = cell.metadata?.language ?? cell.metadata?.kernelspec?.language ?? fallbackLang
		const lineCount = source.split('\n').length
		out.push({
			language: cellLang,
			source,
			startLine: virtualLine,
			endLine: virtualLine + lineCount - 1,
			origin: `cell[${cellIndex - 1}]`,
		})
		// Leave a one-line gap between cells for readability in flat concat.
		virtualLine += lineCount + 1
	}
	return out
}

// ---------------------------------------------------------------------
// Svelte (.svelte)
// ---------------------------------------------------------------------

/**
 * Extracts `<script>` blocks from a Svelte component. Supports both
 * the top-level `<script>` (component logic) and `<script context="module">`
 * (module-level code). `lang="ts"` / `lang="typescript"` selects TS;
 * default is JavaScript.
 *
 * The implementation is a deliberately small regex rather than an HTML
 * parser — Svelte templates don't nest `<script>` tags, so boundaries
 * are unambiguous; a full parser would be overkill.
 */
export function extractSvelteScripts(raw: string): ExtractedBlock[] {
	const out: ExtractedBlock[] = []
	// Non-greedy body capture so multiple script blocks are handled.
	const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi
	let match: RegExpExecArray | null
	while ((match = re.exec(raw)) !== null) {
		const attrs = match[1] ?? ''
		const body = match[2] ?? ''
		const scriptOpenIndex = match.index
		// Count newlines BEFORE the `<script ...>` tag to derive startLine.
		const preSlice = raw.slice(0, scriptOpenIndex)
		const openLine = preSlice.split('\n').length
		// Body starts on the line AFTER the opening tag if the tag ends
		// with a newline — otherwise same line. We advance 1 line to skip
		// the opening tag itself.
		const startLine = openLine + 1
		const bodyLines = body.split('\n').length
		const lang = /\blang\s*=\s*['"](ts|typescript)['"]/i.test(attrs) ? 'typescript' : 'javascript'
		const isModule = /\bcontext\s*=\s*['"]module['"]/i.test(attrs)
		out.push({
			language: lang,
			source: body,
			startLine,
			endLine: startLine + bodyLines - 1,
			origin: isModule ? 'script[context=module]' : `script[lang=${lang}]`,
		})
	}
	return out
}

/**
 * Dispatcher that picks the right extractor for a given filename.
 * Returns `null` if the file extension isn't one we handle — callers
 * then fall through to the existing tree-sitter pipeline.
 */
export function extractCodeBlocks(filename: string, raw: string): ExtractedBlock[] | null {
	const lower = filename.toLowerCase()
	if (lower.endsWith('.ipynb')) return extractJupyterCells(raw, filename)
	if (lower.endsWith('.svelte')) return extractSvelteScripts(raw)
	return null
}
