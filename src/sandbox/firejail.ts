/**
 * Linux Firejail sandbox backend.
 *
 * Uses firejail to run commands in a restricted environment.
 * Network is disabled; project directory is writable; system paths read-only.
 */

import { spawn } from 'child_process'
import { platform } from 'os'
import type { SandboxBackend, SandboxExecOpts, SandboxExecResult } from './backend'

const DEFAULT_TIMEOUT = 120_000

/**
 * Build firejail arguments for the given project directory.
 */
function buildArgs(command: string, projectDir: string): string[] {
	return [
		// Security: disable network, restrict filesystem
		'--noprofile',
		'--net=none',
		'--private-dev',
		'--nogroups',
		// Whitelist project directory
		`--whitelist=${projectDir}`,
		// Allow common read-only system paths
		'--read-only=/usr',
		'--read-only=/bin',
		'--read-only=/lib',
		'--read-only=/etc',
		'--read-only=/sbin',
		// Disable capabilities
		'--caps.drop=all',
		'--nonewprivs',
		// No sound, dbus, etc.
		'--nosound',
		'--nodbus',
		// Command
		'/bin/sh',
		'-c',
		command,
	]
}

export function createFirejailBackend(): SandboxBackend {
	return {
		name: 'firejail',

		async isAvailable(): Promise<boolean> {
			if (platform() !== 'linux') return false
			try {
				const result = await execPromise('which', ['firejail'], { timeout: 5000 })
				return result.exitCode === 0
			} catch {
				return false
			}
		},

		async exec(command: string, projectDir: string, opts?: SandboxExecOpts): Promise<SandboxExecResult> {
			const timeout = opts?.timeout ?? DEFAULT_TIMEOUT
			const args = buildArgs(command, projectDir)

			return execPromise('firejail', args, {
				timeout,
				cwd: opts?.cwd ?? projectDir,
				stdin: opts?.stdin,
				abort: opts?.abort,
				env: opts?.env,
			})
		},
	}
}

function execPromise(
	cmd: string,
	args: string[],
	opts: { timeout?: number; cwd?: string; stdin?: string; abort?: AbortSignal; env?: Record<string, string> },
): Promise<SandboxExecResult> {
	return new Promise((resolve, reject) => {
		const proc = spawn(cmd, args, {
			cwd: opts.cwd,
			env: { ...process.env, ...opts.env },
			stdio: ['pipe', 'pipe', 'pipe'],
			timeout: opts.timeout,
		})

		let stdout = ''
		let stderr = ''

		proc.stdout?.on('data', (d: Buffer) => {
			stdout += d.toString()
		})
		proc.stderr?.on('data', (d: Buffer) => {
			stderr += d.toString()
		})

		if (opts.stdin && proc.stdin) {
			proc.stdin.write(opts.stdin)
			proc.stdin.end()
		}

		if (opts.abort) {
			opts.abort.addEventListener('abort', () => {
				proc.kill('SIGTERM')
			})
		}

		proc.on('close', code => {
			resolve({ stdout, stderr, exitCode: code ?? 1 })
		})

		proc.on('error', err => {
			reject(err)
		})
	})
}
