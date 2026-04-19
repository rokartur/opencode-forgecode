import { test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Registry } from '../src/graph/registry'

let tmp: string
let dbPath: string
let repoA: string
let repoB: string
let fakeNow: number
let registry: Registry

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), 'registry-'))
	dbPath = join(tmp, 'registry.db')
	repoA = join(tmp, 'repo-a')
	repoB = join(tmp, 'repo-b')
	mkdirSync(repoA)
	mkdirSync(repoB)
	fakeNow = 1_000_000
	registry = new Registry({ dbPath }, () => fakeNow)
})

afterEach(() => {
	registry.close()
	rmSync(tmp, { recursive: true, force: true })
})

test('register persists a repo and returns it via getByName', () => {
	const rec = registry.register('alpha', repoA)
	expect(rec.name).toBe('alpha')
	expect(rec.path).toBe(repoA)
	expect(rec.registeredAt).toBe(1_000_000)
	expect(rec.lastIndexedAt).toBeNull()

	const fetched = registry.getByName('alpha')
	expect(fetched).toEqual(rec)
})

test('register rejects duplicate names and duplicate paths', () => {
	registry.register('alpha', repoA)
	expect(() => registry.register('alpha', repoB)).toThrow(/name already registered/)
	expect(() => registry.register('beta', repoA)).toThrow(/path already registered/)
})

test('register rejects empty names and missing paths', () => {
	expect(() => registry.register('', repoA)).toThrow(/must not be empty/)
	expect(() => registry.register('x', join(tmp, 'does-not-exist'))).toThrow(/does not exist/)
})

test('list returns repos sorted by name', () => {
	registry.register('zulu', repoA)
	registry.register('alpha', repoB)
	const names = registry.list().map(r => r.name)
	expect(names).toEqual(['alpha', 'zulu'])
})

test('unregister removes the row and returns true once', () => {
	registry.register('alpha', repoA)
	expect(registry.unregister('alpha')).toBe(true)
	expect(registry.unregister('alpha')).toBe(false)
	expect(registry.getByName('alpha')).toBeNull()
})

test('resolve("all") expands to the full list', () => {
	registry.register('alpha', repoA)
	registry.register('beta', repoB)
	const resolved = registry.resolve(['all']).map(r => r.name)
	expect(resolved).toEqual(['alpha', 'beta'])
})

test('resolve honours selector order and de-duplicates', () => {
	registry.register('alpha', repoA)
	registry.register('beta', repoB)
	const resolved = registry.resolve(['beta', 'alpha', 'beta']).map(r => r.name)
	expect(resolved).toEqual(['beta', 'alpha'])
})

test('resolve accepts paths as selectors', () => {
	registry.register('alpha', repoA)
	const resolved = registry.resolve([repoA])
	expect(resolved.length).toBe(1)
	expect(resolved[0].name).toBe('alpha')
})

test('resolve throws on unknown selectors', () => {
	registry.register('alpha', repoA)
	expect(() => registry.resolve(['ghost'])).toThrow(/unknown repo/)
})

test('touchIndexed updates lastIndexedAt', () => {
	registry.register('alpha', repoA)
	registry.touchIndexed('alpha', 2_000_000)
	expect(registry.getByName('alpha')!.lastIndexedAt).toBe(2_000_000)
})

test('registry persists across reopens', () => {
	registry.register('alpha', repoA)
	registry.close()
	const reopened = new Registry({ dbPath }, () => fakeNow)
	try {
		expect(reopened.getByName('alpha')?.path).toBe(repoA)
	} finally {
		reopened.close()
	}
	// beforeEach opened a fresh instance; reassign so afterEach closes this one.
	registry = new Registry({ dbPath }, () => fakeNow)
})
