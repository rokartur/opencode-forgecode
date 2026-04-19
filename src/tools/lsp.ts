/**
 * LSP tools — expose language-server features as agent-callable tools.
 *
 * Each tool lazily acquires a client from the LspPool. If no server
 * is available for the file's language, the tool returns a human-readable
 * "unavailable" message rather than failing.
 */

import { tool } from '@opencode-ai/plugin'
import { readFileSync } from 'fs'
import { extname, resolve, isAbsolute } from 'path'
import { pathToFileURL } from 'url'
import type { LspPool } from '../runtime/lsp/pool'
import type { ToolContext } from './types'

const z = tool.schema

/** Crude extension → languageId map. */
const EXT_TO_LANG: Record<string, string> = {
	'.ts': 'typescript',
	'.tsx': 'typescriptreact',
	'.js': 'javascript',
	'.jsx': 'javascriptreact',
	'.py': 'python',
	'.rs': 'rust',
	'.go': 'go',
}

function langFromFile(file: string): string | null {
	return EXT_TO_LANG[extname(file)] ?? null
}

/** Resolve file path to absolute, read content, return uri + lang. */
function resolveFile(file: string, directory: string): { uri: string; lang: string; text: string } | { error: string } {
	const lang = langFromFile(file)
	if (!lang) return { error: `Cannot determine language for ${file}` }
	const abs = isAbsolute(file) ? file : resolve(directory, file)
	try {
		const text = readFileSync(abs, 'utf-8')
		return { uri: pathToFileURL(abs).href, lang, text }
	} catch (err) {
		return { error: `Cannot read ${abs}: ${err instanceof Error ? err.message : String(err)}` }
	}
}

const NO_SERVER = (lang: string) =>
	`No LSP server available for language "${lang}". Ensure the server binary is installed and in PATH.`

export function createLspTools(
	ctx: ToolContext & { lspPool: LspPool | null },
): Record<string, ReturnType<typeof tool>> {
	const { directory, lspPool } = ctx

	if (!lspPool) {
		// Return stub tools that explain LSP is disabled
		const disabled = 'LSP tooling is disabled. Enable it via `lsp.enabled: true` in forge-config.'
		return {
			'lsp-diagnostics': tool({
				description: 'Get diagnostics (errors/warnings) for a file via LSP.',
				args: { file: z.string().describe('File path relative to project root') },
				execute: async () => disabled,
			}),
			'lsp-definition': tool({
				description: 'Go to definition of a symbol at a position.',
				args: {
					file: z.string(),
					line: z.number(),
					character: z.number(),
				},
				execute: async () => disabled,
			}),
			'lsp-references': tool({
				description: 'Find all references to a symbol at a position.',
				args: {
					file: z.string(),
					line: z.number(),
					character: z.number(),
				},
				execute: async () => disabled,
			}),
			'lsp-hover': tool({
				description: 'Get hover info for a symbol at a position.',
				args: {
					file: z.string(),
					line: z.number(),
					character: z.number(),
				},
				execute: async () => disabled,
			}),
			'lsp-code-actions': tool({
				description: 'Get available code actions for a range.',
				args: {
					file: z.string(),
					startLine: z.number(),
					startCharacter: z.number(),
					endLine: z.number(),
					endCharacter: z.number(),
				},
				execute: async () => disabled,
			}),
			'lsp-rename': tool({
				description: 'Compute a rename refactoring (returns workspace edit, does not apply).',
				args: {
					file: z.string(),
					line: z.number(),
					character: z.number(),
					newName: z.string(),
				},
				execute: async () => disabled,
			}),
		}
	}

	/** Helper: get client + open file. */
	async function withClient(
		file: string,
		fn: (client: Awaited<ReturnType<LspPool['get']>>, uri: string) => Promise<string>,
	): Promise<string> {
		const resolved = resolveFile(file, directory)
		if ('error' in resolved) return resolved.error

		const client = await lspPool!.get(resolved.lang)
		if (!client) return NO_SERVER(resolved.lang)

		await client.didOpen(resolved.uri, resolved.lang, resolved.text)
		return fn(client, resolved.uri)
	}

	return {
		'lsp-diagnostics': tool({
			description: 'Get diagnostics (errors, warnings) for a file from the language server.',
			args: {
				file: z.string().describe('File path relative to project root'),
			},
			execute: async args => {
				return withClient(args.file, async (client, uri) => {
					const diags = await client!.getDiagnostics(uri)
					if (diags.length === 0) return `No diagnostics for ${args.file}.`

					const severityMap = ['', 'Error', 'Warning', 'Information', 'Hint']
					return diags
						.map(d => {
							const sev = severityMap[d.severity ?? 0] || 'Unknown'
							const src = d.source ? ` (${d.source})` : ''
							return `[${sev}] ${args.file}:${d.range.start.line + 1}:${d.range.start.character + 1} — ${d.message}${src}`
						})
						.join('\n')
				})
			},
		}),

		'lsp-definition': tool({
			description: 'Go to the definition of a symbol at a given position. Returns file locations.',
			args: {
				file: z.string().describe('File path'),
				line: z.number().describe('0-based line number'),
				character: z.number().describe('0-based character offset'),
			},
			execute: async args => {
				return withClient(args.file, async (client, uri) => {
					const locs = await client!.getDefinition(uri, args.line, args.character)
					if (locs.length === 0) return 'No definition found.'
					return locs.map(l => `${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n')
				})
			},
		}),

		'lsp-references': tool({
			description: 'Find all references to a symbol at a given position.',
			args: {
				file: z.string().describe('File path'),
				line: z.number().describe('0-based line number'),
				character: z.number().describe('0-based character offset'),
			},
			execute: async args => {
				return withClient(args.file, async (client, uri) => {
					const locs = await client!.getReferences(uri, args.line, args.character)
					if (locs.length === 0) return 'No references found.'
					return (
						`${locs.length} reference(s):\n` +
						locs.map(l => `- ${l.uri}:${l.range.start.line + 1}:${l.range.start.character + 1}`).join('\n')
					)
				})
			},
		}),

		'lsp-hover': tool({
			description: 'Get hover/type information for a symbol at a given position.',
			args: {
				file: z.string().describe('File path'),
				line: z.number().describe('0-based line number'),
				character: z.number().describe('0-based character offset'),
			},
			execute: async args => {
				return withClient(args.file, async (client, uri) => {
					const hover = await client!.getHover(uri, args.line, args.character)
					if (!hover) return 'No hover info available.'
					if (typeof hover.contents === 'string') return hover.contents
					if (Array.isArray(hover.contents)) {
						return hover.contents.map(c => (typeof c === 'string' ? c : c.value)).join('\n\n')
					}
					return hover.contents.value
				})
			},
		}),

		'lsp-code-actions': tool({
			description: 'Get available code actions (quick fixes, refactorings) for a range.',
			args: {
				file: z.string().describe('File path'),
				startLine: z.number().describe('0-based start line'),
				startCharacter: z.number().describe('0-based start character'),
				endLine: z.number().describe('0-based end line'),
				endCharacter: z.number().describe('0-based end character'),
			},
			execute: async args => {
				return withClient(args.file, async (client, uri) => {
					const range = {
						start: { line: args.startLine, character: args.startCharacter },
						end: { line: args.endLine, character: args.endCharacter },
					}
					const actions = await client!.getCodeActions(uri, range, [])
					if (actions.length === 0) return 'No code actions available.'
					return actions
						.map(a => {
							const kind = a.kind ? ` [${a.kind}]` : ''
							const pref = a.isPreferred ? ' ★' : ''
							return `- ${a.title}${kind}${pref}`
						})
						.join('\n')
				})
			},
		}),

		'lsp-rename': tool({
			description:
				'Compute a rename refactoring. Returns the workspace edit (does not apply it). Use patch tool to apply.',
			args: {
				file: z.string().describe('File path'),
				line: z.number().describe('0-based line number'),
				character: z.number().describe('0-based character offset'),
				newName: z.string().describe('New name for the symbol'),
			},
			execute: async args => {
				return withClient(args.file, async (client, uri) => {
					const edit = await client!.rename(uri, args.line, args.character, args.newName)
					if (!edit || !edit.changes) return 'No rename result — symbol may not be renameable.'

					const entries = Object.entries(edit.changes)
					const lines: string[] = [`Rename to "${args.newName}" affects ${entries.length} file(s):\n`]
					for (const [fileUri, edits] of entries) {
						lines.push(`**${fileUri}** (${edits.length} edit(s))`)
						for (const e of edits.slice(0, 10)) {
							lines.push(`  L${e.range.start.line + 1}:${e.range.start.character + 1} → "${e.newText}"`)
						}
						if (edits.length > 10) lines.push(`  ... and ${edits.length - 10} more`)
					}
					return lines.join('\n')
				})
			},
		}),
	}
}
