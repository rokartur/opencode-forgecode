/**
 * Stage 8 — Heavy features: MCP OAuth, Embeddings, Ultrawork.
 *
 * Covers:
 *   8a: MCP OAuth 2.0 + PKCE + DCR + token store
 *   8b: Embeddings — provider, chunker, index store, semantic search
 *   8c: Ultrawork mode — CLI, template, prompt builder
 */

import { describe, test, expect } from 'bun:test'

// 8a: OAuth + PKCE
import { generateCodeVerifier, deriveCodeChallenge, createOAuthClient } from '../src/runtime/mcp/oauth'
import type { TokenSet } from '../src/runtime/mcp/oauth'
import type { DcrClientMetadata, DcrRegistrationResponse } from '../src/runtime/mcp/dcr'
import { createTokenStore } from '../src/runtime/mcp/token-store'

// 8b: Embeddings
import { createEmbeddingProvider } from '../src/runtime/embeddings/provider'
import { chunkFile, chunkFiles } from '../src/runtime/embeddings/chunker'
import type { CodeChunk, SymbolInfo } from '../src/runtime/embeddings/chunker'
import { createIndexStore, indexChunks, semanticSearch } from '../src/runtime/embeddings/index-store'

// 8c: Ultrawork
import { parseArgs, buildPrompt, createUltraworkPrompt } from '../src/cli/commands/ultrawork'

// Config types
import type { McpConfig, EmbeddingsConfig, UltraworkConfig } from '../src/types'

// ═══════════════════════════════════════════════════════════════
// 8a: MCP OAuth 2.0 + PKCE + DCR
// ═══════════════════════════════════════════════════════════════

describe('Stage 8a — PKCE', () => {
	test('generateCodeVerifier produces correct length', () => {
		const v43 = generateCodeVerifier(43)
		expect(v43.length).toBe(43)

		const v64 = generateCodeVerifier(64)
		expect(v64.length).toBe(64)

		const v128 = generateCodeVerifier(128)
		expect(v128.length).toBe(128)
	})

	test('generateCodeVerifier uses URL-safe characters only', () => {
		const v = generateCodeVerifier(128)
		expect(v).toMatch(/^[A-Za-z0-9_-]+$/)
	})

	test('generateCodeVerifier rejects out-of-range lengths', () => {
		expect(() => generateCodeVerifier(42)).toThrow('43-128')
		expect(() => generateCodeVerifier(129)).toThrow('43-128')
	})

	test('deriveCodeChallenge is deterministic', () => {
		const verifier = 'test-verifier-for-determinism-check-0123456789abc'
		const c1 = deriveCodeChallenge(verifier)
		const c2 = deriveCodeChallenge(verifier)
		expect(c1).toBe(c2)
	})

	test('deriveCodeChallenge produces URL-safe base64', () => {
		const verifier = generateCodeVerifier(64)
		const challenge = deriveCodeChallenge(verifier)
		// base64url: no +, /, =
		expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/)
		// SHA-256 → 32 bytes → 43 base64url chars
		expect(challenge.length).toBe(43)
	})

	test('different verifiers produce different challenges', () => {
		const v1 = generateCodeVerifier(64)
		const v2 = generateCodeVerifier(64)
		const c1 = deriveCodeChallenge(v1)
		const c2 = deriveCodeChallenge(v2)
		expect(c1).not.toBe(c2)
	})
})

describe('Stage 8a — OAuthClient', () => {
	const config = {
		authorizeUrl: 'https://auth.example.com/authorize',
		tokenUrl: 'https://auth.example.com/token',
		clientId: 'test-client',
		redirectUri: 'http://localhost:19876/callback',
		scopes: ['read', 'write'],
	}

	test('buildAuthorizeUrl includes PKCE params', () => {
		const client = createOAuthClient(config)
		const { url, codeVerifier, state } = client.buildAuthorizeUrl()

		const parsed = new URL(url)
		expect(parsed.origin + parsed.pathname).toBe(config.authorizeUrl)
		expect(parsed.searchParams.get('response_type')).toBe('code')
		expect(parsed.searchParams.get('client_id')).toBe('test-client')
		expect(parsed.searchParams.get('redirect_uri')).toBe(config.redirectUri)
		expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
		expect(parsed.searchParams.get('scope')).toBe('read write')

		const challenge = parsed.searchParams.get('code_challenge')!
		expect(challenge).toBe(deriveCodeChallenge(codeVerifier))
		expect(state.length).toBeGreaterThan(10)
	})

	test('buildAuthorizeUrl generates unique state each time', () => {
		const client = createOAuthClient(config)
		const a = client.buildAuthorizeUrl()
		const b = client.buildAuthorizeUrl()
		expect(a.state).not.toBe(b.state)
	})

	test('isExpired returns true for expired tokens', () => {
		const client = createOAuthClient(config)
		const tokens: TokenSet = {
			accessToken: 'a',
			tokenType: 'Bearer',
			expiresAt: Date.now() - 1000,
		}
		expect(client.isExpired(tokens)).toBe(true)
	})

	test('isExpired returns false for future tokens', () => {
		const client = createOAuthClient(config)
		const tokens: TokenSet = {
			accessToken: 'a',
			tokenType: 'Bearer',
			expiresAt: Date.now() + 3600_000,
		}
		expect(client.isExpired(tokens)).toBe(false)
	})

	test('isExpired respects buffer', () => {
		const client = createOAuthClient(config)
		const tokens: TokenSet = {
			accessToken: 'a',
			tokenType: 'Bearer',
			expiresAt: Date.now() + 10_000,
		}
		// Default buffer is 30s — token expires in 10s, so should be "expired"
		expect(client.isExpired(tokens, 30_000)).toBe(true)
		expect(client.isExpired(tokens, 5_000)).toBe(false)
	})

	test('isExpired returns false when no expiresAt', () => {
		const client = createOAuthClient(config)
		const tokens: TokenSet = {
			accessToken: 'a',
			tokenType: 'Bearer',
		}
		expect(client.isExpired(tokens)).toBe(false)
	})
})

describe('Stage 8a — DCR types', () => {
	test('DcrClientMetadata has required fields', () => {
		const meta: DcrClientMetadata = {
			clientName: 'test',
			redirectUris: ['http://localhost/callback'],
		}
		expect(meta.clientName).toBe('test')
		expect(meta.redirectUris).toHaveLength(1)
	})

	test('DcrRegistrationResponse has required fields', () => {
		const resp: DcrRegistrationResponse = {
			clientId: 'abc123',
		}
		expect(resp.clientId).toBe('abc123')
	})
})

describe('Stage 8a — TokenStore (encrypted file)', () => {
	test('creates encrypted file store', () => {
		const tmpDir = `${process.env.TMPDIR || '/tmp'}/forge-test-tokens-${Date.now()}`
		const store = createTokenStore(tmpDir)
		expect(store).toBeDefined()
		expect(store.backend).toBeDefined()
		expect(typeof store.get).toBe('function')
		expect(typeof store.set).toBe('function')
		expect(typeof store.remove).toBe('function')
		expect(typeof store.list).toBe('function')
	})

	test('round-trip: set, get, list, remove', async () => {
		const tmpDir = `${process.env.TMPDIR || '/tmp'}/forge-test-tokens-${Date.now()}`
		const store = createTokenStore(tmpDir)

		const tokens: TokenSet = {
			accessToken: 'test-access-token',
			refreshToken: 'test-refresh-token',
			expiresAt: Date.now() + 3600_000,
			tokenType: 'Bearer',
			scope: 'read write',
		}

		// set + get
		await store.set('https://mcp.example.com', tokens)
		const retrieved = await store.get('https://mcp.example.com')
		expect(retrieved).toBeDefined()
		expect(retrieved!.accessToken).toBe('test-access-token')
		expect(retrieved!.refreshToken).toBe('test-refresh-token')
		expect(retrieved!.tokenType).toBe('Bearer')

		// list
		const servers = await store.list()
		expect(servers).toContain('https://mcp.example.com')

		// remove
		await store.remove('https://mcp.example.com')
		const afterRemove = await store.get('https://mcp.example.com')
		expect(afterRemove).toBeNull()

		const afterRemoveList = await store.list()
		expect(afterRemoveList).not.toContain('https://mcp.example.com')
	})

	test('get returns null for non-existent server', async () => {
		const tmpDir = `${process.env.TMPDIR || '/tmp'}/forge-test-tokens-none-${Date.now()}`
		const store = createTokenStore(tmpDir)
		const result = await store.get('https://nonexistent.example.com')
		expect(result).toBeNull()
	})
})

// ═══════════════════════════════════════════════════════════════
// 8b: Embeddings
// ═══════════════════════════════════════════════════════════════

describe('Stage 8b — EmbeddingProvider (fastembed fallback)', () => {
	test('creates fastembed provider with defaults', () => {
		const provider = createEmbeddingProvider()
		expect(provider.name).toBe('fastembed')
		expect(provider.dimensions).toBe(384) // bge-small-en-v1.5 default
	})

	test('creates openai provider', () => {
		const provider = createEmbeddingProvider({ provider: 'openai' })
		expect(provider.name).toBe('openai')
		expect(provider.dimensions).toBe(1536) // text-embedding-3-small default
	})

	test('creates voyage provider', () => {
		const provider = createEmbeddingProvider({ provider: 'voyage' })
		expect(provider.name).toBe('voyage')
		expect(provider.dimensions).toBe(1024)
	})

	test('fastembed fallback generates embeddings after init', async () => {
		const provider = createEmbeddingProvider()
		await provider.init()
		expect(provider.isReady()).toBe(true)

		const embeddings = await provider.embed(['hello world', 'test code'])
		expect(embeddings).toHaveLength(2)
		expect(embeddings[0]).toBeInstanceOf(Float32Array)
		expect(embeddings[0].length).toBe(384)
		expect(embeddings[1].length).toBe(384)
	})

	test('fastembed fallback produces normalized vectors', async () => {
		const provider = createEmbeddingProvider()
		await provider.init()

		const [emb] = await provider.embed(['normalize check'])
		let norm = 0
		for (let i = 0; i < emb.length; i++) norm += emb[i] * emb[i]
		norm = Math.sqrt(norm)
		expect(Math.abs(norm - 1.0)).toBeLessThan(0.01)
	})

	test('fastembed fallback produces different vectors for different inputs', async () => {
		const provider = createEmbeddingProvider()
		await provider.init()

		const [a, b] = await provider.embed([
			'function add(x, y) { return x + y }',
			'class UserService { getUser() {} }',
		])
		let same = true
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) {
				same = false
				break
			}
		}
		expect(same).toBe(false)
	})
})

describe('Stage 8b — Chunker', () => {
	const sampleCode = `import { foo } from './foo'

export function add(a: number, b: number): number {
  return a + b
}

export function subtract(a: number, b: number): number {
  return a - b
}

export class Calculator {
  value = 0
  add(n: number) { this.value += n; return this }
  sub(n: number) { this.value -= n; return this }
  reset() { this.value = 0; return this }
}
`

	const symbols: SymbolInfo[] = [
		{ name: 'add', kind: 'function', startLine: 3, endLine: 5 },
		{ name: 'subtract', kind: 'function', startLine: 7, endLine: 9 },
		{ name: 'Calculator', kind: 'class', startLine: 11, endLine: 16 },
	]

	test('chunkFile by symbols produces correct chunks', () => {
		const chunks = chunkFile('calc.ts', sampleCode, symbols)
		expect(chunks.length).toBeGreaterThanOrEqual(3)

		const named = chunks.filter(c => c.symbolName)
		expect(named.length).toBe(3)
		expect(named.map(c => c.symbolName)).toEqual(['add', 'subtract', 'Calculator'])
	})

	test('chunkFile symbol chunks have correct file path', () => {
		const chunks = chunkFile('calc.ts', sampleCode, symbols)
		for (const chunk of chunks) {
			expect(chunk.filePath).toBe('calc.ts')
		}
	})

	test('chunkFile falls back to line-based chunking', () => {
		const chunks = chunkFile('file.ts', sampleCode, undefined, { linesPerChunk: 5, overlapLines: 1 })
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeGreaterThan(0)
		}
	})

	test('chunkFile respects maxChunkSize for large symbols', () => {
		const bigContent = Array.from({ length: 200 }, (_, i) => `  const line${i} = ${i}`).join('\n')
		const bigSymbols: SymbolInfo[] = [{ name: 'bigFn', kind: 'function', startLine: 1, endLine: 200 }]
		const chunks = chunkFile('big.ts', bigContent, bigSymbols, { maxChunkSize: 500 })
		expect(chunks.length).toBeGreaterThan(1)
		for (const chunk of chunks) {
			expect(chunk.content.length).toBeLessThanOrEqual(500 + 100) // allow some slack for line boundaries
		}
	})

	test('chunkFiles batches multiple files', () => {
		const files = [
			{ filePath: 'a.ts', content: 'const a = 1\n', symbols: [] },
			{ filePath: 'b.ts', content: 'const b = 2\n', symbols: [] },
		]
		const chunks = chunkFiles(files, { linesPerChunk: 50 })
		const paths = [...new Set(chunks.map(c => c.filePath))]
		expect(paths).toContain('a.ts')
		expect(paths).toContain('b.ts')
	})

	test('chunkFile handles empty content', () => {
		const chunks = chunkFile('empty.ts', '', undefined, {})
		expect(chunks).toEqual([])
	})
})

describe('Stage 8b — IndexStore', () => {
	test('creates empty store', () => {
		const store = createIndexStore()
		expect(store.size).toBe(0)
		expect(store.indexedFiles()).toEqual([])
	})

	test('add and search', () => {
		const store = createIndexStore()
		const emb = new Float32Array([1, 0, 0])
		store.add([
			{
				chunk: { id: 'a:1-5', filePath: 'a.ts', startLine: 1, endLine: 5, content: 'hello' },
				embedding: emb,
			},
		])
		expect(store.size).toBe(1)

		const results = store.search(new Float32Array([1, 0, 0]), 5)
		expect(results).toHaveLength(1)
		expect(results[0].score).toBeCloseTo(1.0, 3)
	})

	test('search returns sorted by similarity', () => {
		const store = createIndexStore()
		store.add([
			{
				chunk: { id: 'a', filePath: 'a.ts', startLine: 1, endLine: 1, content: 'a' },
				embedding: new Float32Array([1, 0, 0]),
			},
			{
				chunk: { id: 'b', filePath: 'b.ts', startLine: 1, endLine: 1, content: 'b' },
				embedding: new Float32Array([0, 1, 0]),
			},
			{
				chunk: { id: 'c', filePath: 'c.ts', startLine: 1, endLine: 1, content: 'c' },
				embedding: new Float32Array([0.7, 0.7, 0]),
			},
		])

		const results = store.search(new Float32Array([1, 0, 0]), 3)
		expect(results[0].chunk.id).toBe('a') // exact match
		expect(results[1].chunk.id).toBe('c') // partial match
		expect(results[2].chunk.id).toBe('b') // orthogonal
	})

	test('removeFile removes all chunks for a path', () => {
		const store = createIndexStore()
		store.add([
			{
				chunk: { id: 'a:1', filePath: 'a.ts', startLine: 1, endLine: 1, content: 'a' },
				embedding: new Float32Array([1, 0]),
			},
			{
				chunk: { id: 'a:2', filePath: 'a.ts', startLine: 2, endLine: 2, content: 'b' },
				embedding: new Float32Array([0, 1]),
			},
			{
				chunk: { id: 'b:1', filePath: 'b.ts', startLine: 1, endLine: 1, content: 'c' },
				embedding: new Float32Array([1, 1]),
			},
		])

		expect(store.size).toBe(3)
		store.removeFile('a.ts')
		expect(store.size).toBe(1)
		expect(store.indexedFiles()).toEqual(['b.ts'])
	})

	test('clear empties the store', () => {
		const store = createIndexStore()
		store.add([
			{
				chunk: { id: 'x', filePath: 'x.ts', startLine: 1, endLine: 1, content: 'x' },
				embedding: new Float32Array([1]),
			},
		])
		expect(store.size).toBe(1)
		store.clear()
		expect(store.size).toBe(0)
	})

	test('search on empty store returns empty', () => {
		const store = createIndexStore()
		expect(store.search(new Float32Array([1, 0, 0]))).toEqual([])
	})
})

describe('Stage 8b — indexChunks + semanticSearch integration', () => {
	test('index and search pipeline', async () => {
		const provider = createEmbeddingProvider()
		await provider.init()

		const store = createIndexStore()
		const chunks: CodeChunk[] = [
			{ id: 'a:1-3', filePath: 'a.ts', startLine: 1, endLine: 3, content: 'function add(a, b) { return a + b }' },
			{ id: 'b:1-3', filePath: 'b.ts', startLine: 1, endLine: 3, content: 'class UserService { getUser() {} }' },
			{
				id: 'c:1-3',
				filePath: 'c.ts',
				startLine: 1,
				endLine: 3,
				content: 'const DATABASE_URL = "postgres://..."',
			},
		]

		const result = await indexChunks(chunks, provider, store)
		expect(result.chunksIndexed).toBe(3)
		expect(result.filesIndexed).toBe(3)
		expect(result.durationMs).toBeGreaterThanOrEqual(0)
		expect(store.size).toBe(3)

		const results = await semanticSearch('add numbers', provider, store, 2)
		expect(results.length).toBeLessThanOrEqual(2)
		expect(results[0].score).toBeGreaterThan(-1)
	})

	test('re-indexing a file replaces previous chunks', async () => {
		const provider = createEmbeddingProvider()
		await provider.init()

		const store = createIndexStore()

		await indexChunks(
			[{ id: 'a:1', filePath: 'a.ts', startLine: 1, endLine: 1, content: 'old content' }],
			provider,
			store,
		)
		expect(store.size).toBe(1)

		await indexChunks(
			[
				{ id: 'a:1', filePath: 'a.ts', startLine: 1, endLine: 1, content: 'new content v1' },
				{ id: 'a:2', filePath: 'a.ts', startLine: 2, endLine: 2, content: 'new content v2' },
			],
			provider,
			store,
		)
		expect(store.size).toBe(2)
	})
})

// ═══════════════════════════════════════════════════════════════
// 8c: Ultrawork
// ═══════════════════════════════════════════════════════════════

describe('Stage 8c — Ultrawork parseArgs', () => {
	test('parses positional task', () => {
		const { task, options } = parseArgs(['add', 'pagination', 'to', 'users', 'API'])
		expect(task).toBe('add pagination to users API')
		expect(options.planOnly).toBe(false)
		expect(options.autoApprove).toBe(true)
		expect(options.maxSteps).toBe(50)
	})

	test('parses --plan-only', () => {
		const { options } = parseArgs(['--plan-only', 'refactor auth'])
		expect(options.planOnly).toBe(true)
	})

	test('parses --no-auto-approve', () => {
		const { options } = parseArgs(['--no-auto-approve', 'migrate db'])
		expect(options.autoApprove).toBe(false)
	})

	test('parses --max-steps=N', () => {
		const { options } = parseArgs(['--max-steps=100', 'big task'])
		expect(options.maxSteps).toBe(100)
	})

	test('empty args produces empty task', () => {
		const { task } = parseArgs([])
		expect(task).toBe('')
	})
})

describe('Stage 8c — Ultrawork buildPrompt', () => {
	test('injects task into template', () => {
		const prompt = buildPrompt('add auth middleware', {
			planOnly: false,
			maxSteps: 50,
			autoApprove: true,
		})
		expect(prompt).toContain('add auth middleware')
		expect(prompt).toContain('Intent Gate')
		expect(prompt).toContain('Strategic Plan')
		expect(prompt).toContain('Execute')
		expect(prompt).toContain('Audit')
		expect(prompt).toContain('Report')
	})

	test('plan-only mode adds modifier', () => {
		const prompt = buildPrompt('task', { planOnly: true, maxSteps: 50, autoApprove: true })
		expect(prompt).toContain('PLAN ONLY')
	})

	test('no-auto-approve mode adds modifier', () => {
		const prompt = buildPrompt('task', { planOnly: false, maxSteps: 50, autoApprove: false })
		expect(prompt).toContain('MANUAL APPROVAL')
	})

	test('max-steps appears in prompt', () => {
		const prompt = buildPrompt('task', { planOnly: false, maxSteps: 75, autoApprove: true })
		expect(prompt).toContain('75')
	})
})

describe('Stage 8c — createUltraworkPrompt helper', () => {
	test('uses defaults', () => {
		const prompt = createUltraworkPrompt('fix login bug')
		expect(prompt).toContain('fix login bug')
		expect(prompt).not.toContain('PLAN ONLY')
		expect(prompt).not.toContain('MANUAL APPROVAL')
		expect(prompt).toContain('50')
	})

	test('overrides work', () => {
		const prompt = createUltraworkPrompt('big refactor', { planOnly: true, maxSteps: 200 })
		expect(prompt).toContain('PLAN ONLY')
		expect(prompt).toContain('200')
	})
})

// ═══════════════════════════════════════════════════════════════
// Config types
// ═══════════════════════════════════════════════════════════════

describe('Stage 8 — Config types', () => {
	test('McpConfig type is structurally valid', () => {
		const config: McpConfig = {
			servers: [
				{ name: 'test', url: 'https://mcp.example.com', auth: 'oauth' },
				{ name: 'local', url: 'http://localhost:3000', auth: 'none' },
			],
		}
		expect(config.servers).toHaveLength(2)
		expect(config.servers![0].auth).toBe('oauth')
	})

	test('EmbeddingsConfig type is structurally valid', () => {
		const config: EmbeddingsConfig = {
			enabled: true,
			provider: 'openai',
			model: 'text-embedding-3-large',
			batchSize: 50,
		}
		expect(config.provider).toBe('openai')
	})

	test('UltraworkConfig type is structurally valid', () => {
		const config: UltraworkConfig = {
			enabled: true,
			maxSteps: 100,
			autoApprove: false,
		}
		expect(config.maxSteps).toBe(100)
	})
})
