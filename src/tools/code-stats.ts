/**
 * `code-stats` tool — language / LOC summary via `tokei` → `scc` → ripgrep
 * file listing as successive fallbacks. Gracefully reports "unavailable" when
 * none of the binaries are installed.
 */

import { tool } from '@opencode-ai/plugin'
import { spawnSync } from 'child_process'
import type { ToolContext } from './types'

const z = tool.schema
const TIMEOUT_MS = 30_000
const MAX_BUFFER = 10 * 1024 * 1024

type Backend = 'tokei' | 'scc' | 'rg'

let detected: { backend: Backend; version?: string } | null | undefined

function detect(): { backend: Backend; version?: string } | null {
	if (detected !== undefined) return detected
	for (const candidate of ['tokei', 'scc', 'rg'] as const) {
		try {
			const r = spawnSync(candidate, ['--version'], {
				timeout: 5000,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			})
			if (r.status === 0 && r.stdout) {
				detected = { backend: candidate, version: r.stdout.split('\n')[0]?.trim() }
				return detected
			}
		} catch {
			// keep trying
		}
	}
	detected = null
	return null
}

/** Test helper — clears the memoised backend probe. */
export function __resetCodeStatsBackendForTests(): void {
	detected = undefined
}

function runTokei(path: string): string {
	const r = spawnSync('tokei', ['--output', 'json', path], {
		timeout: TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (r.error) return `tokei failed: ${r.error.message}`
	if (!r.stdout) return r.stderr?.trim() || 'tokei produced no output'
	return renderTokei(r.stdout)
}

function renderTokei(stdout: string): string {
	try {
		const data = JSON.parse(stdout) as Record<
			string,
			{ code?: number; comments?: number; blanks?: number; reports?: { name?: string }[] }
		>
		const rows: Array<{ lang: string; code: number; comments: number; files: number }> = []
		for (const [lang, stats] of Object.entries(data)) {
			if (lang === 'Total') continue
			rows.push({
				lang,
				code: stats.code ?? 0,
				comments: stats.comments ?? 0,
				files: stats.reports?.length ?? 0,
			})
		}
		rows.sort((a, b) => b.code - a.code)
		const total = rows.reduce((s, r) => s + r.code, 0)
		const totalFiles = rows.reduce((s, r) => s + r.files, 0)
		const head = `Language stats (tokei) — ${rows.length} langs, ${totalFiles} files, ${total} LOC`
		const body = rows.map(
			r =>
				`  ${r.lang.padEnd(16)} files=${r.files.toString().padStart(5)} code=${r.code.toString().padStart(8)} comments=${r.comments}`,
		)
		return [head, ...body].join('\n')
	} catch {
		return stdout.trim()
	}
}

function runScc(path: string): string {
	const r = spawnSync('scc', ['--format', 'json', path], {
		timeout: TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (r.error) return `scc failed: ${r.error.message}`
	if (!r.stdout) return r.stderr?.trim() || 'scc produced no output'
	try {
		const data = JSON.parse(r.stdout) as Array<{ Name: string; Count: number; Code: number; Comment: number }>
		data.sort((a, b) => b.Code - a.Code)
		const total = data.reduce((s, x) => s + x.Code, 0)
		const totalFiles = data.reduce((s, x) => s + x.Count, 0)
		const head = `Language stats (scc) — ${data.length} langs, ${totalFiles} files, ${total} LOC`
		const body = data.map(
			x =>
				`  ${x.Name.padEnd(16)} files=${x.Count.toString().padStart(5)} code=${x.Code.toString().padStart(8)} comments=${x.Comment}`,
		)
		return [head, ...body].join('\n')
	} catch {
		return r.stdout.trim()
	}
}

function runRgFallback(path: string): string {
	const r = spawnSync('rg', ['--files', '--hidden', '--no-messages', path], {
		timeout: TIMEOUT_MS,
		encoding: 'utf-8',
		maxBuffer: MAX_BUFFER,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	if (r.error) return `rg failed: ${r.error.message}`
	const lines = (r.stdout ?? '').split('\n').filter(Boolean)
	const extCount = new Map<string, number>()
	for (const line of lines) {
		const dot = line.lastIndexOf('.')
		const ext = dot > 0 ? line.slice(dot) : '(none)'
		extCount.set(ext, (extCount.get(ext) ?? 0) + 1)
	}
	const rows = [...extCount.entries()].sort((a, b) => b[1] - a[1])
	const head = `File-type stats (rg fallback — install tokei or scc for LOC) — ${lines.length} files, ${rows.length} extensions`
	const body = rows.map(([ext, n]) => `  ${ext.padEnd(16)} files=${n}`)
	return [head, ...body].join('\n')
}

export function createCodeStatsTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
	const { directory } = ctx

	return {
		'code-stats': tool({
			description:
				'Language / LOC summary for a codebase. Uses `tokei` (preferred), falls back to `scc`, then to a ripgrep-based file-extension histogram. Prefer this over `bash find | wc`.',
			args: {
				path: z
					.string()
					.optional()
					.describe('Subdirectory to analyse (absolute or relative to cwd). Defaults to the project root.'),
			},
			async execute(args: { path?: string }) {
				const target = args.path ?? directory
				const backend = detect()
				if (!backend) {
					return 'code-stats: no backend available. Install `tokei` (`brew install tokei` / `cargo install tokei`) or `scc` for language/LOC stats.'
				}
				switch (backend.backend) {
					case 'tokei':
						return runTokei(target)
					case 'scc':
						return runScc(target)
					case 'rg':
						return runRgFallback(target)
				}
			},
		}),
	}
}
