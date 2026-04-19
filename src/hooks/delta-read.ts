/**
 * Delta-read hook — returns unified diffs instead of full file content when a
 * file is re-read within the same session.
 *
 * Follows the `before` + `after` + `pendingResults` interception pattern from
 * `host-tools.ts`. Uses an LRU mtime-based cache modelled on
 * `src/graph/cache.ts`.
 *
 * When a file was previously read in this session:
 *   - mtime unchanged → "File unchanged since last read"
 *   - mtime changed + diff < maxDiffChars → unified diff
 *   - mtime changed + diff ≥ maxDiffChars → full file (let builtin run)
 *
 * Excludes `.env*` files and binary extensions from caching.
 */

import { stat, readFile } from 'node:fs/promises'
import { resolve, basename } from 'node:path'
import type { Hooks } from '@opencode-ai/plugin'
import type { Logger } from '../types'

// --- Config types ---

export interface DeltaReadConfig {
	/** Enable delta-read mode. Defaults to true. */
	enabled?: boolean
	/** Max cached files per session. Defaults to 100. */
	maxCachePerSession?: number
	/** Max diff output in chars before falling back to full read. Defaults to 1500. */
	maxDiffChars?: number
	/** Glob patterns to exclude from caching. */
	excludePatterns?: string[]
}

// --- Internal types ---

interface CachedRead {
	content: string
	mtime: number
	readAt: number
}

interface DeltaReadDeps {
	logger: Logger
	cwd: string
	config?: DeltaReadConfig
}

// Per-session read cache
const sessionCaches = new Map<string, Map<string, CachedRead>>()
const pendingResults = new Map<string, { result: string; storedAt: number }>()
const STALE_THRESHOLD_MS = 5 * 60 * 1000

const BINARY_EXTS = new Set([
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.bmp',
	'.svg',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.otf',
	'.zip',
	'.gz',
	'.tar',
	'.bz2',
	'.7z',
	'.rar',
	'.pdf',
	'.doc',
	'.docx',
	'.xls',
	'.xlsx',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.o',
	'.a',
	'.mp3',
	'.mp4',
	'.wav',
	'.avi',
	'.mov',
	'.mkv',
	'.sqlite',
	'.db',
	'.wasm',
])

function isExcluded(filePath: string, excludePatterns: string[]): boolean {
	const name = basename(filePath)
	if (BINARY_EXTS.has(name.slice(name.lastIndexOf('.')))) return true
	for (const pat of excludePatterns) {
		if (pat.startsWith('.') && name.startsWith(pat)) return true
		if (name === pat) return true
	}
	return false
}

function getSessionCache(sessionId: string, maxSize: number): Map<string, CachedRead> {
	let cache = sessionCaches.get(sessionId)
	if (!cache) {
		cache = new Map()
		sessionCaches.set(sessionId, cache)
	}
	// Evict if over capacity
	if (cache.size >= maxSize) {
		const toEvict = Math.max(1, Math.floor(maxSize * 0.1))
		const iter = cache.keys()
		for (let i = 0; i < toEvict; i++) {
			const r = iter.next()
			if (r.done) break
			cache.delete(r.value)
		}
	}
	return cache
}

// --- Unified diff (minimal, no external deps) ---

function computeUnifiedDiff(oldContent: string, newContent: string, filePath: string): string {
	const oldLines = oldContent.split('\n')
	const newLines = newContent.split('\n')

	// Simple LCS-based diff producing unified format hunks
	const hunks: string[] = []
	hunks.push(`--- a/${filePath}`)
	hunks.push(`+++ b/${filePath}`)

	let oi = 0
	let ni = 0
	let hunkLines: string[] = []
	let hunkOldStart = 1
	let hunkNewStart = 1
	let hunkOldCount = 0
	let hunkNewCount = 0
	let contextBefore: string[] = []

	function flushHunk() {
		if (hunkLines.length === 0) return
		hunks.push(`@@ -${hunkOldStart},${hunkOldCount} +${hunkNewStart},${hunkNewCount} @@`)
		hunks.push(...hunkLines)
		hunkLines = []
		hunkOldCount = 0
		hunkNewCount = 0
	}

	while (oi < oldLines.length || ni < newLines.length) {
		if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
			// Context line
			if (hunkLines.length > 0) {
				hunkLines.push(` ${oldLines[oi]}`)
				hunkOldCount++
				hunkNewCount++
				// After 3 context lines post-change, flush hunk
				contextBefore.push(oldLines[oi])
				if (contextBefore.length >= 3) {
					flushHunk()
					contextBefore = []
				}
			} else {
				contextBefore.push(oldLines[oi])
				if (contextBefore.length > 3) contextBefore.shift()
			}
			oi++
			ni++
		} else {
			// Start of change — add context-before if this is a new hunk
			if (hunkLines.length === 0) {
				hunkOldStart = oi - contextBefore.length + 1
				hunkNewStart = ni - contextBefore.length + 1
				for (const ctx of contextBefore) {
					hunkLines.push(` ${ctx}`)
					hunkOldCount++
					hunkNewCount++
				}
			}
			contextBefore = []

			// Consume differing lines
			if (oi < oldLines.length && (ni >= newLines.length || oldLines[oi] !== newLines[ni])) {
				// Check if old line exists somewhere nearby in new
				let foundInNew = false
				for (let look = ni; look < Math.min(ni + 10, newLines.length); look++) {
					if (oldLines[oi] === newLines[look]) {
						// Add new lines before the match
						for (let j = ni; j < look; j++) {
							hunkLines.push(`+${newLines[j]}`)
							hunkNewCount++
						}
						ni = look
						foundInNew = true
						break
					}
				}
				if (!foundInNew) {
					// Check if new line exists somewhere nearby in old
					let foundInOld = false
					if (ni < newLines.length) {
						for (let look = oi; look < Math.min(oi + 10, oldLines.length); look++) {
							if (newLines[ni] === oldLines[look]) {
								// Add removed lines before the match
								for (let j = oi; j < look; j++) {
									hunkLines.push(`-${oldLines[j]}`)
									hunkOldCount++
								}
								oi = look
								foundInOld = true
								break
							}
						}
					}
					if (!foundInOld) {
						// Simple replacement
						if (oi < oldLines.length) {
							hunkLines.push(`-${oldLines[oi]}`)
							hunkOldCount++
							oi++
						}
						if (ni < newLines.length) {
							hunkLines.push(`+${newLines[ni]}`)
							hunkNewCount++
							ni++
						}
					}
				}
			} else if (ni < newLines.length) {
				hunkLines.push(`+${newLines[ni]}`)
				hunkNewCount++
				ni++
			}
		}
	}

	flushHunk()

	if (hunks.length <= 2) {
		// Only header, no actual diff — shouldn't happen but safety net
		return ''
	}

	return hunks.join('\n')
}

// --- Hook factories ---

export function createDeltaReadBeforeHook(deps: DeltaReadDeps): Hooks['tool.execute.before'] {
	const enabled = deps.config?.enabled !== false
	const maxCache = deps.config?.maxCachePerSession ?? 100
	const maxDiff = deps.config?.maxDiffChars ?? 1500
	const excludes = deps.config?.excludePatterns ?? ['.env']

	return async (
		input: { tool: string; sessionID: string; callID: string },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		output: { args: any },
	) => {
		if (!enabled) return
		if (input.tool !== 'read') return

		const args = output.args ?? {}
		const filePath = String(args.filePath ?? args.path ?? args.file ?? '')
		if (!filePath) return

		const absPath = resolve(deps.cwd, filePath)
		if (isExcluded(absPath, excludes)) return

		const cache = getSessionCache(input.sessionID, maxCache)
		const cached = cache.get(absPath)
		if (!cached) return // First read — let it go through, cache in after

		try {
			const s = await stat(absPath)
			const currentMtime = s.mtimeMs

			if (cached.mtime === currentMtime) {
				// File unchanged
				const ago = Math.round((Date.now() - cached.readAt) / 1000)
				const msg = `File unchanged since last read (${ago}s ago). Content is identical to the previous read.`
				pendingResults.set(input.callID, { result: msg, storedAt: Date.now() })
				output.args = { ...args, filePath: '__forge_delta_noop__' }
				return
			}

			// File changed — compute diff
			const newContent = await readFile(absPath, 'utf-8')
			const diff = computeUnifiedDiff(cached.content, newContent, filePath)

			if (diff.length > 0 && diff.length < maxDiff) {
				// Small diff — use it
				const header = `File changed since last read. Delta (unified diff):\n`
				pendingResults.set(input.callID, { result: header + diff, storedAt: Date.now() })
				// Update cache with new content
				cache.set(absPath, { content: newContent, mtime: currentMtime, readAt: Date.now() })
				output.args = { ...args, filePath: '__forge_delta_noop__' }
				return
			}

			// Large diff — let full read proceed, update cache in after hook
			cache.set(absPath, { content: newContent, mtime: currentMtime, readAt: Date.now() })
		} catch {
			// stat/read failed — let builtin handle it
		}
	}
}

export function createDeltaReadAfterHook(deps: DeltaReadDeps): Hooks['tool.execute.after'] {
	const enabled = deps.config?.enabled !== false
	const maxCache = deps.config?.maxCachePerSession ?? 100
	const excludes = deps.config?.excludePatterns ?? ['.env']

	return async (
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		input: { tool: string; sessionID: string; callID: string; args: any },
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		output: { title: string; output: string; metadata: any },
	) => {
		if (!enabled) return
		if (input.tool !== 'read') return

		// Stale cleanup
		const now = Date.now()
		for (const [key, entry] of pendingResults) {
			if (now - entry.storedAt > STALE_THRESHOLD_MS) pendingResults.delete(key)
		}

		// Check for pending delta result
		const entry = pendingResults.get(input.callID)
		if (entry) {
			pendingResults.delete(input.callID)
			deps.logger.log(`[delta-read] serving delta for callID ${input.callID}`)
			output.output = entry.result
			return
		}

		// No pending result — this was a fresh/full read. Cache the output.
		if (!output.output || typeof output.output !== 'string') return
		const args = input.args ?? {}
		const filePath = String(args.filePath ?? args.path ?? args.file ?? '')
		if (!filePath) return

		const absPath = resolve(deps.cwd, filePath)
		if (isExcluded(absPath, excludes)) return

		try {
			const s = await stat(absPath)
			const cache = getSessionCache(input.sessionID, maxCache)
			cache.set(absPath, { content: output.output, mtime: s.mtimeMs, readAt: Date.now() })
		} catch {
			// Ignore — file may have been deleted between read and after hook
		}
	}
}

/** Clears all session caches and pending results. Test-only. */
export function __resetDeltaReadForTests(): void {
	sessionCaches.clear()
	pendingResults.clear()
}

/** Clears cache for a specific session. Used on session cleanup. */
export function clearDeltaReadSession(sessionId: string): void {
	sessionCaches.delete(sessionId)
}
