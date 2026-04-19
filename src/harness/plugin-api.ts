/**
 * Harness Plugin API — enables users to register custom detectors,
 * truncators, and snapshot providers as extensions to the built-in harness.
 *
 * Plugins are loaded from `config.harness.plugins` (array of module specifiers
 * that export a `HarnessPlugin` conformant object).
 */

import type { ForgeMessage } from './types'

// ────────────────────────────────────────────────────────────
// Core plugin interface
// ────────────────────────────────────────────────────────────

/**
 * A harness plugin can extend detection, truncation, and snapshot behaviours.
 *
 * All fields are optional — a plugin only needs to implement the parts it cares
 * about. The harness calls each hook in registration order.
 */
export interface HarnessPlugin {
	/** Unique name used for logging and diagnostics. */
	name: string

	/**
	 * Custom detectors run after built-in doom-loop + pending-todos detectors.
	 * Each detector is called per tool-call and can return a reminder string
	 * or null to skip.
	 */
	detectors?: HarnessDetector[]

	/**
	 * Custom truncators run after the built-in output truncation pass.
	 * They receive the tool output and can return a truncated version.
	 */
	truncators?: HarnessTruncator[]

	/**
	 * Custom snapshot providers are called before mutating tools execute.
	 * They can capture additional state beyond the built-in file backups.
	 */
	snapshots?: HarnessSnapshotProvider[]
}

// ────────────────────────────────────────────────────────────
// Extension points
// ────────────────────────────────────────────────────────────

/**
 * A detector examines the current session messages and/or tool signature
 * and can return an advisory message to inject into the conversation.
 */
export interface HarnessDetector {
	/** Name for logging. */
	name: string

	/**
	 * Called after each tool call. Return a non-empty string to inject a
	 * reminder / warning into the conversation, or null to skip.
	 *
	 * @param ctx - Detection context: current messages, tool name, session ID.
	 */
	detect(ctx: DetectionContext): Promise<string | null> | string | null
}

export interface DetectionContext {
	sessionId: string
	toolName: string
	toolArgsHash: string
	/** Recent messages in the session (last 20). */
	recentMessages: ForgeMessage[]
	/** Total tool calls so far in this session. */
	toolCallCount: number
}

/**
 * A truncator can transform tool output before it's injected into the
 * conversation. Truncators are chained: output flows from one to the next.
 */
export interface HarnessTruncator {
	/** Name for logging. */
	name: string

	/**
	 * Transform tool output. Return the (possibly truncated) string.
	 * Return `null` to pass through unchanged.
	 */
	truncate(ctx: TruncationContext): string | null
}

export interface TruncationContext {
	toolName: string
	output: string
	/** Suggested max length in characters (from config). */
	maxLength: number
}

/**
 * A snapshot provider captures state before a mutating tool runs.
 * The harness calls `capture()` before and can call `restore()` for undo.
 */
export interface HarnessSnapshotProvider {
	/** Name for logging. */
	name: string

	/**
	 * Capture a snapshot of the current state before a mutation.
	 * Returns an opaque handle that can be passed to `restore()`.
	 */
	capture(ctx: SnapshotContext): Promise<SnapshotHandle>

	/**
	 * Restore state from a previously captured snapshot handle.
	 */
	restore(handle: SnapshotHandle): Promise<void>
}

export interface SnapshotContext {
	sessionId: string
	toolName: string
	/** File path being mutated (if applicable). */
	filePath?: string
	/** Working directory. */
	cwd: string
}

export interface SnapshotHandle {
	provider: string
	/** Opaque data — only meaningful to the provider that created it. */
	data: unknown
}
