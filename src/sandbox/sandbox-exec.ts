/**
 * macOS sandbox-exec backend.
 *
 * Uses `sandbox-exec -p <profile>` (macOS only) to run commands in a
 * sandbox with restricted file-system, network, and process access.
 *
 * The profile allows read-write to the project directory and read-only
 * to system paths (/usr, /bin, /Library). Network is denied by default.
 */

import { spawn } from 'child_process'
import { platform } from 'os'
import type { SandboxBackend, SandboxExecOpts, SandboxExecResult } from './backend'

const DEFAULT_TIMEOUT = 120_000

/**
 * Build a Seatbelt (sandbox-exec) profile for the given project directory.
 */
function buildProfile(projectDir: string, allowNetwork = false): string {
	return `
(version 1)
(deny default)

;; Allow read-only access to system paths
(allow file-read*
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/Library")
  (subpath "/System")
  (subpath "/private/var/db")
  (subpath "/dev")
  (subpath "/etc")
  (subpath "/var/folders")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (literal "/"))

;; Allow read-write to project directory
(allow file-read* file-write*
  (subpath "${projectDir}"))

;; Allow process operations
(allow process-exec
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin"))
(allow process-fork)

;; Allow sysctl and mach lookups (needed by most programs)
(allow sysctl-read)
(allow mach-lookup)
(allow ipc-posix-shm-read-data)
(allow ipc-posix-shm-write-data)
(allow signal (target self))

${allowNetwork ? ';; Network allowed\n(allow network*)' : ';; Network denied\n(deny network*)'}
`.trim()
}

export function createSandboxExecBackend(): SandboxBackend {
	return {
		name: 'sandbox-exec',

		async isAvailable(): Promise<boolean> {
			if (platform() !== 'darwin') return false
			try {
				const result = await execPromise('which', ['sandbox-exec'], { timeout: 5000 })
				return result.exitCode === 0
			} catch {
				return false
			}
		},

		async exec(command: string, projectDir: string, opts?: SandboxExecOpts): Promise<SandboxExecResult> {
			const profile = buildProfile(projectDir)
			const timeout = opts?.timeout ?? DEFAULT_TIMEOUT
			const cwd = opts?.cwd ?? projectDir

			return execPromise('sandbox-exec', ['-p', profile, '/bin/sh', '-c', command], {
				timeout,
				cwd,
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
