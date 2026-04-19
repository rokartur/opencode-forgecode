/**
 * `oc-forgecode setup-models` — manage per-agent model chains.
 *
 * Subcommands:
 *   install       Interactive installer. Asks about provider subscriptions,
 *                 fetches the live opencode provider catalog (if reachable),
 *                 resolves each agent's fallback chain, and writes the result
 *                 to forge-config.jsonc.
 *   status        Show current `agents.*.model` entries.
 *   reset         Remove the `agents` block so the next run regenerates it.
 *   show-chains   Print the built-in per-agent fallback chains.
 *   preview       Dry-run assignments for a given provider set.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'
import { stdin as input, stdout as output } from 'process'
import { loadPluginConfig, resolveConfigPath } from '../../setup'
import {
	AGENT_CHAINS,
	SUBSCRIPTION_QUESTIONS,
	SUPPORTED_PROVIDERS,
	type SupportedProvider,
} from '../../runtime/model-requirements'
import {
	computeAgentAssignments,
	mergeAssignmentsIntoConfig,
	persistAgentAssignments,
	type AgentAssignment,
	type ProviderCatalog,
} from '../../runtime/auto-model-setup'

interface CliOptions {
	dir?: string
	resolvedProjectId?: string
	dbPath?: string
}

export async function cli(args: string[], _globalOpts: CliOptions = {}): Promise<void> {
	const sub = args[0] ?? 'status'
	const rest = args.slice(1)
	switch (sub) {
		case 'install':
			return runInstall(rest)
		case 'status':
			return printStatus()
		case 'reset':
			return runReset()
		case 'show-chains':
		case 'show-profiles':
			return printChains()
		case 'preview':
			return runPreview(rest)
		case 'help':
		case '--help':
		case '-h':
			return help()
		default:
			console.error(`Unknown setup-models subcommand: ${sub}`)
			help()
			process.exit(1)
	}
}

export function help(): void {
	console.log(
		`
Manage per-agent model chains for forge subagents.

Usage:
  oc-forgecode setup-models <command> [options]

Commands:
  install       Interactive: ask about provider subscriptions and write
                agents.* model + fallback_models into forge-config.jsonc.
  status        Show current per-agent model mappings.
  reset         Remove the "agents" block from forge-config.jsonc.
  show-chains   Print the built-in per-agent fallback chains.
  preview       Dry run — compute assignments for a given provider set:
                  oc-forgecode setup-models preview --providers=anthropic,opencode-go

Install flags:
  --yes                     Accept auto-detected provider set without prompting.
  --providers=<a,b,c>       Explicit provider list; skips prompts entirely.
  --flag=<id>=<yes|no>      Override a single answer (repeatable).
  --server=<url>            Opencode server URL (default: http://127.0.0.1:4096).
  --overwrite               Replace existing agents.*.model entries.

Notes:
  Auto-setup ALSO runs silently at plugin startup using the opencode
  server's connected-provider list. Use \`install\` when you want explicit
  control or before any opencode auth has been configured.
`.trim(),
	)
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

interface InstallFlags {
	yes: boolean
	providers: SupportedProvider[] | null
	explicit: Map<SupportedProvider, boolean>
	serverUrl: string
	overwrite: boolean
}

function parseInstallFlags(args: string[]): InstallFlags {
	const flags: InstallFlags = {
		yes: false,
		providers: null,
		explicit: new Map(),
		serverUrl: process.env['OPENCODE_SERVER'] || 'http://127.0.0.1:4096',
		overwrite: false,
	}
	for (const arg of args) {
		if (arg === '--yes' || arg === '-y') flags.yes = true
		else if (arg === '--overwrite') flags.overwrite = true
		else if (arg.startsWith('--providers=')) {
			flags.providers = arg
				.slice('--providers='.length)
				.split(',')
				.map(s => s.trim())
				.filter((s): s is SupportedProvider => (SUPPORTED_PROVIDERS as readonly string[]).includes(s))
		} else if (arg.startsWith('--flag=')) {
			const [id, val] = arg.slice('--flag='.length).split('=')
			if (id && val && (SUPPORTED_PROVIDERS as readonly string[]).includes(id)) {
				flags.explicit.set(id as SupportedProvider, val === 'yes' || val === 'true' || val === '1')
			}
		} else if (arg.startsWith('--server=')) {
			flags.serverUrl = arg.slice('--server='.length)
		}
	}
	return flags
}

async function runInstall(args: string[]): Promise<void> {
	const flags = parseInstallFlags(args)

	// 1. Try to fetch the live provider catalog so the installer knows which
	//    providers are authenticated & what models each actually publishes.
	const catalog = await tryFetchCatalog(flags.serverUrl)

	// 2. Determine the user's provider set.
	let providers: Set<SupportedProvider>
	if (flags.providers) {
		providers = new Set(flags.providers)
		console.log(`Using providers from --providers: ${[...providers].join(', ') || '(none)'}`)
	} else if (flags.yes && catalog && catalog.connected.size > 0) {
		providers = filterSupported(catalog.connected)
		console.log(`Using auto-detected connected providers: ${[...providers].join(', ')}`)
	} else {
		providers = await promptForProviders(catalog, flags.explicit)
	}

	if (providers.size === 0) {
		console.error('\nNo providers selected — nothing to configure.')
		console.error('Run `opencode auth login` first, or re-run with --providers=<list>.')
		process.exit(1)
	}

	// 3. Compute assignments.
	const config = loadPluginConfig()
	const assignments = computeAgentAssignments(providers as Set<string>, config, catalog, {
		overwrite: flags.overwrite,
	})

	if (assignments.length === 0) {
		console.error(
			'\nNo agent chains could be resolved against the selected providers.\n' +
				'You may need to authenticate a broader provider set (e.g. anthropic, openai, or opencode).',
		)
		process.exit(1)
	}

	printAssignmentsTable(assignments)

	// 4. Persist.
	const result = persistAgentAssignments(assignments, {
		log: (m: string) => console.log(m),
		error: (m: string, err?: unknown) => console.error(m, err ?? ''),
		debug: () => {},
	})

	if (!result.written) {
		if (result.reason === 'agents-block-exists') {
			console.log(
				'\nforge-config.jsonc already has an "agents" block.\n' +
					'Run `oc-forgecode setup-models reset` to clear it, then re-run install.',
			)
		} else if (result.reason !== 'no-assignments') {
			console.error(`\nCould not write mappings (${result.reason ?? 'unknown'}).`)
			process.exit(1)
		}
	}

	mergeAssignmentsIntoConfig(config, assignments)
	console.log('\nDone. Restart opencode (or any running forge session) for changes to take effect.')
}

async function tryFetchCatalog(serverUrl: string): Promise<ProviderCatalog | null> {
	try {
		const url = new URL(serverUrl)
		const password = url.password || process.env['OPENCODE_SERVER_PASSWORD']
		const cleanUrl = new URL(url.toString())
		cleanUrl.username = ''
		cleanUrl.password = ''

		const headers: Record<string, string> = { accept: 'application/json' }
		if (password) {
			headers['authorization'] = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`
		}

		const res = await fetch(new URL('/provider', cleanUrl).toString(), { headers })
		if (!res.ok) return null
		const data = (await res.json()) as {
			all?: Array<{ id: string; models?: Record<string, { id: string }> }>
			connected?: string[]
		}
		const models = new Map<string, Set<string>>()
		for (const p of data.all ?? []) {
			const ids = new Set<string>()
			for (const m of Object.values(p.models ?? {})) ids.add(m.id)
			models.set(p.id, ids)
		}
		return { models, connected: new Set(data.connected ?? []) }
	} catch {
		return null
	}
}

function filterSupported(set: Set<string>): Set<SupportedProvider> {
	const out = new Set<SupportedProvider>()
	for (const p of set) {
		if ((SUPPORTED_PROVIDERS as readonly string[]).includes(p)) out.add(p as SupportedProvider)
	}
	return out
}

async function promptForProviders(
	catalog: ProviderCatalog | null,
	explicit: Map<SupportedProvider, boolean>,
): Promise<Set<SupportedProvider>> {
	const connected = catalog?.connected ?? new Set<string>()
	const rl = createInterface({ input, output })
	const chosen = new Set<SupportedProvider>()

	console.log('\nforge model setup — tell me which provider subscriptions you have.')
	if (catalog) {
		console.log(`Auto-detected connected providers: ${[...connected].join(', ') || '(none)'}`)
	} else {
		console.log('(Could not reach opencode server — answering blind.)')
	}
	console.log('Default is the auto-detected state. Press Enter to accept.\n')

	for (const q of SUBSCRIPTION_QUESTIONS) {
		let answer: boolean
		if (explicit.has(q.id)) {
			answer = explicit.get(q.id)!
			console.log(`  ${q.id}: ${answer ? 'yes' : 'no'} (from --flag)`)
		} else {
			const detected = connected.has(q.id)
			const def = detected ? 'Y/n' : 'y/N'
			const hint = q.hint ? `  — ${q.hint}` : ''
			const line = await ask(rl, `Do you have ${q.label}? [${def}]${hint} `)
			answer = normalizeYesNo(line, detected)
		}
		if (answer) chosen.add(q.id)
	}

	rl.close()
	return chosen
}

function ask(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
	return new Promise(resolve => rl.question(prompt, resolve))
}

function normalizeYesNo(line: string, defaultValue: boolean): boolean {
	const t = line.trim().toLowerCase()
	if (t === '') return defaultValue
	if (t === 'y' || t === 'yes' || t === '1' || t === 'true') return true
	if (t === 'n' || t === 'no' || t === '0' || t === 'false') return false
	return defaultValue
}

function printAssignmentsTable(assignments: AgentAssignment[]): void {
	console.log('\nResolved agent → model mapping:\n')
	const nameWidth = Math.max(...assignments.map(a => a.agent.length))
	for (const a of assignments) {
		console.log(`  ${a.agent.padEnd(nameWidth)}  ${a.model}`)
		if (a.fallback_models.length) {
			console.log(`  ${' '.repeat(nameWidth)}    ↳ fallbacks: ${a.fallback_models.join(', ')}`)
		}
	}
}

// ---------------------------------------------------------------------------
// status / reset / show-chains / preview
// ---------------------------------------------------------------------------

function printStatus(): void {
	const configPath = resolveConfigPath()
	const config = loadPluginConfig()
	const agents = config.agents ?? {}
	const names = Object.keys(agents).sort()

	console.log(`Config: ${configPath}`)
	if (!existsSync(configPath)) {
		console.log('(config file does not exist yet — it will be created on first plugin start)')
	}

	if (names.length === 0) {
		console.log(
			'\nNo per-agent model mappings configured.\n' +
				'Run `oc-forgecode setup-models install` to pick models interactively,\n' +
				'or start opencode with the forge plugin to trigger auto-setup.',
		)
		return
	}

	console.log('\nAgent model mappings:\n')
	for (const name of names) {
		const cfg = agents[name]!
		const fb = cfg.fallback_models?.length
			? (cfg.fallback_models as Array<string | { model: string }>)
					.map(f => (typeof f === 'string' ? f : f.model))
					.join(', ')
			: '(none)'
		console.log(`  ${name}`)
		console.log(`    model:     ${cfg.model ?? '(inherit primary)'}`)
		console.log(`    fallbacks: ${fb}`)
	}
}

function runReset(): void {
	const configPath = resolveConfigPath()
	if (!existsSync(configPath)) {
		console.error(`Config file not found: ${configPath}`)
		process.exit(1)
	}

	const raw = readFileSync(configPath, 'utf-8')
	const stripped = removeAgentsBlock(raw)
	if (stripped === null) {
		console.log('No "agents" block present — nothing to reset.')
		return
	}

	writeFileSync(configPath, stripped, 'utf-8')
	console.log(`Removed "agents" block from ${configPath}.`)
	console.log('Next plugin start (or `setup-models install`) will re-run auto-setup.')
}

/**
 * Strip a top-level `"agents": { ... }` block (and its leading comments/
 * trailing comma) from a JSONC string. Returns null if no block is found.
 */
export function removeAgentsBlock(raw: string): string | null {
	const startRe = /\n[\t ]*(?:\/\/[^\n]*\n[\t ]*)*"agents"\s*:\s*\{/
	const match = startRe.exec(raw)
	if (!match) return null

	const blockOpen = raw.indexOf('{', match.index + match[0].lastIndexOf('{'))
	if (blockOpen < 0) return null

	let depth = 0
	let inString = false
	let i = blockOpen
	for (; i < raw.length; i++) {
		const ch = raw[i]!
		if (inString) {
			if (ch === '\\') {
				i++
				continue
			}
			if (ch === '"') inString = false
			continue
		}
		if (ch === '"') inString = true
		else if (ch === '{') depth++
		else if (ch === '}') {
			depth--
			if (depth === 0) {
				i++
				break
			}
		}
	}
	if (depth !== 0) return null

	let blockEnd = i
	if (raw[blockEnd] === ',') blockEnd++

	const before = raw.slice(0, match.index)
	const after = raw.slice(blockEnd)
	return before.replace(/\n+$/, '\n') + after.replace(/^\n+/, '\n')
}

function printChains(): void {
	console.log('Per-agent model chains (first-matching-provider wins):\n')
	for (const [name, chain] of Object.entries(AGENT_CHAINS)) {
		console.log(`  ${name}`)
		console.log(`    ${chain.rationale}`)
		for (const entry of chain.chain) {
			const variant = entry.variant ? ` [${entry.variant}]` : ''
			console.log(`      ${entry.providers.join('|')}/${entry.model}${variant}`)
		}
		console.log()
	}
}

function runPreview(args: string[]): void {
	const flags = parseInstallFlags(args)
	const providers = flags.providers
		? new Set<string>(flags.providers)
		: new Set<string>(SUPPORTED_PROVIDERS as readonly string[])

	const config = loadPluginConfig()
	const assignments = computeAgentAssignments(providers, config, null, { overwrite: true })

	if (assignments.length === 0) {
		console.log('No chain entries matched for the given provider set.')
		return
	}

	console.log(`Previewing assignments for providers: ${[...providers].join(', ')}\n`)
	printAssignmentsTable(assignments)
	console.log('\n(Preview only — no files were written. Use `install` to persist.)')
}
