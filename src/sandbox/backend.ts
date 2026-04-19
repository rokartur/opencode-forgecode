/**
 * Sandbox backend abstraction — common interface for all sandbox modes.
 *
 * Each backend (docker, sandbox-exec, bubblewrap, firejail) implements
 * this interface. The `auto` mode selects the best available backend
 * for the current platform.
 */

export interface SandboxExecResult {
	stdout: string
	stderr: string
	exitCode: number
}

export interface SandboxExecOpts {
	timeout?: number
	cwd?: string
	abort?: AbortSignal
	stdin?: string
	env?: Record<string, string>
}

/**
 * A sandbox backend that can execute commands in an isolated environment.
 */
export interface SandboxBackend {
	/** Backend identifier. */
	readonly name: string

	/** Check whether this backend is available on the current system. */
	isAvailable(): Promise<boolean>

	/**
	 * Execute a command inside the sandbox.
	 *
	 * @param command - Shell command string to execute.
	 * @param projectDir - Absolute path to the project directory (mounted read-write).
	 * @param opts - Execution options.
	 */
	exec(command: string, projectDir: string, opts?: SandboxExecOpts): Promise<SandboxExecResult>
}
