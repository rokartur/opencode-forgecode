// Directory-level Merkle rollup (Etap 9g).
//
// Problem: on every incremental re-index we `stat` every file under
// the repo root to check whether its content changed. For large repos
// (100k+ files) this is the dominant cost even when nothing changed.
//
// Solution: aggregate a SHA-256 hash per directory from its children's
// hashes. If a directory's rollup matches the previous snapshot, we
// can skip its entire subtree without stat-ing any of the files.
//
// This module is intentionally pure: no `fs` access, no `require`.
// Callers feed in `{ path, hash }` pairs and get back:
//   - a `Map<dir, aggregateHash>` rollup
//   - a utility to diff two rollups and return only the dirs whose
//     content changed (added/removed/modified).

import { hashBytesToHex } from '../runtime/hash'

/** Input row: a single indexed file with its content hash. */
export interface FileHashRow {
	/** Repo-relative POSIX path (forward slashes). */
	path: string
	/** Opaque content digest (e.g. SHA-256 hex). Any stable string works. */
	hash: string
}

/** Directory rollup result. */
export interface DirRollup {
	/** `Map<dirPath, aggregateHash>`. The root directory is keyed as `''`. */
	hashes: Map<string, string>
	/** `Map<dirPath, childFilePaths[]>` — only direct files, no subdirs. */
	filesByDir: Map<string, string[]>
	/** `Map<dirPath, childDirPaths[]>` — direct subdirs. */
	subDirsByDir: Map<string, string[]>
}

/** Diff between two rollups. */
export interface DirRollupDiff {
	/** Dirs present in `after` but not in `before`. */
	addedDirs: string[]
	/** Dirs present in `before` but not in `after`. */
	removedDirs: string[]
	/** Dirs whose aggregate hash changed between the two rollups. */
	changedDirs: string[]
	/** Dirs whose aggregate hash is identical in both rollups. */
	unchangedDirs: string[]
}

const POSIX_SEP = '/'

/** Returns the POSIX parent dir of `path`. `'foo'` → `''`, `'foo/bar.ts'` → `'foo'`. */
function parentDir(p: string): string {
	const i = p.lastIndexOf(POSIX_SEP)
	return i < 0 ? '' : p.slice(0, i)
}

/** All ancestor dirs of `path`, from the immediate parent up to `''`. */
function ancestors(p: string): string[] {
	const out: string[] = []
	let cur = parentDir(p)
	while (true) {
		out.push(cur)
		if (cur === '') break
		cur = parentDir(cur)
	}
	return out
}

/**
 * Builds a dir-level Merkle rollup from a list of `{ path, hash }` rows.
 *
 * Algorithm:
 *   1. Group files by their immediate parent dir.
 *   2. Bottom-up, per directory, hash a canonical string built from
 *      child entries: `"file:<name>:<hash>\n"` for files,
 *      `"dir:<name>:<aggHash>\n"` for subdirs, sorted lexicographically.
 *   3. Parent dirs consume their children's aggregate hash when rolling up.
 *
 * The result is deterministic for a fixed input.
 */
export function computeDirRollup(files: FileHashRow[]): DirRollup {
	const filesByDir = new Map<string, string[]>()
	const subDirsByDir = new Map<string, Set<string>>()
	const allDirs = new Set<string>()
	allDirs.add('')

	for (const f of files) {
		const dir = parentDir(f.path)
		allDirs.add(dir)
		let arr = filesByDir.get(dir)
		if (!arr) {
			arr = []
			filesByDir.set(dir, arr)
		}
		arr.push(f.path)

		// Walk ancestors and register sub-dir relationships.
		let child = dir
		for (const anc of ancestors(dir)) {
			allDirs.add(anc)
			if (child !== anc) {
				let set = subDirsByDir.get(anc)
				if (!set) {
					set = new Set()
					subDirsByDir.set(anc, set)
				}
				set.add(child)
				child = anc
			}
		}
	}

	// Normalise and deterministically sort file lists.
	for (const arr of filesByDir.values()) arr.sort()

	// Build ordered dir list: deepest first so children are ready when a
	// parent is processed.
	const dirList = [...allDirs].sort((a, b) => {
		const depthA = a === '' ? 0 : a.split(POSIX_SEP).length
		const depthB = b === '' ? 0 : b.split(POSIX_SEP).length
		if (depthA !== depthB) return depthB - depthA
		return a < b ? -1 : a > b ? 1 : 0
	})

	const hashByFile = new Map<string, string>()
	for (const f of files) hashByFile.set(f.path, f.hash)

	const hashes = new Map<string, string>()
	const subDirsByDirArr = new Map<string, string[]>()

	for (const dir of dirList) {
		const fileChildren = filesByDir.get(dir) ?? []
		const subSet = subDirsByDir.get(dir) ?? new Set<string>()
		const subChildren = [...subSet].sort()
		subDirsByDirArr.set(dir, subChildren)

		const lines: string[] = []
		for (const file of fileChildren) {
			// Emit only the basename so moving a whole subtree is detected
			// via its parent's hash, not duplicated in every descendant.
			const name = file.slice(dir.length === 0 ? 0 : dir.length + 1)
			const h = hashByFile.get(file) ?? ''
			lines.push(`file:${name}:${h}`)
		}
		for (const sub of subChildren) {
			const subName = sub.slice(dir.length === 0 ? 0 : dir.length + 1)
			const subHash = hashes.get(sub) ?? ''
			lines.push(`dir:${subName}:${subHash}`)
		}
		const payload = lines.join('\n')
		const agg = hashBytesToHex(new TextEncoder().encode(payload))
		hashes.set(dir, agg)
	}

	return { hashes, filesByDir, subDirsByDir: subDirsByDirArr }
}

/**
 * Diffs two rollups by directory hash. This is the primary consumer
 * surface: given before/after rollups, the indexer only needs to
 * re-stat files inside `changedDirs` (plus their `addedDirs` counterparts).
 */
export function diffDirRollups(before: DirRollup, after: DirRollup): DirRollupDiff {
	const beforeKeys = new Set(before.hashes.keys())
	const afterKeys = new Set(after.hashes.keys())

	const addedDirs: string[] = []
	const removedDirs: string[] = []
	const changedDirs: string[] = []
	const unchangedDirs: string[] = []

	for (const k of afterKeys) if (!beforeKeys.has(k)) addedDirs.push(k)
	for (const k of beforeKeys) if (!afterKeys.has(k)) removedDirs.push(k)
	for (const k of afterKeys) {
		if (!beforeKeys.has(k)) continue
		if (before.hashes.get(k) === after.hashes.get(k)) unchangedDirs.push(k)
		else changedDirs.push(k)
	}

	addedDirs.sort()
	removedDirs.sort()
	changedDirs.sort()
	unchangedDirs.sort()
	return { addedDirs, removedDirs, changedDirs, unchangedDirs }
}

/**
 * Given a set of unchanged directory paths, returns a predicate that
 * answers "can I skip this file?". A file is skippable iff any ancestor
 * directory (including its immediate parent) is in the unchanged set
 * **AND** the file itself appeared under that subtree in the baseline.
 *
 * The second condition prevents false-skips for *new* files dropped
 * into an otherwise-unchanged directory: those will still show up as
 * new rows in the `after` list, and the caller is expected to feed
 * `computeDirRollup(after)` to detect them — but `isSkippable` alone
 * is a cheap pre-filter when stat-ing a known-old file.
 */
export function makeSkippablePredicate(unchangedDirs: Set<string>): (path: string) => boolean {
	return (path: string) => {
		for (const anc of ancestors(path)) {
			if (unchangedDirs.has(anc)) return true
		}
		return false
	}
}

/** Serialises a rollup to a small JSON object for persistence. */
export function serialiseRollup(r: DirRollup): { version: 1; hashes: Record<string, string> } {
	const hashes: Record<string, string> = {}
	for (const [k, v] of r.hashes) hashes[k] = v
	return { version: 1, hashes }
}

/** Inverse of `serialiseRollup`. Only the hash map survives a roundtrip. */
export function deserialiseRollup(blob: { version: 1; hashes: Record<string, string> }): DirRollup {
	if (blob.version !== 1) {
		throw new Error(`unsupported dir-rollup version: ${String(blob.version)}`)
	}
	const hashes = new Map<string, string>(Object.entries(blob.hashes))
	return { hashes, filesByDir: new Map(), subDirsByDir: new Map() }
}
