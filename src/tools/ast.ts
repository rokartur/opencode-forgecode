/**
 * AST-aware tools — wrapper over `ast-grep` (`sg`) binary for structural
 * code search and rewrite.
 *
 * Gracefully degrades when `sg` is not installed: tools return an
 * "unavailable" message instead of crashing.
 */

import { tool } from '@opencode-ai/plugin'
import { spawnSync } from 'child_process'
import type { ToolContext } from './types'

const z = tool.schema

/** Check whether the `sg` binary is available. */
function isSgAvailable(): { available: boolean; version?: string; reason?: string } {
	try {
		const result = spawnSync('sg', ['--version'], {
			timeout: 5000,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		if (result.status === 0 && result.stdout) {
			return { available: true, version: result.stdout.trim() }
		}
		return { available: false, reason: result.stderr?.trim() || 'sg exited with non-zero status' }
	} catch {
		return { available: false, reason: 'sg binary not found in PATH' }
	}
}

/** Run `sg` with given args and return stdout. */
function runSg(
	args: string[],
	cwd: string,
	timeoutMs = 30_000,
): { ok: true; stdout: string } | { ok: false; error: string } {
	try {
		const result = spawnSync('sg', args, {
			cwd,
			timeout: timeoutMs,
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'pipe'],
			maxBuffer: 1024 * 1024, // 1 MB
		})
		if (result.error) {
			return { ok: false, error: result.error.message }
		}
		if (result.status !== 0 && !result.stdout) {
			return { ok: false, error: result.stderr?.trim() || `sg exited with code ${result.status}` }
		}
		return { ok: true, stdout: result.stdout }
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) }
	}
}

const UNAVAILABLE_MSG =
	'ast-grep (`sg`) is not installed. Install it via `npm i -g @ast-grep/cli` or `brew install ast-grep` for AST-aware search.'

export function createAstTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
	const { directory, logger } = ctx
	let sgStatus: ReturnType<typeof isSgAvailable> | null = null

	function ensureSg(): string | null {
		if (!sgStatus) sgStatus = isSgAvailable()
		if (!sgStatus.available) return sgStatus.reason ?? UNAVAILABLE_MSG
		return null
	}

	return {
		'ast-search': tool({
			description:
				'Search code using AST patterns via ast-grep. Finds structural matches (not just text). Requires `sg` binary.',
			args: {
				pattern: z.string().describe('AST pattern to search for (ast-grep pattern syntax)'),
				lang: z
					.enum([
						'typescript',
						'javascript',
						'python',
						'rust',
						'go',
						'java',
						'c',
						'cpp',
						'ruby',
						'swift',
						'kotlin',
					])
					.describe('Language of the pattern'),
				path: z.string().optional().describe('Restrict search to this path (relative to project root)'),
			},
			execute: async args => {
				const unavailable = ensureSg()
				if (unavailable) return UNAVAILABLE_MSG

				const sgArgs = ['run', '--pattern', args.pattern, '--lang', args.lang, '--json']
				if (args.path) {
					sgArgs.push(args.path)
				}

				logger.log(`[ast-search] pattern="${args.pattern}" lang=${args.lang} path=${args.path ?? '.'}`)
				const result = runSg(sgArgs, directory)

				if (!result.ok) return `ast-search error: ${result.error}`

				try {
					const matches = JSON.parse(result.stdout) as Array<{
						text: string
						range: { start: { line: number; column: number }; end: { line: number; column: number } }
						file: string
					}>

					if (matches.length === 0) return 'No AST matches found.'

					const MAX_RESULTS = 50
					const shown = matches.slice(0, MAX_RESULTS)
					const lines = shown.map(m => {
						const loc = `${m.file}:${m.range.start.line + 1}:${m.range.start.column + 1}`
						const text = m.text.length > 120 ? m.text.slice(0, 120) + '...' : m.text
						return `**${loc}**\n\`\`\`\n${text}\n\`\`\``
					})

					let output = `Found ${matches.length} match(es):\n\n${lines.join('\n\n')}`
					if (matches.length > MAX_RESULTS) {
						output += `\n\n... and ${matches.length - MAX_RESULTS} more matches (showing first ${MAX_RESULTS})`
					}
					return output
				} catch {
					// If JSON parse fails, return raw output
					return result.stdout.slice(0, 4000)
				}
			},
		}),

		'ast-rewrite': tool({
			description:
				'Rewrite code using AST patterns via ast-grep. Returns a diff preview (dry run). Requires `sg` binary.',
			args: {
				pattern: z.string().describe('AST pattern to match'),
				rewrite: z.string().describe('Replacement pattern (can use $VAR for captured metavariables)'),
				lang: z
					.enum([
						'typescript',
						'javascript',
						'python',
						'rust',
						'go',
						'java',
						'c',
						'cpp',
						'ruby',
						'swift',
						'kotlin',
					])
					.describe('Language of the pattern'),
				path: z.string().optional().describe('Restrict to this path (relative to project root)'),
				apply: z
					.boolean()
					.optional()
					.default(false)
					.describe('Actually apply changes (default: dry run / preview)'),
			},
			execute: async args => {
				const unavailable = ensureSg()
				if (unavailable) return UNAVAILABLE_MSG

				const sgArgs = ['run', '--pattern', args.pattern, '--rewrite', args.rewrite, '--lang', args.lang]

				if (!args.apply) {
					// Dry run mode — just show what would change
					sgArgs.push('--json')
				} else {
					sgArgs.push('--update-all')
				}

				if (args.path) {
					sgArgs.push(args.path)
				}

				logger.log(
					`[ast-rewrite] pattern="${args.pattern}" rewrite="${args.rewrite}" lang=${args.lang} apply=${args.apply}`,
				)
				const result = runSg(sgArgs, directory)

				if (!result.ok) return `ast-rewrite error: ${result.error}`

				if (!args.apply) {
					// Parse JSON output for preview
					try {
						const matches = JSON.parse(result.stdout) as Array<{
							text: string
							replacement: string
							file: string
							range: { start: { line: number } }
						}>

						if (matches.length === 0) return 'No matches found for the pattern.'

						const lines = matches.slice(0, 20).map(m => {
							return `**${m.file}:${m.range.start.line + 1}**\n- Before: \`${m.text.slice(0, 80)}\`\n+ After:  \`${(m.replacement ?? '').slice(0, 80)}\``
						})

						let output = `Would rewrite ${matches.length} match(es):\n\n${lines.join('\n\n')}`
						if (matches.length > 20) {
							output += `\n\n... and ${matches.length - 20} more`
						}
						output += '\n\nRe-run with `apply: true` to apply changes.'
						return output
					} catch {
						return result.stdout.slice(0, 4000)
					}
				}

				return result.stdout
					? `Applied rewrites:\n${result.stdout.slice(0, 4000)}`
					: 'Rewrites applied successfully (no diff output).'
			},
		}),
	}
}
