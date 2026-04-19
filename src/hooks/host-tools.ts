/**
 * Host-side tool interceptor — routes `grep` / `glob` tool calls through
 * ripgrep for a token-efficient, grouped output.
 *
 * Activation rules:
 *   - Session is NOT running in a sandbox (sandbox-tools.ts owns that case).
 *   - `rg` is available on PATH.
 *   - `config.host.fastGrep !== false` (default: true).
 *
 * When active, the `before` hook neutralises the builtin tool args (like
 * sandbox-tools does) and the `after` hook swaps in the ripgrep-rendered
 * output. When inactive, both hooks no-op and the builtin runs unchanged.
 */

import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'
import { getSandboxForSession } from '../sandbox/context'
import type { createLoopService } from '../services/loop'
import type { createSandboxManager } from '../sandbox/manager'
import { executeHostGlob, executeHostGrep, isRipgrepAvailable } from '../tools/host-fs'

interface HostToolHookDeps {
	loopService: ReturnType<typeof createLoopService>
	sandboxManager: ReturnType<typeof createSandboxManager> | null
	logger: Logger
	/** Working directory for rg invocations (plugin `directory`). */
	cwd: string
	/** User-facing feature flag; defaults to true. */
	enabled?: boolean
}

const pendingResults = new Map<string, { result: string; storedAt: number }>()
const STALE_THRESHOLD_MS = 5 * 60 * 1000

function shouldIntercept(deps: HostToolHookDeps, sessionID: string): boolean {
	if (deps.enabled === false) return false
	if (!isRipgrepAvailable()) return false
	// Sandbox interceptor takes precedence when a container is active.
	if (getSandboxForSession(deps, sessionID)) return false
	return true
}

export function createHostToolBeforeHook(deps: HostToolHookDeps): Hooks['tool.execute.before'] {
	return async (
		input: { tool: string; sessionID: string; callID: string },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
		output: { args: any },
	) => {
		if (input.tool !== 'grep' && input.tool !== 'glob') return
		if (!shouldIntercept(deps, input.sessionID)) return

		const args = output.args ?? {}

		try {
			if (input.tool === 'glob') {
				const result = executeHostGlob(String(args.pattern ?? ''), {
					path: args.path ? String(args.path) : undefined,
					cwd: deps.cwd,
				})
				if (result === null) return // rg disappeared mid-flight — fall through
				pendingResults.set(input.callID, { result, storedAt: Date.now() })
				// Neutralise builtin so its output can be safely replaced in `after`.
				output.args = { ...args, pattern: '__forge_host_fs_noop__' }
				return
			}

			// grep
			const result = executeHostGrep(String(args.pattern ?? ''), {
				path: args.path ? String(args.path) : undefined,
				include: args.include ? String(args.include) : undefined,
				cwd: deps.cwd,
			})
			if (result === null) return
			pendingResults.set(input.callID, { result, storedAt: Date.now() })
			output.args = { ...args, pattern: '__forge_host_fs_noop__' }
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			deps.logger.log(`[host-hook] ${input.tool} failed for callID ${input.callID}: ${message}`)
			pendingResults.set(input.callID, { result: `${input.tool} failed: ${message}`, storedAt: Date.now() })
			output.args = { ...args, pattern: '__forge_host_fs_noop__' }
		}
	}
}

export function createHostToolAfterHook(deps: HostToolHookDeps): Hooks['tool.execute.after'] {
	return async (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
		input: { tool: string; sessionID: string; callID: string; args: any },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches upstream Hooks type
		output: { title: string; output: string; metadata: any },
	) => {
		if (input.tool !== 'grep' && input.tool !== 'glob') return

		// Stale cleanup.
		const now = Date.now()
		for (const [key, entry] of pendingResults) {
			if (now - entry.storedAt > STALE_THRESHOLD_MS) pendingResults.delete(key)
		}

		const entry = pendingResults.get(input.callID)
		if (entry === undefined) return
		pendingResults.delete(input.callID)

		deps.logger.log(`[host-hook] replacing ${input.tool} output for callID ${input.callID}`)
		output.output = entry.result
	}
}

/** Test helper — clears pending results map. */
export function __clearHostToolPendingForTests(): void {
	pendingResults.clear()
}
