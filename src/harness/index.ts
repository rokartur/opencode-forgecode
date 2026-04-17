/**
 * Public surface of the forge harness module.
 *
 * Consumers (plugin entrypoint, hook factories, tools) should import from
 * this barrel rather than reaching into individual files.
 */

export * from './types'
export { render } from './templates'
export type { TemplateName } from './templates'
export { DoomLoopDetector, signatureOf } from './doom-loop'
export type { ToolSignature } from './doom-loop'
export { PendingTodosTracker } from './pending-todos'
export { truncateShell, truncateSearch, truncateFetch, truncateForTool } from './truncation'
export { dropRole, dedupeConsecutive, trimAssistant, stripWorkingDir, summaryTransform } from './transformers'
export { renderSummaryFrame, toForgeMessage } from './compactor'
export type { CompactOptions } from './compactor'
export {
	captureSnapshot,
	findSnapshots,
	restoreSnapshot,
	snapshotsRoot,
	sessionSnapshotsDir,
	fileTag,
	SNAPSHOTS_SUBDIR,
} from './snapshot'
export type { SnapshotEntry, SnapshotLocation } from './snapshot'
export { currentEnv, systemInfo, skillInstructions, toolErrorReflection } from './system-prompt'
