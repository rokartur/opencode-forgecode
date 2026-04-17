/**
 * Filesystem snapshot tracking for the forge harness.
 *
 * Records a `.bak` copy of every file touched by mutating tools
 * (`write` / `edit` / `multi_patch`) in `tool.execute.before` and exposes a
 * lookup used by the `fs_undo` tool to roll back.
 *
 * Storage layout (user preference: under the plugin data dir):
 *   <dataDir>/snapshots/<sessionId>/<ts>-<fileTag>.bak
 *
 * `fileTag` is the workspace-relative path with non-alphanumerics replaced by
 * underscores, matching the legacy forgecode layout so existing snapshots
 * remain restorable after the path move.
 */

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

export const SNAPSHOTS_SUBDIR = 'snapshots'

export interface SnapshotLocation {
	dataDir: string
	sessionId: string
	workingDir: string
}

export interface SnapshotEntry {
	sessionDir: string
	entry: string
	ts: number
}

export function fileTag(relPath: string): string {
	return relPath.replace(/[^a-zA-Z0-9]/g, '_')
}

export function snapshotsRoot(dataDir: string): string {
	return join(dataDir, SNAPSHOTS_SUBDIR)
}

export function sessionSnapshotsDir(dataDir: string, sessionId: string): string {
	return join(snapshotsRoot(dataDir), sessionId)
}

/**
 * Capture the current content of `absPath` into a snapshot file. No-op when
 * the file does not exist (e.g. a new `write` creating a file for the first
 * time — nothing to roll back to).
 */
export async function captureSnapshot(absPath: string, loc: SnapshotLocation): Promise<string | null> {
	let existing: Buffer
	try {
		const s = await stat(absPath)
		if (!s.isFile()) return null
		existing = await readFile(absPath)
	} catch {
		return null
	}
	const dir = sessionSnapshotsDir(loc.dataDir, loc.sessionId)
	await mkdir(dir, { recursive: true })
	const rel = relative(loc.workingDir, absPath)
	const entry = `${Date.now()}-${fileTag(rel)}.bak`
	const full = join(dir, entry)
	await writeFile(full, existing)
	return full
}

/**
 * List all snapshots for a specific workspace-relative file across every
 * session under `dataDir`, newest first.
 */
export async function findSnapshots(dataDir: string, workingDir: string, file: string): Promise<SnapshotEntry[]> {
	const target = resolve(workingDir, file)
	const rel = relative(workingDir, target)
	const tag = fileTag(rel)
	const root = snapshotsRoot(dataDir)
	let sessions: string[]
	try {
		sessions = await readdir(root)
	} catch {
		return []
	}
	const out: SnapshotEntry[] = []
	for (const s of sessions) {
		const sessionDir = join(root, s)
		let entries: string[]
		try {
			entries = await readdir(sessionDir)
		} catch {
			continue
		}
		for (const entry of entries) {
			const m = entry.match(/^(\d+)-(.+)\.bak$/)
			if (!m) continue
			if (m[2] !== tag) continue
			out.push({ sessionDir, entry, ts: parseInt(m[1], 10) })
		}
	}
	out.sort((a, b) => b.ts - a.ts)
	return out
}

/**
 * Restore the content stored at the given snapshot entry back onto `absPath`.
 * Returns the timestamp recorded on the snapshot.
 */
export async function restoreSnapshot(absPath: string, snap: SnapshotEntry): Promise<number> {
	const prior = await readFile(join(snap.sessionDir, snap.entry))
	await writeFile(absPath, prior)
	return snap.ts
}
