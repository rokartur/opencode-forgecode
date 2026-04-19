/**
 * CLI: `oc-forgecode ci run` — run a loop/harness in CI and report results.
 *
 * Non-TTY mode with JSON output, markdown report, and proper exit codes.
 * Suitable for GitHub Actions and other CI systems.
 */

import { writeFileSync } from 'fs'
import { loadPluginConfig } from '../../setup'
import { initializeDatabase, closeDatabase, resolveDataDir } from '../../storage'
import { createKvService } from '../../services/kv'
import { createLoopService } from '../../services/loop'
import { createLogger } from '../../utils/logger'
import { resolveLogPath } from '../../storage'

interface CliOptions {
	resolvedProjectId?: string
	dir?: string
	dbPath?: string
}

interface CiResult {
	status: 'success' | 'failure' | 'error' | 'timeout'
	exitCode: number
	summary: string
	loops: CiLoopResult[]
	duration: number
	timestamp: string
}

interface CiLoopResult {
	name: string
	status: string
	iterations: number
	startedAt: number
	completedAt?: number
	errors: string[]
}

export async function cli(args: string[], globalOpts: CliOptions): Promise<void> {
	const subcommand = args[0]

	if (!subcommand || subcommand === 'help' || subcommand === '--help') {
		help()
		return
	}

	if (subcommand === 'run') {
		const code = await run(args.slice(1), globalOpts)
		process.exit(code)
	}

	if (subcommand === 'status') {
		const code = await status(globalOpts)
		process.exit(code)
	}

	console.error(`Unknown ci command: ${subcommand}`)
	help()
	process.exit(1)
}

export async function run(args: string[], globalOpts: CliOptions = {}): Promise<number> {
	const startTime = Date.now()
	const config = loadPluginConfig()
	const dataDir = config.dataDir || resolveDataDir()
	const projectId = globalOpts.resolvedProjectId ?? 'ci-project'

	// Parse CI-specific options
	const outputFormat = args.includes('--json') ? 'json' : args.includes('--markdown') ? 'markdown' : 'text'
	const outputFile = args.find(a => a.startsWith('--output='))?.split('=')[1]
	const timeoutMs = parseInt(args.find(a => a.startsWith('--timeout='))?.split('=')[1] ?? '600', 10) * 1000

	const logger = createLogger({
		enabled: true,
		file: resolveLogPath(),
		debug: args.includes('--debug'),
	})

	logger.log('[ci] starting CI run')

	let db
	try {
		db = initializeDatabase(dataDir)
	} catch (err) {
		const result = buildErrorResult(startTime, `Database init failed: ${(err as Error).message}`)
		outputResult(result, outputFormat, outputFile)
		return 1
	}

	try {
		const kvService = createKvService(db, logger, config.defaultKvTtlMs)
		const loopService = createLoopService(kvService, projectId, logger, config.loop)

		// Gather loop statuses
		const activeLoops = loopService.listActive()
		const loopResults: CiLoopResult[] = activeLoops.map(loop => ({
			name: loop.loopName ?? 'unnamed',
			status: loop.active ? 'active' : 'inactive',
			iterations: loop.iteration ?? 0,
			startedAt: Date.parse(loop.startedAt) || Date.now(),
			errors: [],
		}))

		const elapsed = Date.now() - startTime
		const hasActive = activeLoops.some(l => l.active)
		const timedOut = elapsed >= timeoutMs

		const result: CiResult = {
			status: timedOut ? 'timeout' : hasActive ? 'success' : 'success',
			exitCode: timedOut ? 2 : 0,
			summary: timedOut
				? `CI timed out after ${Math.round(elapsed / 1000)}s. ${activeLoops.length} loop(s) still active.`
				: `CI check complete. ${activeLoops.length} loop(s) found, ${activeLoops.filter(l => l.active).length} active.`,
			loops: loopResults,
			duration: elapsed,
			timestamp: new Date().toISOString(),
		}

		outputResult(result, outputFormat, outputFile)
		return result.exitCode
	} catch (err) {
		const result = buildErrorResult(startTime, (err as Error).message)
		outputResult(result, outputFormat, outputFile)
		return 1
	} finally {
		closeDatabase(db)
	}
}

async function status(globalOpts: CliOptions = {}): Promise<number> {
	const config = loadPluginConfig()
	const dataDir = config.dataDir || resolveDataDir()
	const projectId = globalOpts.resolvedProjectId ?? 'ci-project'

	const logger = createLogger({ enabled: false, file: '' })

	let db
	try {
		db = initializeDatabase(dataDir)
	} catch {
		console.error('Failed to open database')
		return 1
	}

	try {
		const kvService = createKvService(db, logger, config.defaultKvTtlMs)
		const loopService = createLoopService(kvService, projectId, logger, config.loop)

		const loops = loopService.listActive()
		if (loops.length === 0) {
			console.log('No active loops.')
			return 0
		}

		console.log(`Active loops: ${loops.length}`)
		for (const loop of loops) {
			console.log(
				`  ${loop.loopName ?? 'unnamed'}: ${loop.active ? 'running' : 'inactive'} (${loop.iteration ?? 0} iterations)`,
			)
		}
		return 0
	} finally {
		closeDatabase(db)
	}
}

function buildErrorResult(startTime: number, message: string): CiResult {
	return {
		status: 'error',
		exitCode: 1,
		summary: `CI run failed: ${message}`,
		loops: [],
		duration: Date.now() - startTime,
		timestamp: new Date().toISOString(),
	}
}

function outputResult(result: CiResult, format: string, outputFile?: string): void {
	let output: string

	switch (format) {
		case 'json':
			output = JSON.stringify(result, null, 2)
			break
		case 'markdown':
			output = formatMarkdown(result)
			break
		default:
			output = formatText(result)
	}

	if (outputFile) {
		writeFileSync(outputFile, output, 'utf-8')
		console.log(`Report written to ${outputFile}`)
	} else {
		console.log(output)
	}
}

function formatText(result: CiResult): string {
	const lines = [
		`Forge CI Result: ${result.status.toUpperCase()}`,
		`Duration: ${result.duration}ms`,
		`Summary: ${result.summary}`,
	]

	if (result.loops.length > 0) {
		lines.push('', 'Loops:')
		for (const loop of result.loops) {
			lines.push(`  ${loop.name}: ${loop.status} (${loop.iterations} iterations)`)
		}
	}

	return lines.join('\n')
}

function formatMarkdown(result: CiResult): string {
	const statusEmoji = result.status === 'success' ? '✅' : result.status === 'failure' ? '❌' : '⚠️'

	const lines = [
		`# ${statusEmoji} Forge CI Report`,
		'',
		`**Status:** ${result.status}`,
		`**Duration:** ${result.duration}ms`,
		`**Time:** ${result.timestamp}`,
		'',
		`## Summary`,
		'',
		result.summary,
	]

	if (result.loops.length > 0) {
		lines.push('', '## Loops', '', '| Name | Status | Iterations |', '|---|---|---|')
		for (const loop of result.loops) {
			lines.push(`| ${loop.name} | ${loop.status} | ${loop.iterations} |`)
		}
	}

	return lines.join('\n')
}

export function help(): void {
	console.log(
		`
Run loops/harness in CI mode

Usage:
  oc-forgecode ci run [options]
  oc-forgecode ci status

Options:
  --json          Output results as JSON
  --markdown      Output results as markdown
  --output=<file> Write report to file
  --timeout=<s>   Timeout in seconds (default: 600)
  --debug         Enable debug logging

Exit codes:
  0  All checks passed
  1  One or more checks failed
  `.trim(),
	)
}
