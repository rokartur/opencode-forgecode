import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	createSqliteIndexStore,
	reciprocalRankFusion,
	semanticSearch,
	type IndexedChunk,
} from '../src/runtime/embeddings'
import type { EmbeddingProvider } from '../src/runtime/embeddings/provider'
import type { CodeChunk } from '../src/runtime/embeddings/chunker'

// ── Helpers ──────────────────────────────────────────────────

function vec(values: number[]): Float32Array {
	return new Float32Array(values)
}

function chunk(id: string, filePath: string, content: string, symbolName?: string): CodeChunk {
	return {
		id,
		filePath,
		startLine: 1,
		endLine: 10,
		content,
		...(symbolName ? { symbolName, symbolKind: 'function' } : {}),
	}
}

/**
 * Deterministic stub provider: returns the fixed vector we associate with
 * each text via a lookup table. Lets tests assert exact cosine rankings.
 */
function stubProvider(lookup: Record<string, number[]>, dimensions = 3): EmbeddingProvider {
	return {
		name: 'stub',
		dimensions,
		isReady: () => true,
		init: async () => {},
		embed: async texts =>
			texts.map(t => {
				if (!(t in lookup)) throw new Error(`stub provider: no vector for "${t}"`)
				return vec(lookup[t])
			}),
	}
}

// ── RRF ──────────────────────────────────────────────────────

describe('reciprocalRankFusion', () => {
	test('fuses two lists by rank, not score', () => {
		const fused = reciprocalRankFusion({
			a: [
				{ id: 'x', item: 1 },
				{ id: 'y', item: 2 },
				{ id: 'z', item: 3 },
			],
			// y wins list b outright and is also ranked above z in list a.
			b: [
				{ id: 'y', item: 2 },
				{ id: 'w', item: 4 },
			],
		})
		// y: 1/(60+2) + 1/(60+1) = 0.03252
		// x: 1/(60+1)           = 0.01639
		// w: 1/(60+2)           = 0.01613
		// z: 1/(60+3)           = 0.01587
		expect(fused.map(f => f.id)).toEqual(['y', 'x', 'w', 'z'])
		expect(fused[0].ranks).toEqual({ a: 2, b: 1 })
	})

	test('respects topK', () => {
		const fused = reciprocalRankFusion(
			{
				a: [
					{ id: 'x', item: 1 },
					{ id: 'y', item: 2 },
					{ id: 'z', item: 3 },
				],
			},
			{ topK: 2 },
		)
		expect(fused).toHaveLength(2)
		expect(fused[0].id).toBe('x')
	})

	test('empty input returns empty', () => {
		expect(reciprocalRankFusion({})).toEqual([])
	})
})

// ── SqliteIndexStore ─────────────────────────────────────────

describe('createSqliteIndexStore', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	function makeStore() {
		const dir = mkdtempSync(join(tmpdir(), 'embeddings-fts-'))
		tempDirs.push(dir)
		return createSqliteIndexStore(join(dir, 'embeddings.db'))
	}

	test('add/search/size/close roundtrip', () => {
		const store = makeStore()
		try {
			const items: IndexedChunk[] = [
				{ chunk: chunk('a', 'a.ts', 'auth login handler', 'login'), embedding: vec([1, 0, 0]) },
				{ chunk: chunk('b', 'b.ts', 'payment checkout', 'checkout'), embedding: vec([0, 1, 0]) },
				{ chunk: chunk('c', 'c.ts', 'db migration'), embedding: vec([0, 0, 1]) },
			]
			store.add(items)
			expect(store.size).toBe(3)

			const results = store.search(vec([1, 0, 0]), 2)
			expect(results[0].chunk.id).toBe('a')
			expect(results[0].score).toBeCloseTo(1.0)
			expect(results).toHaveLength(2)

			expect(store.indexedFiles().sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
		} finally {
			store.close()
		}
	})

	test('removeFile deletes chunks and their FTS entries', () => {
		const store = makeStore()
		try {
			store.add([
				{ chunk: chunk('a', 'a.ts', 'auth login'), embedding: vec([1, 0, 0]) },
				{ chunk: chunk('b', 'b.ts', 'payment'), embedding: vec([0, 1, 0]) },
			])
			store.removeFile('a.ts')
			expect(store.size).toBe(1)
			expect(store.keywordSearch('auth')).toEqual([])
		} finally {
			store.close()
		}
	})

	test('keywordSearch matches content and symbol_name via BM25', () => {
		const store = makeStore()
		try {
			store.add([
				{
					chunk: chunk(
						'a',
						'a.ts',
						'function loginUser(email, password) { return auth.verify(email) }',
						'loginUser',
					),
					embedding: vec([1, 0, 0]),
				},
				{
					chunk: chunk(
						'b',
						'b.ts',
						'function processPayment(amount) { return stripe.charge(amount) }',
						'processPayment',
					),
					embedding: vec([0, 1, 0]),
				},
				{
					chunk: chunk('c', 'c.ts', 'function migrateDatabase() { runMigrations() }', 'migrateDatabase'),
					embedding: vec([0, 0, 1]),
				},
			])

			const results = store.keywordSearch('login auth', 5)
			expect(results.length).toBeGreaterThan(0)
			expect(results[0].chunk.id).toBe('a')
		} finally {
			store.close()
		}
	})

	test('keywordSearch handles punctuation in code identifiers', () => {
		const store = makeStore()
		try {
			store.add([
				{ chunk: chunk('a', 'a.ts', 'auth.login handler'), embedding: vec([1, 0, 0]) },
				{ chunk: chunk('b', 'b.ts', 'payment.checkout flow'), embedding: vec([0, 1, 0]) },
			])
			// Dots and quotes must not break FTS5 parsing.
			const results = store.keywordSearch('auth.login "handler"', 5)
			expect(results[0].chunk.id).toBe('a')
		} finally {
			store.close()
		}
	})

	test('keywordSearch returns empty on whitespace query', () => {
		const store = makeStore()
		try {
			store.add([{ chunk: chunk('a', 'a.ts', 'hello'), embedding: vec([1, 0, 0]) }])
			expect(store.keywordSearch('   ')).toEqual([])
		} finally {
			store.close()
		}
	})

	test('add is idempotent on same id (INSERT OR REPLACE)', () => {
		const store = makeStore()
		try {
			store.add([{ chunk: chunk('a', 'a.ts', 'v1'), embedding: vec([1, 0, 0]) }])
			store.add([{ chunk: chunk('a', 'a.ts', 'v2'), embedding: vec([0, 1, 0]) }])
			expect(store.size).toBe(1)
			const results = store.search(vec([0, 1, 0]), 1)
			expect(results[0].chunk.content).toBe('v2')
			expect(store.keywordSearch('v2')[0]?.chunk.id).toBe('a')
			expect(store.keywordSearch('v1')).toEqual([])
		} finally {
			store.close()
		}
	})

	test('schema survives close + reopen', () => {
		const dir = mkdtempSync(join(tmpdir(), 'embeddings-fts-'))
		tempDirs.push(dir)
		const path = join(dir, 'embeddings.db')

		const s1 = createSqliteIndexStore(path)
		s1.add([{ chunk: chunk('a', 'a.ts', 'persisted'), embedding: vec([1, 0, 0]) }])
		s1.close()

		const s2 = createSqliteIndexStore(path)
		try {
			expect(s2.size).toBe(1)
			expect(s2.keywordSearch('persisted')[0]?.chunk.id).toBe('a')
		} finally {
			s2.close()
		}
	})
})

// ── semanticSearch modes ─────────────────────────────────────

describe('semanticSearch modes', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	function makeStoreWithChunks() {
		const dir = mkdtempSync(join(tmpdir(), 'embeddings-fts-'))
		tempDirs.push(dir)
		const store = createSqliteIndexStore(join(dir, 'embeddings.db'))
		store.add([
			// Vector-similar to "authentication" query but no keyword overlap.
			{ chunk: chunk('sem', 'sem.ts', 'verify user credentials and issue token'), embedding: vec([0.9, 0.1, 0]) },
			// Keyword match on "login" but vector-dissimilar.
			{ chunk: chunk('kw', 'kw.ts', 'login form component', 'login'), embedding: vec([0, 0, 1]) },
			// Unrelated noise.
			{ chunk: chunk('noise', 'n.ts', 'quicksort pivot helper'), embedding: vec([0, 1, 0]) },
		])
		return store
	}

	test('mode=semantic returns vector-ranked results (ignores keyword overlap)', async () => {
		const store = makeStoreWithChunks()
		try {
			const provider = stubProvider({ 'user login': [1, 0, 0] })
			const results = await semanticSearch('user login', provider, store, 2, 'semantic')
			expect(results[0].chunk.id).toBe('sem')
		} finally {
			store.close()
		}
	})

	test('mode=keyword returns BM25-ranked results (ignores embedding)', async () => {
		const store = makeStoreWithChunks()
		try {
			// Provider is not consulted for keyword mode; give it an empty lookup.
			const provider = stubProvider({})
			const results = await semanticSearch('login', provider, store, 2, 'keyword')
			expect(results[0].chunk.id).toBe('kw')
		} finally {
			store.close()
		}
	})

	test('mode=hybrid surfaces both semantic and keyword winners', async () => {
		const store = makeStoreWithChunks()
		try {
			const provider = stubProvider({ login: [1, 0, 0] })
			const results = await semanticSearch('login', provider, store, 3, 'hybrid')
			const ids = results.map(r => r.chunk.id)
			expect(ids).toContain('sem')
			expect(ids).toContain('kw')
			// The "noise" chunk shouldn't outrank both.
			expect(ids.indexOf('noise')).toBe(2)
		} finally {
			store.close()
		}
	})

	test('mode=keyword throws when store has no keywordSearch', async () => {
		const { createIndexStore } = await import('../src/runtime/embeddings')
		const store = createIndexStore()
		const provider = stubProvider({})
		await expect(semanticSearch('x', provider, store, 1, 'keyword')).rejects.toThrow(/keyword search requires/)
	})

	test('mode=hybrid falls back to semantic when store has no keywordSearch', async () => {
		const { createIndexStore } = await import('../src/runtime/embeddings')
		const store = createIndexStore()
		store.add([{ chunk: chunk('a', 'a.ts', 'x'), embedding: vec([1, 0, 0]) }])
		const provider = stubProvider({ q: [1, 0, 0] })
		const results = await semanticSearch('q', provider, store, 1, 'hybrid')
		expect(results[0].chunk.id).toBe('a')
	})
})
