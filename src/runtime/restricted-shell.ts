/**
 * Restricted shell — per-agent command allowlisting for shell tools.
 *
 * Parses commands and checks them against a per-agent whitelist.
 * Provides audit logging for blocked and bypassed commands.
 */

import type { Logger, RestrictedShellConfig } from '../types'

export interface ShellCheckResult {
	allowed: boolean
	command: string
	agent: string
	reason: string
}

export interface RestrictedShellAuditEntry {
	timestamp: number
	sessionId: string
	agent: string
	command: string
	allowed: boolean
	reason: string
	/** True if the command was blocked but then manually bypassed. */
	bypassed: boolean
}

export class RestrictedShellEnforcer {
	private allowlists: Record<string, Set<string>>
	private logger: Logger
	private enabled: boolean
	private audit: RestrictedShellAuditEntry[] = []

	/**
	 * Well-known dangerous commands that should always be blocked unless
	 * explicitly in the allowlist.
	 */
	private static readonly DANGEROUS_PATTERNS = [
		/\brm\s+-rf\s+[/~]/,
		/\bmkfs\b/,
		/\bdd\s+if=/,
		/\bformat\b/,
		/\b>\s*\/dev\//,
		/\bchmod\s+-R\s+777/,
		/\bcurl\b.*\|\s*(ba)?sh/,
		/\bwget\b.*\|\s*(ba)?sh/,
		/\beval\b/,
		/\bsudo\s+(rm|mkfs|dd|format|chmod)/,
	]

	constructor(logger: Logger, config?: RestrictedShellConfig) {
		this.logger = logger
		this.enabled = config?.enabled ?? false
		this.allowlists = {}

		if (config?.whitelist) {
			for (const [agent, commands] of Object.entries(config.whitelist)) {
				this.allowlists[agent] = new Set(commands)
			}
		}
	}

	/**
	 * Check whether a command is allowed for the given agent.
	 */
	check(agent: string, command: string, sessionId?: string): ShellCheckResult {
		if (!this.enabled) {
			return { allowed: true, command, agent, reason: 'restricted shell disabled' }
		}

		const parsed = parseCommand(command)
		if (!parsed) {
			const result: ShellCheckResult = { allowed: false, command, agent, reason: 'unparseable command' }
			this.recordAudit(sessionId ?? '', agent, command, false, result.reason)
			return result
		}

		// Check dangerous patterns regardless of allowlist
		for (const pattern of RestrictedShellEnforcer.DANGEROUS_PATTERNS) {
			if (pattern.test(command)) {
				const result: ShellCheckResult = {
					allowed: false,
					command,
					agent,
					reason: `matches dangerous pattern: ${pattern.source}`,
				}
				this.recordAudit(sessionId ?? '', agent, command, false, result.reason)
				this.logger.log(`[restricted-shell] BLOCKED (dangerous): agent=${agent} cmd="${truncateCmd(command)}"`)
				return result
			}
		}

		const agentList = this.allowlists[agent]
		if (!agentList) {
			// No allowlist for this agent — allow by default (graceful degradation)
			return { allowed: true, command, agent, reason: 'no allowlist configured for agent' }
		}

		const baseCommand = parsed.base
		if (agentList.has(baseCommand)) {
			this.recordAudit(sessionId ?? '', agent, command, true, 'in allowlist')
			return { allowed: true, command, agent, reason: 'in allowlist' }
		}

		// Also check if any prefix matches (e.g. "npm run" matching "npm")
		for (const allowed of agentList) {
			if (baseCommand.startsWith(allowed + ' ') || baseCommand === allowed) {
				this.recordAudit(sessionId ?? '', agent, command, true, `prefix match: ${allowed}`)
				return { allowed: true, command, agent, reason: `prefix match: ${allowed}` }
			}
		}

		const result: ShellCheckResult = {
			allowed: false,
			command,
			agent,
			reason: `command "${baseCommand}" not in allowlist for agent "${agent}"`,
		}
		this.recordAudit(sessionId ?? '', agent, command, false, result.reason)
		this.logger.log(
			`[restricted-shell] BLOCKED: agent=${agent} cmd="${truncateCmd(command)}" reason="${result.reason}"`,
		)
		return result
	}

	/**
	 * Force-allow a blocked command (audit bypass).
	 */
	bypass(agent: string, command: string, sessionId: string): void {
		this.audit.push({
			timestamp: Date.now(),
			sessionId,
			agent,
			command,
			allowed: true,
			reason: 'manual bypass',
			bypassed: true,
		})
		this.logger.log(`[restricted-shell] BYPASS: agent=${agent} cmd="${truncateCmd(command)}"`)
	}

	/**
	 * Get audit trail.
	 */
	getAudit(): readonly RestrictedShellAuditEntry[] {
		return this.audit
	}

	/**
	 * Whether the enforcer is enabled.
	 */
	isEnabled(): boolean {
		return this.enabled
	}

	private recordAudit(sessionId: string, agent: string, command: string, allowed: boolean, reason: string): void {
		this.audit.push({
			timestamp: Date.now(),
			sessionId,
			agent,
			command,
			allowed,
			reason,
			bypassed: false,
		})
	}
}

interface ParsedCommand {
	base: string
	args: string[]
}

/**
 * Parse a shell command string into its base command and arguments.
 * Handles pipes, redirects, and chained commands by checking the first segment.
 */
function parseCommand(command: string): ParsedCommand | null {
	const trimmed = command.trim()
	if (!trimmed) return null

	// Handle environment variable prefixes (e.g. "FOO=bar npm run build")
	let cmdPart = trimmed
	while (/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/.test(cmdPart)) {
		cmdPart = cmdPart.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S+\s+/, '')
	}

	// Split on pipe, &&, || and ; to get the first command
	const firstCmd = cmdPart.split(/[|;&]/)[0]!.trim()
	if (!firstCmd) return null

	const parts = firstCmd.split(/\s+/)
	const base = parts[0]!
	return { base, args: parts.slice(1) }
}

function truncateCmd(cmd: string): string {
	return cmd.length > 100 ? cmd.slice(0, 100) + '...' : cmd
}
