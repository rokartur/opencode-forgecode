// Snapshot/diff I/O helpers for graph snapshots (Etap 9c).
//
// A snapshot is a small JSON rollup of the graph produced by
// `RepoMap.snapshot(label)`. This module saves/loads snapshots to a
// per-project directory inside the graph cache root and exposes a thin
// wrapper around `RepoMap.diffSnapshots` that works from paths.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import type { GraphSnapshot, GraphSnapshotDiff } from './types'
import { RepoMap } from './repo-map'

/** File name sanitiser: collapses anything non-alphanumeric into `-`. */
function sanitiseLabel(label: string): string {
	const trimmed = label.trim()
	if (!trimmed) throw new Error('snapshot label must not be empty')
	const cleaned = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
	if (!cleaned) throw new Error(`snapshot label resolves to empty after sanitisation: ${label}`)
	return cleaned
}

/** Returns the absolute directory where snapshots are stored. Created on demand. */
export function snapshotDir(graphCacheDir: string): string {
	const dir = join(resolve(graphCacheDir), 'snapshots')
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
	return dir
}

/** Persists a snapshot to `<graphCacheDir>/snapshots/<label>.json`. */
export function saveSnapshot(graphCacheDir: string, snapshot: GraphSnapshot): string {
	const dir = snapshotDir(graphCacheDir)
	const file = join(dir, `${sanitiseLabel(snapshot.label)}.json`)
	writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf-8')
	return file
}

/** Loads a snapshot by label. Throws if missing or malformed. */
export function loadSnapshot(graphCacheDir: string, label: string): GraphSnapshot {
	const file = join(snapshotDir(graphCacheDir), `${sanitiseLabel(label)}.json`)
	if (!existsSync(file)) {
		throw new Error(`snapshot not found: ${label} (${file})`)
	}
	const parsed = JSON.parse(readFileSync(file, 'utf-8')) as GraphSnapshot
	if (parsed.version !== 1) {
		throw new Error(`unsupported snapshot version: ${String(parsed.version)} (expected 1)`)
	}
	return parsed
}

/** Lists all snapshot labels currently persisted under `graphCacheDir`. */
export function listSnapshots(graphCacheDir: string): string[] {
	const dir = snapshotDir(graphCacheDir)
	return readdirSync(dir)
		.filter(f => f.endsWith('.json'))
		.map(f => f.slice(0, -'.json'.length))
		.sort()
}

/** Diffs two persisted snapshots by label. */
export function diffSnapshotsByLabel(graphCacheDir: string, labelA: string, labelB: string): GraphSnapshotDiff {
	const a = loadSnapshot(graphCacheDir, labelA)
	const b = loadSnapshot(graphCacheDir, labelB)
	return RepoMap.diffSnapshots(a, b)
}
