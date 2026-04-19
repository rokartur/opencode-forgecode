// Graph exporters — GraphML, Mermaid, Cypher (Etap 9e).
//
// All three exporters operate on the same in-memory projection
// (`ExportNode[]` + `ExportEdge[]`). Callers assemble that projection
// however they like — e.g. from the full `files`+`edges` tables, or
// from a `traverse()` subset (Etap 9c) with `--root X --depth N`.
//
// The exporters themselves are pure string-producers: no fs, no DB.

export interface ExportNode {
	/** Stable node id. For file-level graphs, use the file path. */
	id: string
	/** Optional display label; falls back to `id`. */
	label?: string
	/** Optional extra attributes; GraphML emits as `<data>` keys. */
	attributes?: Record<string, string | number | boolean>
}

export interface ExportEdge {
	from: string
	to: string
	/** Optional edge weight; default 1. */
	weight?: number
	/** Optional extra attributes. */
	attributes?: Record<string, string | number | boolean>
}

export interface ExportGraph {
	nodes: ExportNode[]
	edges: ExportEdge[]
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

/** Escapes a string for safe inclusion as XML character data. */
function xmlEscape(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;')
}

/**
 * Sanitises an id for use as a Mermaid/Cypher identifier.
 * Replaces any non-alphanumeric char with `_` and prefixes `n_` if the
 * first character is a digit (Mermaid/Cypher require letter-prefix).
 */
function sanitiseId(id: string): string {
	let s = id.replace(/[^A-Za-z0-9_]/g, '_')
	if (s.length === 0 || /^[0-9]/.test(s)) s = `n_${s}`
	return s
}

/** Escapes a string for a Mermaid label (quoted form). */
function mermaidLabel(s: string): string {
	// Double-quote wrapper + escape `"` and newlines.
	return `"${s.replace(/"/g, '#quot;').replace(/\n/g, ' ')}"`
}

/** Escapes a string for a Cypher string literal (single-quoted). */
function cypherString(s: string): string {
	return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

// ---------------------------------------------------------------------
// GraphML (yEd / Gephi / Cytoscape compatible)
// ---------------------------------------------------------------------

/**
 * Emits a standards-compliant GraphML document. Attribute keys are
 * auto-declared from the union of `attributes` seen on nodes and edges.
 */
export function toGraphML(graph: ExportGraph): string {
	const nodeKeys = new Map<string, 'string' | 'double' | 'int' | 'boolean'>()
	const edgeKeys = new Map<string, 'string' | 'double' | 'int' | 'boolean'>()

	const learnKeys = (
		map: Map<string, 'string' | 'double' | 'int' | 'boolean'>,
		attrs?: Record<string, string | number | boolean>,
	) => {
		if (!attrs) return
		for (const [k, v] of Object.entries(attrs)) {
			const t = typeof v === 'number' ? 'double' : typeof v === 'boolean' ? 'boolean' : 'string'
			const prev = map.get(k)
			// Upgrade narrow → string if conflicting types appear.
			if (prev && prev !== t) map.set(k, 'string')
			else if (!prev) map.set(k, t)
		}
	}
	for (const n of graph.nodes) learnKeys(nodeKeys, n.attributes)
	for (const e of graph.edges) learnKeys(edgeKeys, e.attributes)
	// `label` and `weight` are first-class in yEd/Gephi → add as keys.
	if (!nodeKeys.has('label')) nodeKeys.set('label', 'string')
	if (!edgeKeys.has('weight')) edgeKeys.set('weight', 'double')

	const lines: string[] = []
	lines.push('<?xml version="1.0" encoding="UTF-8"?>')
	lines.push(
		'<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.1/graphml.xsd">',
	)
	for (const [k, t] of nodeKeys) {
		lines.push(`  <key id="n_${xmlEscape(k)}" for="node" attr.name="${xmlEscape(k)}" attr.type="${t}" />`)
	}
	for (const [k, t] of edgeKeys) {
		lines.push(`  <key id="e_${xmlEscape(k)}" for="edge" attr.name="${xmlEscape(k)}" attr.type="${t}" />`)
	}
	lines.push('  <graph id="G" edgedefault="directed">')
	for (const n of graph.nodes) {
		lines.push(`    <node id="${xmlEscape(n.id)}">`)
		lines.push(`      <data key="n_label">${xmlEscape(n.label ?? n.id)}</data>`)
		if (n.attributes) {
			for (const [k, v] of Object.entries(n.attributes)) {
				if (k === 'label') continue
				lines.push(`      <data key="n_${xmlEscape(k)}">${xmlEscape(String(v))}</data>`)
			}
		}
		lines.push('    </node>')
	}
	for (let i = 0; i < graph.edges.length; i++) {
		const e = graph.edges[i]
		lines.push(`    <edge id="e${i}" source="${xmlEscape(e.from)}" target="${xmlEscape(e.to)}">`)
		lines.push(`      <data key="e_weight">${e.weight ?? 1}</data>`)
		if (e.attributes) {
			for (const [k, v] of Object.entries(e.attributes)) {
				if (k === 'weight') continue
				lines.push(`      <data key="e_${xmlEscape(k)}">${xmlEscape(String(v))}</data>`)
			}
		}
		lines.push('    </edge>')
	}
	lines.push('  </graph>')
	lines.push('</graphml>')
	return lines.join('\n')
}

// ---------------------------------------------------------------------
// Mermaid (flowchart LR)
// ---------------------------------------------------------------------

/**
 * Emits a Mermaid `flowchart LR` block. Ids are sanitised for Mermaid's
 * identifier grammar; original ids are preserved as node labels.
 */
export function toMermaid(graph: ExportGraph, opts: { direction?: 'LR' | 'TD' } = {}): string {
	const direction = opts.direction ?? 'LR'
	const lines: string[] = [`flowchart ${direction}`]
	// Collision-safe sanitised id → original id mapping.
	const idMap = new Map<string, string>()
	const usedSanitised = new Set<string>()
	for (const n of graph.nodes) {
		let sid = sanitiseId(n.id)
		// Disambiguate if sanitise collapses two distinct ids.
		let suffix = 1
		while (usedSanitised.has(sid) && idMap.get(sid) !== n.id) {
			sid = `${sanitiseId(n.id)}_${suffix++}`
		}
		usedSanitised.add(sid)
		idMap.set(n.id, sid)
		lines.push(`  ${sid}[${mermaidLabel(n.label ?? n.id)}]`)
	}
	for (const e of graph.edges) {
		const from = idMap.get(e.from) ?? sanitiseId(e.from)
		const to = idMap.get(e.to) ?? sanitiseId(e.to)
		if (e.weight !== undefined && e.weight !== 1) {
			lines.push(`  ${from} -->|${e.weight}| ${to}`)
		} else {
			lines.push(`  ${from} --> ${to}`)
		}
	}
	return lines.join('\n')
}

// ---------------------------------------------------------------------
// Cypher (Neo4j-style CREATE statements)
// ---------------------------------------------------------------------

/**
 * Emits a Cypher script that creates every node + edge in the graph.
 * Node labels default to `File`; edge relationship type to `IMPORTS`.
 * Both can be overridden via `opts`.
 */
export function toCypher(graph: ExportGraph, opts: { nodeLabel?: string; relationshipType?: string } = {}): string {
	const nodeLabel = opts.nodeLabel ?? 'File'
	const relType = opts.relationshipType ?? 'IMPORTS'
	const lines: string[] = []

	// Use MERGE so re-importing is idempotent.
	for (const n of graph.nodes) {
		const props: string[] = [`path: ${cypherString(n.id)}`]
		if (n.label && n.label !== n.id) props.push(`label: ${cypherString(n.label)}`)
		if (n.attributes) {
			for (const [k, v] of Object.entries(n.attributes)) {
				props.push(
					`${sanitiseId(k)}: ${typeof v === 'number' || typeof v === 'boolean' ? String(v) : cypherString(String(v))}`,
				)
			}
		}
		lines.push(`MERGE (:${nodeLabel} { ${props.join(', ')} });`)
	}
	for (const e of graph.edges) {
		const weight = e.weight ?? 1
		const props: string[] = [`weight: ${weight}`]
		if (e.attributes) {
			for (const [k, v] of Object.entries(e.attributes)) {
				if (k === 'weight') continue
				props.push(
					`${sanitiseId(k)}: ${typeof v === 'number' || typeof v === 'boolean' ? String(v) : cypherString(String(v))}`,
				)
			}
		}
		lines.push(
			`MATCH (a:${nodeLabel} { path: ${cypherString(e.from)} }), (b:${nodeLabel} { path: ${cypherString(e.to)} }) MERGE (a)-[:${relType} { ${props.join(', ')} }]->(b);`,
		)
	}
	return lines.join('\n')
}
