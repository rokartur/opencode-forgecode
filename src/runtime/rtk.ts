/**
 * RTK (Rust Token Killer) installer + PATH detection.
 *
 * RTK is a token-optimized shell command proxy. See
 * https://github.com/rtk-ai/rtk for details.
 *
 * This module:
 *   1. Detects whether `rtk` is on PATH.
 *   2. Optionally runs the upstream install script
 *      (`curl -fsSL <install.sh> | sh`) when missing.
 *   3. Provides a short instruction block that can be injected into
 *      agent sessions so they know to prefix shell commands with `rtk`.
 *
 * The installer runs at most once per process and is safe to call from
 * plugin init — it returns immediately if RTK is already present or if
 * auto-install is disabled. Network/subprocess failures are logged and
 * swallowed so a missing RTK never blocks startup.
 */

import { existsSync } from 'fs'
import { join } from 'path'
import { spawn, spawnSync } from 'child_process'
import type { Logger, RtkConfig } from '../types'

const DEFAULT_INSTALL_URL = 'https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh'

/**
 * Common install locations for the `rtk` binary. Checked when `which rtk`
 * fails (e.g. the Node / extension-host process inherited a minimal PATH
 * that doesn't include the user's shell profile additions).
 */
const COMMON_RTK_PATHS: string[] = (() => {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ''
	if (!home) return []
	return [
		join(home, '.local', 'bin', 'rtk'),
		join(home, '.rtk', 'bin', 'rtk'),
		join(home, '.cargo', 'bin', 'rtk'),
		'/usr/local/bin/rtk',
	]
})()

/**
 * Resolve the absolute path to the `rtk` binary. Returns `null` when the
 * binary cannot be found either on PATH or in common install locations.
 */
export function resolveRtkPath(): string | null {
	// 1. Try PATH first (covers the happy path).
	const whichCommand = process.platform === 'win32' ? 'where' : 'which'
	const result = spawnSync(whichCommand, ['rtk'], {
		stdio: ['ignore', 'pipe', 'ignore'],
		timeout: 3_000,
	})
	if (result.status === 0 && result.stdout) {
		const resolved = result.stdout.toString().trim().split('\n')[0]
		if (resolved) return resolved
	}

	// 2. Fallback — check common install directories.
	for (const candidate of COMMON_RTK_PATHS) {
		if (existsSync(candidate)) return candidate
	}

	return null
}

/** Cached resolved path (computed once per process). */
let _cachedRtkPath: string | null | undefined

/** Get the resolved rtk path, caching the result. */
function getCachedRtkPath(): string | null {
	if (_cachedRtkPath === undefined) {
		_cachedRtkPath = resolveRtkPath()
	}
	return _cachedRtkPath
}

/** Invalidate the cached rtk path (e.g. after install). */
export function invalidateRtkPathCache(): void {
	_cachedRtkPath = undefined
}

/** Whether `rtk` binary is reachable on PATH or in common install locations. */
export function isRtkInstalled(): boolean {
	return getCachedRtkPath() !== null
}

/**
 * Short instruction snippet injected into agent sessions.
 *
 * IMPORTANT: Wrapped in <system-reminder> tags so the model treats it as a
 * tool-use directive and NOT as project content to analyse. Without this
 * framing the model would summarise / analyse RTK itself when the user
 * asks for a project analysis.
 */
export const RTK_INSTRUCTION_BLOCK = `<system-reminder>
[Shell tool directive — this is NOT part of the user's project. Do not analyse, summarise, or reference RTK in project descriptions.]
Always prefix shell commands with \`rtk\` (token-optimized CLI proxy).
Examples: \`rtk git status\`, \`rtk cargo test\`, \`rtk npm run build\`, \`rtk pytest -q\`.
Use \`rtk proxy <cmd>\` to bypass filtering. Use \`rtk gain\` for token-savings stats.
</system-reminder>
`

/**
 * Build the RTK instruction block with optional PATH-setup hint.
 * When the binary was found outside of PATH, the instruction tells
 * the agent to export the parent directory so subsequent commands work.
 */
export function buildRtkInstructionBlock(): string {
	const rtkPath = getCachedRtkPath()
	if (!rtkPath) return RTK_INSTRUCTION_BLOCK

	// Check whether the resolved path is already on PATH.
	const whichCommand = process.platform === 'win32' ? 'where' : 'which'
	const onPath = spawnSync(whichCommand, ['rtk'], { stdio: 'ignore', timeout: 3_000 })
	if (onPath.status === 0) return RTK_INSTRUCTION_BLOCK

	// Not on PATH — prepend a setup preamble with the discovered directory.
	const rtkDir = rtkPath.replace(/\/rtk$/, '')
	return `<system-reminder>
[Shell tool directive — this is NOT part of the user's project. Do not analyse, summarise, or reference RTK in project descriptions.]
\`rtk\` is installed at \`${rtkPath}\` but may not be on PATH. Run once per shell: \`export PATH="${rtkDir}:$PATH"\`
Always prefix shell commands with \`rtk\` (or use full path \`${rtkPath}\`).
Examples: \`rtk git status\`, \`rtk cargo test\`, \`rtk npm run build\`, \`rtk pytest -q\`.
Use \`rtk proxy <cmd>\` to bypass filtering. Use \`rtk gain\` for token-savings stats.
</system-reminder>
`
}

/** Resolve final RTK config with defaults applied. */
export function resolveRtkConfig(
	config?: RtkConfig,
): Required<Pick<RtkConfig, 'enabled' | 'autoInstall' | 'installUrl'>> {
	return {
		enabled: config?.enabled ?? true,
		autoInstall: config?.autoInstall ?? true,
		installUrl: config?.installUrl ?? DEFAULT_INSTALL_URL,
	}
}

/**
 * Ensure RTK is available. If missing and auto-install is enabled, run
 * `curl -fsSL <url> | sh` in a detached child process. Never throws.
 *
 * Returns a promise that resolves with the final install state.
 */
export async function ensureRtkInstalled(
	logger: Logger,
	config?: RtkConfig,
): Promise<{
	installed: boolean
	skipped: boolean
	reason?: string
}> {
	const resolved = resolveRtkConfig(config)

	if (!resolved.enabled) {
		return { installed: false, skipped: true, reason: 'disabled' }
	}

	if (isRtkInstalled()) {
		logger.debug('[rtk] already installed on PATH')
		return { installed: true, skipped: true, reason: 'already-installed' }
	}

	if (!resolved.autoInstall) {
		logger.log('[rtk] binary not found on PATH; auto-install disabled')
		return { installed: false, skipped: true, reason: 'auto-install-disabled' }
	}

	if (process.platform === 'win32') {
		logger.log('[rtk] skipping auto-install on Windows (install.sh is POSIX-only)')
		return { installed: false, skipped: true, reason: 'unsupported-platform' }
	}

	// Respect offline indicator.
	if (process.env['OPENCODE_OFFLINE'] === '1' || process.env['FORGE_OFFLINE'] === '1') {
		logger.log('[rtk] skipping auto-install: offline mode')
		return { installed: false, skipped: true, reason: 'offline' }
	}

	// Require `curl` to be present before attempting.
	const curlCheck = spawnSync('which', ['curl'], { stdio: 'ignore' })
	if (curlCheck.status !== 0) {
		logger.log('[rtk] cannot auto-install: `curl` not available')
		return { installed: false, skipped: true, reason: 'curl-missing' }
	}

	logger.log(`[rtk] installing via ${resolved.installUrl}`)
	try {
		await runInstall(resolved.installUrl, logger)
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		logger.error(`[rtk] install failed: ${message}`)
		return { installed: false, skipped: false, reason: `install-failed: ${message}` }
	}

	// Invalidate the path cache so the next check picks up the freshly installed binary.
	invalidateRtkPathCache()
	const nowInstalled = isRtkInstalled()
	if (nowInstalled) {
		logger.log('[rtk] install completed successfully')
	} else {
		logger.log('[rtk] install script exited but `rtk` still not on PATH (may require shell restart)')
	}
	return { installed: nowInstalled, skipped: false }
}

function runInstall(url: string, logger: Logger): Promise<void> {
	return new Promise((resolve, reject) => {
		// Equivalent to: curl -fsSL <url> | sh
		const curl = spawn('curl', ['-fsSL', url], { stdio: ['ignore', 'pipe', 'pipe'] })
		const sh = spawn('sh', [], { stdio: ['pipe', 'pipe', 'pipe'] })

		let stderr = ''

		curl.stdout.pipe(sh.stdin)
		curl.stderr.on('data', chunk => {
			stderr += String(chunk)
		})
		sh.stderr.on('data', chunk => {
			stderr += String(chunk)
		})
		sh.stdout.on('data', chunk => {
			logger.debug(`[rtk-install] ${String(chunk).trimEnd()}`)
		})

		const timeout = setTimeout(() => {
			curl.kill('SIGTERM')
			sh.kill('SIGTERM')
			reject(new Error('install timed out after 120s'))
		}, 120_000)

		let curlExit: number | null = null
		let shExit: number | null = null

		const tryResolve = () => {
			if (curlExit === null || shExit === null) return
			clearTimeout(timeout)
			if (curlExit !== 0) {
				reject(new Error(`curl exited with code ${curlExit}: ${stderr.trim()}`))
				return
			}
			if (shExit !== 0) {
				reject(new Error(`sh exited with code ${shExit}: ${stderr.trim()}`))
				return
			}
			resolve()
		}

		curl.on('exit', code => {
			curlExit = code ?? 1
			tryResolve()
		})
		sh.on('exit', code => {
			shExit = code ?? 1
			tryResolve()
		})
		curl.on('error', err => {
			clearTimeout(timeout)
			reject(err)
		})
		sh.on('error', err => {
			clearTimeout(timeout)
			reject(err)
		})
	})
}
