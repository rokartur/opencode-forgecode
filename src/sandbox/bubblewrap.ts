/**
 * Linux Bubblewrap (bwrap) sandbox backend.
 *
 * Uses bubblewrap to create a lightweight user-namespace sandbox.
 * The project directory is mounted read-write; system paths are read-only.
 * Network is isolated by default.
 */

import { spawn } from 'child_process'
import { platform } from 'os'
import type { SandboxBackend, SandboxExecOpts, SandboxExecResult } from './backend'

const DEFAULT_TIMEOUT = 120_000

/**
 * Build bwrap arguments for the given project directory.
 */
function buildArgs(command: string, projectDir: string, cwd: string): string[] {
	return [
		// Read-only system mounts
		'--ro-bind',
		'/usr',
		'/usr',
		'--ro-bind',
		'/bin',
		'/bin',
		'--ro-bind',
		'/lib',
		'/lib',
		'--ro-bind',
		'/lib64',
		'/lib64',
		'--ro-bind',
		'/etc',
		'/etc',
		'--ro-bind',
		'/sbin',
		'/sbin',
		// Writable project directory
		'--bind',
		projectDir,
		projectDir,
		// Minimal /dev
		'--dev',
		'/dev',
		// /proc and /tmp
		'--proc',
		'/proc',
		'--tmpfs',
		'/tmp',
		// Unshare namespaces (user + network + pid)
		'--unshare-net',
		'--unshare-pid',
		// Working directory
		'--chdir',
		cwd,
		// Die with parent
		'--die-with-parent',
		// Command
		'/bin/sh',
		'-c',
		command,
	]
}

export function createBubblewrapBackend(): SandboxBackend {
	return {
		name: 'bubblewrap',

		async isAvailable(): Promise<boolean> {
			if (platform() !== 'linux') return false
			try {
				const result = await execPromise('which', ['bwrap'], { timeout: 5000 })
				return result.exitCode === 0
			} catch {
				return false
			}
		},

		async exec(command: string, projectDir: string, opts?: SandboxExecOpts): Promise<SandboxExecResult> {
			const timeout = opts?.timeout ?? DEFAULT_TIMEOUT
			const cwd = opts?.cwd ?? projectDir
			const args = buildArgs(command, projectDir, cwd)

			return execPromise('bwrap', args, {
				timeout,
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
