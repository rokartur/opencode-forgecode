import { tool } from '@opencode-ai/plugin'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { ToolContext } from './types'
import { findSnapshots, restoreSnapshot } from '../harness/snapshot'

const z = tool.schema

/**
 * Harness-provided tools: atomic multi-file patching and snapshot-based undo.
 *
 * Both tools participate in the snapshot system wired in `hooks/harness.ts`:
 * `multi_patch` mutations are snapshotted in `tool.execute.before`, and
 * `fs_undo` restores from those snapshots via `findSnapshots`/`restoreSnapshot`.
 */
export function createHarnessTools(ctx: ToolContext): Record<string, ReturnType<typeof tool>> {
	const { directory, dataDir, logger } = ctx

	return {
		multi_patch: tool({
			description:
				'Apply multiple text replacements to a single file atomically. Each patch has oldString, newString and an optional replaceAll flag. If any patch fails to match, no changes are written. Returns a summary of changes with line-level context.',
			args: {
				file: z.string().describe('Absolute or workspace-relative path to the file to patch.'),
				patches: z
					.array(
						z.object({
							oldString: z.string(),
							newString: z.string(),
							replaceAll: z.boolean().optional(),
						}),
					)
					.min(1)
					.describe('Ordered list of replacements to apply.'),
			},
			execute: async args => {
				const absPath = args.file.startsWith('/') ? args.file : join(directory, args.file)

				let originalContent: string
				try {
					originalContent = await readFile(absPath, 'utf8')
				} catch (err) {
					return `ERROR: cannot read ${absPath}: ${(err as Error).message}`
				}

				let content = originalContent
				const report: string[] = []
				for (let i = 0; i < args.patches.length; i++) {
					const { oldString, newString, replaceAll } = args.patches[i]
					if (!content.includes(oldString)) {
						return `ERROR: patch ${i + 1}/${args.patches.length} — oldString not found in ${absPath}`
					}
					if (!replaceAll) {
						const first = content.indexOf(oldString)
						const last = content.lastIndexOf(oldString)
						if (first !== last) {
							return `ERROR: patch ${i + 1}/${args.patches.length} — oldString matches multiple times; set replaceAll=true or provide more context`
						}
						// Report line number for context
						const lineNum = content.slice(0, first).split('\n').length
						content = content.slice(0, first) + newString + content.slice(first + oldString.length)
						report.push(`patch ${i + 1}: 1 replacement at line ${lineNum}`)
					} else {
						const parts = content.split(oldString)
						const n = parts.length - 1
						content = parts.join(newString)
						report.push(`patch ${i + 1}: ${n} replacements`)
					}
				}

				// Concurrent modification guard: re-read and compare
				const latestContent = await readFile(absPath, 'utf8')
				if (latestContent !== originalContent) {
					return `ERROR: concurrent modification detected for ${absPath}`
				}

				const tmp = `${absPath}.${randomBytes(6).toString('hex')}.tmp`
				try {
					await mkdir(dirname(absPath), { recursive: true })
					await writeFile(tmp, content, 'utf8')
					await rename(tmp, absPath)
				} catch (err) {
					return `ERROR: atomic write failed: ${(err as Error).message}`
				}
				logger.log(`multi_patch: ${absPath} (${report.length} patches)`)
				return `OK — ${absPath}\n${report.join('\n')}`
			},
		}),

		fs_undo: tool({
			description:
				"Revert a file to a previous forge-tracked snapshot. 'steps' defaults to 1 (the most recent snapshot for that file).",
			args: {
				file: z.string(),
				steps: z.number().int().positive().optional(),
			},
			execute: async args => {
				const target = resolve(directory, args.file)
				const rel = relative(directory, target)
				const steps = args.steps ?? 1

				const snapshots = await findSnapshots(dataDir, directory, rel)
				if (snapshots.length < steps) {
					return `ERROR: only ${snapshots.length} snapshot(s) available for ${args.file}`
				}
				const pick = snapshots[steps - 1]
				const ts = await restoreSnapshot(target, pick)
				logger.log(`fs_undo: restored ${args.file} from snapshot ts=${ts}`)
				return `OK — restored ${args.file} from snapshot ts=${ts}`
			},
		}),
	}
}
