import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { initializeDatabase, closeDatabase, resolveDataDir } from '../../storage'
import { loadPluginConfig, resolveConfigPath } from '../../setup'
import { collectUnsupportedConfigIssues, getCapabilityDescriptors } from '../../runtime/feature-support'
import { parseModelString, resolveFallbackModelEntries } from '../../utils/model-fallback'
import { resolveRtkPath } from '../../runtime/rtk'
import type { PluginConfig } from '../../types'

type CheckStatus = 'OK' | 'WARN' | 'FAIL'

interface CheckResult {
	label: string
	status: CheckStatus
	detail: string
}

interface CliOptions {
	resolvedProjectId?: string
	dir?: string
	json?: boolean
}

const STATUS_ICON: Record<CheckStatus, string> = {
	OK: 'OK',
	WARN: 'WARN',
	FAIL: 'FAIL',
}

export async function run(globalOpts: CliOptions = {}): Promise<number> {
	const config = loadPluginConfig()
	const configPath = resolveConfigPath()
	const dataDir = config.dataDir || resolveDataDir()

	const checks: CheckResult[] = []

	checks.push({
		label: 'Config file',
		status: existsSync(configPath) ? 'OK' : 'WARN',
		detail: existsSync(configPath) ? configPath : `Config file not found at ${configPath}`,
	})

	checks.push(checkRuntime())
	checks.push(checkDataDir(dataDir))
	checks.push(checkDatabase(dataDir))
	checks.push(checkSandbox(config))
	checks.push(checkModel('executionModel', config.executionModel))
	checks.push(checkModel('auditorModel', config.auditorModel))
	checks.push(...checkAgentModels(config))
	checks.push(...checkAgentFallbackModels(config))
	checks.push(...checkOptionalBinaries(config))
	checks.push(
		...collectUnsupportedConfigIssues(config).map(issue => ({
			label: issue.label,
			status: 'FAIL' as const,
			detail: issue.detail,
		})),
	)

	if (config.graph?.enabled === false) {
		checks.push({
			label: 'Graph',
			status: 'OK',
			detail: 'Graph disabled in config.',
		})
	} else if (globalOpts.resolvedProjectId) {
		checks.push({
			label: 'Graph',
			status: 'OK',
			detail: `Graph enabled for project ${globalOpts.resolvedProjectId}. Use \`oc-forgecode graph status\` for index health.`,
		})
	} else {
		checks.push({
			label: 'Graph',
			status: 'OK',
			detail: 'Graph is enabled. Project-specific index health was skipped because no project was resolved.',
		})
	}

	const capabilitySummary = getCapabilityDescriptors().map(d => ({
		id: d.id,
		label: d.label,
		status: d.status,
		note: d.note,
		plannedStage: d.plannedStage ?? null,
	}))

	const hasFail = checks.some(check => check.status === 'FAIL')
	const hasWarn = checks.some(check => check.status === 'WARN')
	const result: 'OK' | 'WARN' | 'FAIL' = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'OK'

	if (globalOpts.json) {
		const payload = {
			result,
			configPath,
			dataDir,
			checks: checks.map(c => ({ label: c.label, status: c.status, detail: c.detail })),
			capabilities: capabilitySummary,
		}
		console.log(JSON.stringify(payload, null, 2))
		return hasFail ? 1 : 0
	}

	console.log('Forge Doctor')
	console.log('')
	for (const check of checks) {
		console.log(`[${STATUS_ICON[check.status]}] ${check.label}: ${check.detail}`)
	}

	console.log('')
	console.log('Capability summary (see plans/master-plan.md for stages):')
	for (const cap of capabilitySummary) {
		const stageHint = cap.plannedStage ? ` (planned: ${cap.plannedStage})` : ''
		console.log(`  - ${cap.label}: ${cap.status}${stageHint}`)
	}

	console.log('')
	if (hasFail) {
		console.log('Doctor result: FAIL')
		return 1
	}
	if (hasWarn) {
		console.log('Doctor result: WARN')
		return 0
	}

	console.log('Doctor result: OK')
	return 0
}

export async function cli(args: string[], globalOpts: CliOptions): Promise<void> {
	const opts: CliOptions = { ...globalOpts }
	if (args.includes('--json')) opts.json = true
	const code = await run(opts)
	if (code !== 0) {
		process.exit(code)
	}
}

export function help(): void {
	console.log(
		`
Run environment and configuration diagnostics

Usage:
  oc-forgecode doctor [options]

Options:
  --json    Emit results as a JSON document instead of human-readable text

Exit codes:
  0  All checks passed (or only warnings present)
  1  At least one check failed
  `.trim(),
	)
}

function checkRuntime(): CheckResult {
	const nodeVersion = process.versions.node ?? 'unknown'
	const bunVersion = (process.versions as Record<string, string | undefined>)['bun']
	const runtime = bunVersion ? `Bun ${bunVersion} (Node compat ${nodeVersion})` : `Node ${nodeVersion}`
	return {
		label: 'Runtime',
		status: 'OK',
		detail: runtime,
	}
}

function checkOptionalBinaries(config: PluginConfig): CheckResult[] {
	const checks: CheckResult[] = []

	const astBinary = config.ast?.binary || 'sg'
	const astEnabled = Boolean(config.ast?.enabled)
	if (astEnabled) {
		// Already covered by feature-support FAIL; skip duplicate WARN.
	} else if (commandExists(astBinary)) {
		// Inform users that the binary is ready for Stage 5a, but stay OK by default.
		checks.push({
			label: 'AST binary (ast-grep)',
			status: 'OK',
			detail: `\`${astBinary}\` available on PATH (used once Stage 5a lands).`,
		})
	}
	// If AST is disabled and `sg` is missing, stay silent — installing it is only required after Stage 5a.

	// RTK (Rust Token Killer) — optional CLI proxy for token-optimized shell output.
	const rtkEnabled = config.rtk?.enabled ?? true
	if (rtkEnabled) {
		const rtkPath = resolveRtkPath()
		if (rtkPath) {
			checks.push({
				label: 'RTK (Rust Token Killer)',
				status: 'OK',
				detail: `\`rtk\` found at \`${rtkPath}\`. Agents will be instructed to prefix shell commands with \`rtk\`.`,
			})
		} else {
			const autoInstall = config.rtk?.autoInstall ?? true
			checks.push({
				label: 'RTK (Rust Token Killer)',
				status: 'WARN',
				detail: autoInstall
					? '`rtk` not on PATH. Auto-install runs at plugin init; restart your shell after install.'
					: '`rtk` not on PATH and auto-install is disabled. Install via `curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh`.',
			})
		}
	}

	const lspServers = config.lsp?.servers ?? {}
	const lspEnabled = Boolean(config.lsp?.enabled)
	if (lspEnabled) {
		for (const [lang, entry] of Object.entries(lspServers)) {
			const command = typeof entry === 'string' ? entry : (entry as { command?: string })?.command
			if (!command) {
				checks.push({
					label: `LSP server (${lang})`,
					status: 'WARN',
					detail: 'No `command` field configured.',
				})
				continue
			}
			checks.push({
				label: `LSP server (${lang})`,
				status: commandExists(command) ? 'OK' : 'WARN',
				detail: commandExists(command) ? `\`${command}\` available on PATH.` : `\`${command}\` not on PATH.`,
			})
		}
	}

	return checks
}

function checkDataDir(dataDir: string): CheckResult {
	try {
		mkdirSync(dataDir, { recursive: true })
		const probeDir = join(dataDir, '.doctor')
		mkdirSync(probeDir, { recursive: true })
		const probePath = join(probeDir, 'write-test')
		writeFileSync(probePath, 'ok', 'utf8')
		rmSync(probePath, { force: true })
		return {
			label: 'Data dir',
			status: 'OK',
			detail: `${dataDir} is writable.`,
		}
	} catch (err) {
		return {
			label: 'Data dir',
			status: 'FAIL',
			detail: `${dataDir} is not writable: ${(err as Error).message}`,
		}
	}
}

function checkDatabase(dataDir: string): CheckResult {
	try {
		const db = initializeDatabase(dataDir)
		closeDatabase(db)
		return {
			label: 'Database',
			status: 'OK',
			detail: `Forge database opened successfully in ${dataDir}.`,
		}
	} catch (err) {
		return {
			label: 'Database',
			status: 'FAIL',
			detail: `Failed to open forge database in ${dataDir}: ${(err as Error).message}`,
		}
	}
}

function checkSandbox(config: PluginConfig): CheckResult {
	const mode = config.sandbox?.mode || 'off'
	if (mode === 'off') {
		return {
			label: 'Sandbox',
			status: 'OK',
			detail: 'Sandbox disabled.',
		}
	}

	if (mode === 'docker') {
		return {
			label: 'Sandbox',
			status: commandExists('docker') ? 'OK' : 'FAIL',
			detail: commandExists('docker')
				? 'Docker mode configured and docker binary is available.'
				: 'Docker mode configured, but docker binary is not available on PATH.',
		}
	}

	// sandbox-exec, bubblewrap, firejail, auto — all implemented
	return {
		label: 'Sandbox',
		status: 'OK',
		detail: `Sandbox mode \`${mode}\` configured.`,
	}
}

function checkModel(label: string, value?: string): CheckResult {
	if (!value) {
		return {
			label,
			status: 'OK',
			detail: 'Not configured.',
		}
	}

	const parsed = parseModelString(value)
	if (!parsed) {
		return {
			label,
			status: 'FAIL',
			detail: `Invalid model string \`${value}\`. Expected provider/model format.`,
		}
	}

	return {
		label,
		status: 'OK',
		detail: `Configured as ${parsed.providerID}/${parsed.modelID}.`,
	}
}

function checkAgentModels(config: PluginConfig): CheckResult[] {
	const checks: CheckResult[] = []
	for (const [agentName, override] of Object.entries(config.agents ?? {})) {
		checks.push(checkModel(`Agent model (${agentName})`, override.model))
	}
	return checks
}

function checkAgentFallbackModels(config: PluginConfig): CheckResult[] {
	const checks: CheckResult[] = []
	for (const [agentName, override] of Object.entries(config.agents ?? {})) {
		if (!override.fallback_models?.length) continue
		const resolved = resolveFallbackModelEntries(override.fallback_models)
		if (resolved.length !== override.fallback_models.length) {
			checks.push({
				label: `Agent fallback chain (${agentName})`,
				status: 'FAIL',
				detail: 'One or more fallback model entries are invalid. Expected provider/model format.',
			})
			continue
		}

		checks.push({
			label: `Agent fallback chain (${agentName})`,
			status: 'OK',
			detail: `Configured with ${resolved.length} fallback model(s).`,
		})
	}
	return checks
}

function commandExists(command: string): boolean {
	const whichCommand = process.platform === 'win32' ? 'where' : 'which'
	const result = spawnSync(whichCommand, [command], {
		stdio: 'ignore',
	})
	return result.status === 0
}
