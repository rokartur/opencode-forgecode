import { tool } from '@opencode-ai/plugin'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ToolContext } from './types'
import { hashLine, parseAnchor } from '../utils/line-hash'

const z = tool.schema

/**
 * Hard limit on the total bytes of `newContent` across all patches in a single
 * call. Large tool-call payloads trigger provider stream timeouts ("Tool
 * execution aborted" / "The operation timed out"). For large rewrites the
 * model should use `edit` (targeted) or `write` (whole file) instead.
 */
const MAX_PATCH_PAYLOAD_BYTES = 32_000

export function createPatchTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
	const { directory, logger, config } = ctx
	if (config.harness?.hashAnchoredPatch === false) {
		return {}
	}

	return {
		patch: tool({
			description:
				'Apply small, hash-anchored line or range replacements atomically. Use ONLY for targeted edits where `newContent` is short (a few lines). For rewriting a function body, moving large blocks, or inserting many lines, prefer `edit` (find/replace) or `write` (whole file). Large `newContent` payloads can trigger provider stream timeouts. Fails if any anchor hash does not match the current file.',
			args: {
				file: z.string().describe('Absolute or workspace-relative path to the file to patch.'),
				patches: z
					.array(
						z.object({
							anchor: z.string().optional(),
							anchorStart: z.string().optional(),
							anchorEnd: z.string().optional(),
							newContent: z.string(),
						}),
					)
					.min(1)
					.describe('Ordered list of anchored replacements to apply. Keep each newContent small.'),
			},
			execute: async args => {
				// Reject oversized payloads up-front to steer the model toward `edit`/`write`
				// instead of streaming a huge tool-call that the provider will time out on.
				const totalBytes = args.patches.reduce((sum, p) => sum + Buffer.byteLength(p.newContent, 'utf8'), 0)
				if (totalBytes > MAX_PATCH_PAYLOAD_BYTES) {
					return `ERROR: patch payload too large (${totalBytes} bytes > ${MAX_PATCH_PAYLOAD_BYTES}). Use the \`edit\` tool for targeted find/replace, or \`write\` to rewrite the whole file.`
				}

				const absPath = args.file.startsWith('/') ? args.file : join(directory, args.file)

				let originalContent: string
				try {
					originalContent = await readFile(absPath, 'utf8')
				} catch (err) {
					return `ERROR: cannot read ${absPath}: ${(err as Error).message}`
				}

				const state = toMutableFileState(originalContent)
				const report: string[] = []

				for (let i = 0; i < args.patches.length; i++) {
					const patch = args.patches[i]
					try {
						if (patch.anchorStart || patch.anchorEnd) {
							if (!patch.anchorStart || !patch.anchorEnd) {
								return `ERROR: patch ${i + 1}/${args.patches.length} — anchorStart and anchorEnd must both be provided`
							}
							const start = parseAnchor(patch.anchorStart)
							const end = parseAnchor(patch.anchorEnd)
							verifyLineAnchor(state.lines, start)
							verifyLineAnchor(state.lines, end)
							if (end.line < start.line) {
								return `ERROR: patch ${i + 1}/${args.patches.length} — anchorEnd must be on or after anchorStart`
							}
							replaceRange(state.lines, start.line, end.line, patch.newContent)
							report.push(`patch ${i + 1}: lines ${start.line}-${end.line}`)
							continue
						}

						if (!patch.anchor) {
							return `ERROR: patch ${i + 1}/${args.patches.length} — anchor required for single-line patch`
						}

						const anchor = parseAnchor(patch.anchor)
						verifyLineAnchor(state.lines, anchor)
						replaceRange(state.lines, anchor.line, anchor.line, patch.newContent)
						report.push(`patch ${i + 1}: line ${anchor.line}`)
					} catch (err) {
						return `ERROR: patch ${i + 1}/${args.patches.length} — ${(err as Error).message}`
					}
				}

				const latestContent = await readFile(absPath, 'utf8')
				if (latestContent !== originalContent) {
					return `ERROR: concurrent modification detected for ${absPath}`
				}

				const nextContent = fromMutableFileState(state)
				const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
				try {
					await mkdir(dirname(absPath), { recursive: true })
					await writeFile(tmp, nextContent, 'utf8')
					await rename(tmp, absPath)
				} catch (err) {
					return `ERROR: atomic write failed: ${(err as Error).message}`
				}

				logger.log(`patch: ${absPath} (${report.length} patches)`)
				return `OK — ${absPath}\n${report.join('\n')}`
			},
		}),
	}
}

function verifyLineAnchor(lines: string[], anchor: { line: number; hash: string }): void {
	const current = lines[anchor.line - 1]
	if (current === undefined) {
		throw new Error(`anchor line ${anchor.line} is out of range`)
	}
	const currentAnchor = buildInlineAnchor(anchor.line, current)
	if (hashLine(current) !== anchor.hash) {
		throw new Error(`hash mismatch at ${anchor.line}; current is ${currentAnchor}`)
	}
}

function buildInlineAnchor(line: number, content: string): string {
	return `${line}#${hashLine(content)}: ${content}`
}

function replaceRange(lines: string[], startLine: number, endLine: number, newContent: string): void {
	const replacement = newContent === '' ? [] : newContent.split('\n')
	lines.splice(startLine - 1, endLine - startLine + 1, ...replacement)
}

function toMutableFileState(content: string): { lines: string[]; trailingNewline: boolean } {
	if (content === '') {
		return { lines: [], trailingNewline: false }
	}
	const trailingNewline = content.endsWith('\n')
	const lines = trailingNewline ? content.slice(0, -1).split('\n') : content.split('\n')
	return { lines, trailingNewline }
}

function fromMutableFileState(state: { lines: string[]; trailingNewline: boolean }): string {
	const content = state.lines.join('\n')
	if (state.trailingNewline && content !== '') {
		return `${content}\n`
	}
	return content
}
