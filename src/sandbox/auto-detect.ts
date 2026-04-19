/**
 * Auto-detect the best available sandbox backend for the current platform.
 *
 * Priority:
 *   macOS → sandbox-exec (built-in) → docker → off
 *   Linux → bubblewrap → firejail → docker → off
 */

import { platform } from 'os'
import type { SandboxBackend } from './backend'
import { createSandboxExecBackend } from './sandbox-exec'
import { createBubblewrapBackend } from './bubblewrap'
import { createFirejailBackend } from './firejail'
import type { Logger } from '../types'

export type SandboxMode = 'off' | 'docker' | 'sandbox-exec' | 'bubblewrap' | 'auto'

export interface AutoDetectResult {
	/** Resolved backend (null = off). */
	backend: SandboxBackend | null
	/** The mode that was resolved to. */
	resolvedMode: string
	/** Human-readable reason for the resolution. */
	reason: string
}

/**
 * Resolve the `auto` sandbox mode to a concrete backend.
 * For explicit modes other than `auto`, validates availability.
 */
export async function resolveSandboxBackend(mode: SandboxMode, logger: Logger): Promise<AutoDetectResult> {
	if (mode === 'off') {
		return { backend: null, resolvedMode: 'off', reason: 'Sandboxing disabled by config.' }
	}

	if (mode === 'sandbox-exec') {
		const be = createSandboxExecBackend()
		if (await be.isAvailable()) {
			return { backend: be, resolvedMode: 'sandbox-exec', reason: 'macOS sandbox-exec available.' }
		}
		logger.log('[sandbox] sandbox-exec requested but not available (macOS only).')
		return { backend: null, resolvedMode: 'off', reason: 'sandbox-exec not available on this platform.' }
	}

	if (mode === 'bubblewrap') {
		const be = createBubblewrapBackend()
		if (await be.isAvailable()) {
			return { backend: be, resolvedMode: 'bubblewrap', reason: 'Bubblewrap (bwrap) available.' }
		}
		logger.log('[sandbox] bubblewrap requested but not available.')
		return { backend: null, resolvedMode: 'off', reason: 'bubblewrap (bwrap) not found.' }
	}

	if (mode === 'docker') {
		// Docker is handled by the existing SandboxManager, not through SandboxBackend
		return { backend: null, resolvedMode: 'docker', reason: 'Docker mode — handled by SandboxManager.' }
	}

	// auto mode
	const os = platform()

	if (os === 'darwin') {
		const sbExec = createSandboxExecBackend()
		if (await sbExec.isAvailable()) {
			logger.log('[sandbox] auto: resolved to sandbox-exec (macOS)')
			return { backend: sbExec, resolvedMode: 'sandbox-exec', reason: 'Auto: macOS sandbox-exec detected.' }
		}
	}

	if (os === 'linux') {
		const bwrap = createBubblewrapBackend()
		if (await bwrap.isAvailable()) {
			logger.log('[sandbox] auto: resolved to bubblewrap (Linux)')
			return { backend: bwrap, resolvedMode: 'bubblewrap', reason: 'Auto: bubblewrap detected.' }
		}

		const fj = createFirejailBackend()
		if (await fj.isAvailable()) {
			logger.log('[sandbox] auto: resolved to firejail (Linux)')
			return { backend: fj, resolvedMode: 'firejail', reason: 'Auto: firejail detected.' }
		}
	}

	// Fallback: docker check is delegated to existing SandboxManager.
	// If Docker is available, use it; otherwise off.
	logger.log('[sandbox] auto: no native sandbox available, falling back to docker/off.')
	return { backend: null, resolvedMode: 'docker', reason: 'Auto: falling back to Docker.' }
}
