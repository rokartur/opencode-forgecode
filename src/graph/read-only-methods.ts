/**
 * RPC methods on the graph worker that do NOT mutate persistent state.
 *
 * Used by:
 *   - Phase 4 failover: read-only calls may be retried exactly once after
 *     the transport reconnects. Write calls instead surface a
 *     `LeaderLostError` so the caller can decide its own policy.
 *   - Phase 5 read-only fast path: followers route these directly to a
 *     local read-only SQLite handle instead of hopping through the leader.
 *
 * Keep this list in sync with handler registration in `worker.ts`.
 */
export const READ_ONLY_METHODS: ReadonlySet<string> = new Set([
	'getStats',
	'getTopFiles',
	'getFileDependents',
	'getFileDependencies',
	'getFileCoChanges',
	'getFileBlastRadius',
	'getFileSymbols',
	'findSymbols',
	'searchSymbolsFts',
	'getSymbolSignature',
	'getCallers',
	'getCallees',
	'getUnusedExports',
	'getDuplicateStructures',
	'getNearDuplicates',
	'getExternalPackages',
	'getOrphanFiles',
	'getCircularDependencies',
	'getChangeImpact',
	'getSymbolReferences',
	'getSymbolBlastRadius',
	'getCallGraphCycles',
	'render',
])

export function isReadOnlyMethod(method: string): boolean {
	return READ_ONLY_METHODS.has(method)
}
