/** Languages supported by tree-sitter backend */
export type Language =
	| 'typescript'
	| 'javascript'
	| 'python'
	| 'go'
	| 'rust'
	| 'java'
	| 'c'
	| 'cpp'
	| 'csharp'
	| 'ruby'
	| 'php'
	| 'swift'
	| 'kotlin'
	| 'scala'
	| 'lua'
	| 'elixir'
	| 'dart'
	| 'zig'
	| 'bash'
	| 'ocaml'
	| 'objc'
	| 'css'
	| 'html'
	| 'json'
	| 'toml'
	| 'yaml'
	| 'dockerfile'
	| 'vue'
	| 'rescript'
	| 'solidity'
	| 'tlaplus'
	| 'elisp'
	| 'unknown'

/** Mapping from file extension to language */
export const EXT_TO_LANGUAGE: Record<string, Language> = {
	// TypeScript
	'.ts': 'typescript',
	'.tsx': 'typescript',
	'.mts': 'typescript',
	'.cts': 'typescript',
	// JavaScript
	'.js': 'javascript',
	'.jsx': 'javascript',
	'.mjs': 'javascript',
	'.cjs': 'javascript',
	// Python
	'.py': 'python',
	'.pyw': 'python',
	// Go
	'.go': 'go',
	// Rust
	'.rs': 'rust',
	// Java
	'.java': 'java',
	// C
	'.c': 'c',
	'.h': 'c',
	// C++
	'.cpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.hpp': 'cpp',
	'.hh': 'cpp',
	'.hxx': 'cpp',
	// C#
	'.cs': 'csharp',
	// Ruby
	'.rb': 'ruby',
	'.erb': 'ruby',
	// PHP
	'.php': 'php',
	// Swift
	'.swift': 'swift',
	// Kotlin
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	// Scala
	'.scala': 'scala',
	'.sc': 'scala',
	// Lua
	'.lua': 'lua',
	// Elixir
	'.ex': 'elixir',
	'.exs': 'elixir',
	// Dart
	'.dart': 'dart',
	// Zig
	'.zig': 'zig',
	// Shell
	'.sh': 'bash',
	'.bash': 'bash',
	'.zsh': 'bash',
	// OCaml
	'.ml': 'ocaml',
	'.mli': 'ocaml',
	// Objective-C
	'.m': 'objc',
	// CSS
	'.css': 'css',
	'.scss': 'css',
	'.less': 'css',
	// HTML
	'.html': 'html',
	'.htm': 'html',
	// JSON
	'.json': 'json',
	'.jsonc': 'json',
	// TOML
	'.toml': 'toml',
	// YAML
	'.yaml': 'yaml',
	'.yml': 'yaml',
	// Dockerfile
	'.dockerfile': 'dockerfile',
	// Vue
	'.vue': 'vue',
	// ReScript
	'.res': 'rescript',
	'.resi': 'rescript',
	// Solidity
	'.sol': 'solidity',
	// TLA+
	'.tla': 'tlaplus',
	// Emacs Lisp
	'.el': 'elisp',
}

/** Detect language from a file path */
export function detectLanguageFromPath(file: string): Language {
	const dot = file.lastIndexOf('.')
	if (dot === -1) {
		const name = file.slice(file.lastIndexOf('/') + 1)
		if (name === 'Dockerfile' || name.startsWith('Dockerfile.')) return 'dockerfile'
		return 'unknown'
	}
	return EXT_TO_LANGUAGE[file.slice(dot).toLowerCase()] ?? 'unknown'
}

/** Symbol kinds for classification */
export type SymbolKind =
	| 'function'
	| 'method'
	| 'class'
	| 'interface'
	| 'type'
	| 'variable'
	| 'constant'
	| 'enum'
	| 'property'
	| 'module'
	| 'namespace'
	| 'unknown'

/** A location in source code */
export interface SourceLocation {
	file: string
	line: number
	column: number
	endLine?: number
	endColumn?: number
}

/** A symbol found in source code */
export interface SymbolInfo {
	name: string
	kind: SymbolKind
	location: SourceLocation
	containerName?: string
}

/** Import information */
export interface ImportInfo {
	source: string
	specifiers: string[]
	isDefault: boolean
	isNamespace: boolean
	location: SourceLocation
}

/** Export information */
export interface ExportInfo {
	name: string
	isDefault: boolean
	kind: SymbolKind
	location: SourceLocation
}

/** File outline — top-level structure */
export interface FileOutline {
	file: string
	language: Language
	symbols: SymbolInfo[]
	imports: ImportInfo[]
	exports: ExportInfo[]
}

/** Database file record */
export interface DbFile {
	id: number
	path: string
	mtime_ms: number
	language: string
	line_count: number
	symbol_count: number
	pagerank: number
	is_barrel: boolean
}

/** Database symbol record */
export interface DbSymbol {
	id: number
	file_id: number
	name: string
	kind: string
	line: number
	end_line: number
	is_exported: boolean
	signature?: string
	qualified_name?: string
}

/** Graph statistics */
export interface GraphStats {
	files: number
	symbols: number
	edges: number
	summaries: number
	calls: number
}

/** Top file result */
export interface TopFileResult {
	path: string
	pagerank: number
	lines: number
	symbols: number
	language: string
}

/** File dependents/dependencies result */
export interface FileDepResult {
	path: string
	weight: number
}

/** File co-changes result */
export interface FileCoChangeResult {
	path: string
	count: number
}

/** File symbols result */
export interface FileSymbolResult {
	name: string
	kind: string
	isExported: boolean
	line: number
	endLine: number
}

/** Symbol search result */
export interface SymbolSearchResult {
	name: string
	path: string
	kind: string
	line: number
	isExported: boolean
	pagerank: number
	id?: number
}

/** Symbol signature result */
export interface SymbolSignatureResult {
	path: string
	kind: string
	signature: string
	line: number
}

/** Caller result */
export interface CallerResult {
	callerName: string
	callerPath: string
	callerLine: number
	callLine: number
	/** Confidence score (0..1) from edge extraction; 1.0 = direct symbol resolved. */
	confidence: number
	/** Tier of the underlying edge; see `EdgeConfidenceTier`. */
	tier: EdgeConfidenceTier
}

/** Callee result */
export interface CalleeResult {
	calleeName: string
	calleeFile: string
	calleeLine: number
	callLine: number
	confidence: number
	tier: EdgeConfidenceTier
}

/**
 * Confidence classification for a call edge.
 *
 * - `EXTRACTED` (1.0): callee symbol resolved to a concrete exported definition.
 * - `INFERRED` (0.7): import points to a file but the target symbol could not
 *   be located (e.g., re-export chain, missing export, partial scan).
 * - `AMBIGUOUS` (0.4): reserved for future member-call detection
 *   (`this.foo()` / `obj.foo()`) where receiver type is unknown.
 */
export type EdgeConfidenceTier = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'

export const EDGE_CONFIDENCE_SCORES: Record<EdgeConfidenceTier, number> = {
	EXTRACTED: 1.0,
	INFERRED: 0.7,
	AMBIGUOUS: 0.4,
}

/** Unused export result */
export interface UnusedExportResult {
	name: string
	path: string
	kind: string
	line: number
	endLine: number
	lineCount: number
	usedInternally: boolean
}

/** Duplicate structure result */
export interface DuplicateStructureResult {
	shapeHash: string
	kind: string
	nodeCount: number
	members: Array<{ path: string; line: number }>
}

/** Near duplicate result */
export interface NearDuplicateResult {
	similarity: number
	a: { path: string; line: number; name: string }
	b: { path: string; line: number; name: string }
}

/** External package result */
export interface ExternalPackageResult {
	package: string
	fileCount: number
	specifiers: string[]
}

/** Scan preparation result */
export interface PrepareScanResult {
	totalFiles: number
	batchSize: number
}

/** Scan batch result */
export interface ScanBatchResult {
	processed: number
	completed: boolean
	nextOffset: number
	totalFiles: number
	/** Wall-clock time spent processing this batch, in ms. Used by the service
	 * layer to adapt the batch size for subsequent calls. */
	elapsedMs?: number
	/** Files skipped in this batch because indexing exceeded the per-file
	 * timeout. Aggregated across the whole scan by the service layer. */
	skippedTimeouts?: number
}

/** Orphan file result — files with no incoming edges (nobody imports them) */
export interface OrphanFileResult {
	path: string
	language: string
	lineCount: number
	symbolCount: number
}

/** Circular dependency result — a cycle in the file dependency graph */
export interface CircularDependencyResult {
	cycle: string[]
	length: number
}

/** A file impacted by a set of changes */
export interface ImpactedFile {
	path: string
	depth: number
}

/** Multi-file change impact analysis result */
export interface ChangeImpactResult {
	changedFiles: string[]
	impactedFiles: ImpactedFile[]
	totalAffected: number
}

/** Symbol reference result — where a symbol is used across the codebase */
export interface SymbolReferenceResult {
	kind: 'import' | 'call' | 'reexport'
	path: string
	line: number
	context?: string
}

/** Symbol-level blast radius result — symbols transitively affected by a change */
export interface SymbolBlastRadiusResult {
	/** The root symbol that was queried */
	root: { name: string; path: string; line: number }
	/** Symbols transitively affected through call edges */
	affected: Array<{ name: string; path: string; line: number; depth: number }>
	/** Total number of affected symbols (excluding root) */
	totalAffected: number
}

/** A cycle detected in the call graph (symbol-level) */
export interface CallGraphCycleResult {
	/** Ordered list of symbol names forming the cycle (last calls first) */
	cycle: Array<{ name: string; path: string; line: number }>
	/** Length of the cycle */
	length: number
}

/** Direction of graph traversal over call edges. */
export type TraverseDirection = 'in' | 'out' | 'both'

/** Options for `graphService.traverse`. */
export interface TraverseOptions {
	/** Absolute or repo-relative file path of the starting symbol. */
	path: string
	/** Line number of the starting symbol definition. */
	line: number
	/** `in` = callers, `out` = callees, `both` = union. Default `out`. */
	direction?: TraverseDirection
	/** Maximum BFS depth (hops). Default 3. */
	maxDepth?: number
	/** Stop expanding once cumulative size (chars of name+path) exceeds this. */
	maxTokens?: number
	/** Only follow edges with `confidence >= minConfidence`. Default 0. */
	minConfidence?: number
	/** Soft cap on total nodes returned; pruning is BFS-order-stable. Default 500. */
	maxNodes?: number
}

/** One node visited by `traverse`. */
export interface TraverseNode {
	name: string
	path: string
	line: number
	/** Distance in hops from the start symbol. 0 = start. */
	depth: number
	/** Lowest-confidence edge walked to reach this node. `null` for start. */
	edgeConfidence: number | null
	/** Tier of the edge walked to reach this node. `null` for start. */
	edgeTier: EdgeConfidenceTier | null
}

/** Result of `graphService.traverse`. */
export interface TraverseResult {
	root: { name: string; path: string; line: number }
	nodes: TraverseNode[]
	/** `true` if traversal was stopped early due to budget/depth/nodes caps. */
	truncated: boolean
	/** Short human-readable reason for early stop, if any. */
	stopReason?: 'maxDepth' | 'maxTokens' | 'maxNodes'
}

/**
 * Lightweight JSON snapshot of graph-level counts + content hashes.
 *
 * Intentionally small (O(files + symbols)) so it's easy to diff across
 * commits and commit as a PR artefact. We avoid embedding full AST.
 */
export interface GraphSnapshot {
	/** Format version; bumped on breaking schema changes. */
	version: 1
	label: string
	createdAt: number
	stats: {
		files: number
		symbols: number
		calls: number
	}
	/** Per-file rollup keyed by relative path. */
	files: Record<
		string,
		{
			language: string
			symbolCount: number
			pagerank: number
			/** SHA-256 of `symbolName:line|symbolName:line|...` (stable sorted). */
			symbolsHash: string
		}
	>
	/** Top-N symbols by PageRank for quick sanity checks. */
	topSymbols: Array<{ name: string; path: string; pagerank: number }>
}

/** Result of comparing two `GraphSnapshot`s. */
export interface GraphSnapshotDiff {
	labelA: string
	labelB: string
	files: {
		added: string[]
		removed: string[]
		/** Files present in both snapshots whose `symbolsHash` changed. */
		changed: string[]
	}
	stats: {
		filesDelta: number
		symbolsDelta: number
		callsDelta: number
	}
	/** Top symbols whose rank or presence changed the most. */
	topSymbolsDelta: Array<{
		name: string
		path: string
		pagerankA: number | null
		pagerankB: number | null
		delta: number
	}>
}

/**
 * A detected community (cluster) of files that import each other densely.
 *
 * Computed over the file-level `edges` graph via Label Propagation
 * (synchronous, deterministic variant). Communities are ordered by size
 * descending; `id` is an opaque small integer stable within one call.
 */
export interface CommunityResult {
	id: number
	size: number
	/** File paths belonging to this community. */
	files: string[]
	/** Total weight of edges fully contained in this community. */
	internalWeight: number
	/** Total weight of edges crossing out of this community. */
	externalWeight: number
}

/**
 * A bridge edge — removing it would disconnect the import graph.
 *
 * Computed via Tarjan's bridge-finding on the undirected projection
 * of the `edges` table. High coupling risk: refactoring `from` tends
 * to cascade to `to` because there is no alternative route.
 */
export interface BridgeEdgeResult {
	from: string
	to: string
	weight: number
}

/**
 * A "surprise" edge — a low-weight edge that crosses community
 * boundaries. Typically a one-off import between otherwise unrelated
 * subsystems and a strong candidate for an architectural review.
 */
export interface SurpriseEdgeResult {
	from: string
	to: string
	weight: number
	communityFrom: number
	communityTo: number
}

/**
 * A single discovered execution flow — an entry-point symbol plus the
 * chain of calls reachable from it, ordered by traversal depth.
 *
 * "Entry points" are heuristically detected (HTTP handlers, `main`,
 * test files, exported CLI commands). Flows are weighted by the
 * entry-point's PageRank and capped by `maxDepth`.
 */
export interface ExecutionFlow {
	/** Entry-point symbol name (e.g. `handleRequest`, `main`). */
	entryName: string
	entryPath: string
	entryLine: number
	/** Heuristic kind that caused this symbol to be picked as an entry. */
	entryKind: 'main' | 'test' | 'handler' | 'export'
	/** PageRank of the entry-point's file — flows are sorted by this desc. */
	weight: number
	/** Ordered call chain `(depth, name, path, line)`. `depth=0` is the entry itself. */
	steps: Array<{ depth: number; name: string; path: string; line: number }>
	/** `true` if traversal was cut off by `maxDepth`. */
	truncated: boolean
}

/**
 * A "knowledge gap" — a high-PageRank symbol that is NOT covered by
 * any test file. Heuristic: PageRank of the symbol's file is at or
 * above the p90 cutoff AND no test file transitively calls the symbol.
 */
export interface KnowledgeGapResult {
	name: string
	path: string
	line: number
	pagerank: number
	/** Number of non-test callers — high values mean the gap is load-bearing. */
	nonTestCallers: number
}
