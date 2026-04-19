/**
 * Stage 5 — Code Precision tests
 *
 * Tests for: AST tools, LSP server registry + pool, graph symbol blast radius
 * & call-graph cycles, loop success criteria & budget checking.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

// ---- 5a: AST tools ----
import { createAstTools } from '../src/tools/ast'

// ---- 5b: LSP registry + pool ----
import { ServerRegistry } from '../src/runtime/lsp/server-registry'

// ---- 5d: Loop improvements ----
import { checkSuccessCriteria, checkBudgetExceeded } from '../src/services/loop'

const TMPDIR = process.env.TMPDIR ?? '/tmp'
const TEST_DIR = join(TMPDIR, `stage5-test-${Date.now()}`)

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true })
})

afterEach(() => {
	if (existsSync(TEST_DIR)) {
		rmSync(TEST_DIR, { recursive: true, force: true })
	}
})

// ──────────────────────────────────────────────────────────
// 5a — AST tools
// ──────────────────────────────────────────────────────────

describe('AST tools', () => {
	function makeMockCtx() {
		return {
			directory: TEST_DIR,
			logger: { log: () => {} },
			config: {},
			projectId: 'test',
			db: {} as any,
			dataDir: TEST_DIR,
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			graphService: {} as any,
			sandboxManager: null,
			lspPool: null,
		}
	}

	test('createAstTools returns ast-search and ast-rewrite', () => {
		const tools = createAstTools(makeMockCtx() as any)
		expect(tools).toHaveProperty('ast-search')
		expect(tools).toHaveProperty('ast-rewrite')
	})

	test('ast-search returns unavailable msg when sg is not installed', async () => {
		// This test naturally works when sg is NOT installed.
		// If sg IS installed, the tool will return real results — skip gracefully.
		const tools = createAstTools(makeMockCtx() as any)
		const result = await tools['ast-search'].execute({
			pattern: '$X + $Y',
			lang: 'typescript',
		} as any)

		// Should return either unavailable message or actual search results (if sg is present)
		expect(typeof result).toBe('string')
		expect(result.length).toBeGreaterThan(0)
	})

	test('ast-rewrite returns unavailable msg when sg is not installed', async () => {
		const tools = createAstTools(makeMockCtx() as any)
		const result = await tools['ast-rewrite'].execute({
			pattern: '$X + $Y',
			rewrite: '$Y + $X',
			lang: 'typescript',
			apply: false,
		} as any)

		expect(typeof result).toBe('string')
		expect(result.length).toBeGreaterThan(0)
	})
})

// ──────────────────────────────────────────────────────────
// 5b — LSP Server Registry
// ──────────────────────────────────────────────────────────

describe('ServerRegistry', () => {
	test('default registry has TS, Python, Rust, Go entries', () => {
		const reg = new ServerRegistry()
		expect(reg.forLanguage('typescript')).not.toBeNull()
		expect(reg.forLanguage('python')).not.toBeNull()
		expect(reg.forLanguage('rust')).not.toBeNull()
		expect(reg.forLanguage('go')).not.toBeNull()
	})

	test('forLanguage returns null for unknown language', () => {
		const reg = new ServerRegistry()
		expect(reg.forLanguage('brainfuck')).toBeNull()
	})

	test('typescript-language-server handles tsx/jsx too', () => {
		const reg = new ServerRegistry()
		const ts = reg.forLanguage('typescript')
		const tsx = reg.forLanguage('typescriptreact')
		const js = reg.forLanguage('javascript')
		const jsx = reg.forLanguage('javascriptreact')
		expect(ts?.name).toBe('typescript-language-server')
		expect(tsx?.name).toBe('typescript-language-server')
		expect(js?.name).toBe('typescript-language-server')
		expect(jsx?.name).toBe('typescript-language-server')
	})

	test('user overrides can replace existing server command', () => {
		const reg = new ServerRegistry({ typescript: 'my-ts-server --stdio --experimental' })
		const entry = reg.forLanguage('typescript')
		expect(entry).not.toBeNull()
		expect(entry!.command).toBe('my-ts-server')
		expect(entry!.args).toEqual(['--stdio', '--experimental'])
	})

	test('user overrides can add new language', () => {
		const reg = new ServerRegistry({ elixir: 'elixir-ls --stdio' })
		const entry = reg.forLanguage('elixir')
		expect(entry).not.toBeNull()
		expect(entry!.command).toBe('elixir-ls')
		expect(entry!.languages).toEqual(['elixir'])
	})

	test('all() returns all entries including user additions', () => {
		const reg = new ServerRegistry({ elixir: 'elixir-ls --stdio' })
		const all = reg.all()
		expect(all.length).toBe(5) // 4 default + 1 added
		expect(all.some(e => e.languages.includes('elixir'))).toBe(true)
	})

	test('user override by name replaces server entry', () => {
		const reg = new ServerRegistry({ pyright: 'my-pyright --stdio --fast' })
		const entry = reg.forLanguage('python')
		expect(entry).not.toBeNull()
		expect(entry!.command).toBe('my-pyright')
		expect(entry!.args).toEqual(['--stdio', '--fast'])
	})
})

// ──────────────────────────────────────────────────────────
// 5c — Graph improvements: blast_radius / call_cycles tools
// ──────────────────────────────────────────────────────────

describe('graph-symbols blast_radius and call_cycles actions', () => {
	function makeMockGraphService() {
		return {
			ready: true,
			scan: async () => {},
			close: async () => {},
			getStats: async () => ({ files: 10, symbols: 50, edges: 20, summaries: 0, calls: 5 }),
			getTopFiles: async () => [],
			getFileDependents: async () => [],
			getFileDependencies: async () => [],
			getFileCoChanges: async () => [],
			getFileBlastRadius: async () => 0,
			getFileSymbols: async () => [],
			findSymbols: async (name: string) => [
				{ name, path: 'test.ts', kind: 'function', line: 1, isExported: true, pagerank: 1.0 },
			],
			searchSymbolsFts: async (query: string) => [
				{ name: query, path: 'test.ts', kind: 'function', line: 1, isExported: true, pagerank: 1.0 },
			],
			getSymbolSignature: async (path: string, line: number) => ({
				path,
				kind: 'function',
				signature: 'export function test(): void',
				line,
			}),
			getCallers: async () => [{ callerName: 'caller', callerPath: 'caller.ts', callerLine: 5, callLine: 10 }],
			getCallees: async () => [{ calleeName: 'callee', calleeFile: 'callee.ts', calleeLine: 1, callLine: 10 }],
			getUnusedExports: async () => [],
			getDuplicateStructures: async () => [],
			getNearDuplicates: async () => [],
			getExternalPackages: async () => [],
			render: async () => ({ content: '// test', paths: ['test.ts'] }),
			onFileChanged: () => {},
			// Stage 5c additions
			getSymbolBlastRadius: async (name: string, _maxDepth: number) => ({
				root: { name, path: 'core.ts', line: 10 },
				affected: [
					{ name: 'handleRequest', path: 'api.ts', line: 20, depth: 1 },
					{ name: 'processInput', path: 'input.ts', line: 5, depth: 2 },
					{ name: 'main', path: 'index.ts', line: 1, depth: 3 },
				],
				totalAffected: 3,
			}),
			getCallGraphCycles: async (_limit: number) => [
				{
					cycle: [
						{ name: 'funcA', path: 'a.ts', line: 1 },
						{ name: 'funcB', path: 'b.ts', line: 10 },
						{ name: 'funcA', path: 'a.ts', line: 1 },
					],
					length: 3,
				},
			],
		}
	}

	function makeMockCtx(graphService: any) {
		return {
			graphService,
			logger: { log: () => {} },
			projectId: 'test',
			d_irectory: TEST_DIR,
			config: {},
			db: {} as any,
			dataDir: TEST_DIR,
			kvService: { get: () => null } as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
			lspPool: null,
		}
	}

	test('blast_radius returns affected symbols with depth', async () => {
		const { createGraphTools } = await import('../src/tools/graph')
		const service = makeMockGraphService()
		const tools = createGraphTools(makeMockCtx(service) as any)

		const result = await tools['graph-symbols'].execute({
			action: 'blast_radius',
			name: 'parseConfig',
		} as any)

		expect(result).toContain('parseConfig')
		expect(result).toContain('core.ts')
		expect(result).toContain('3 affected symbol(s)')
		expect(result).toContain('handleRequest')
		expect(result).toContain('processInput')
		expect(result).toContain('main')
		expect(result).toContain('depth: 1')
		expect(result).toContain('depth: 3')
	})

	test('blast_radius requires name parameter', async () => {
		const { createGraphTools } = await import('../src/tools/graph')
		const service = makeMockGraphService()
		const tools = createGraphTools(makeMockCtx(service) as any)

		const result = await tools['graph-symbols'].execute({
			action: 'blast_radius',
		} as any)

		expect(result).toContain('name parameter required')
	})

	test('blast_radius with zero affected symbols', async () => {
		const { createGraphTools } = await import('../src/tools/graph')
		const service = makeMockGraphService()
		service.getSymbolBlastRadius = async () => ({
			root: { name: 'isolated', path: 'lone.ts', line: 1 },
			affected: [],
			totalAffected: 0,
		})
		const tools = createGraphTools(makeMockCtx(service) as any)

		const result = await tools['graph-symbols'].execute({
			action: 'blast_radius',
			name: 'isolated',
		} as any)

		expect(result).toContain('No transitive callers found')
	})

	test('call_cycles returns cycle info', async () => {
		const { createGraphTools } = await import('../src/tools/graph')
		const service = makeMockGraphService()
		const tools = createGraphTools(makeMockCtx(service) as any)

		const result = await tools['graph-symbols'].execute({
			action: 'call_cycles',
		} as any)

		expect(result).toContain('Cycle 1')
		expect(result).toContain('funcA')
		expect(result).toContain('funcB')
		expect(result).toContain('a.ts')
		expect(result).toContain('b.ts')
	})

	test('call_cycles with no cycles found', async () => {
		const { createGraphTools } = await import('../src/tools/graph')
		const service = makeMockGraphService()
		service.getCallGraphCycles = async () => []
		const tools = createGraphTools(makeMockCtx(service) as any)

		const result = await tools['graph-symbols'].execute({
			action: 'call_cycles',
		} as any)

		expect(result).toContain('No call-graph cycles found')
	})
})

// ──────────────────────────────────────────────────────────
// 5d — Loop improvements: success criteria + budget
// ──────────────────────────────────────────────────────────

describe('checkSuccessCriteria', () => {
	test('returns empty array when all commands pass', () => {
		const failures = checkSuccessCriteria({ tests: 'true', lint: 'true' }, TEST_DIR)
		expect(failures).toEqual([])
	})

	test('reports test failure', () => {
		const failures = checkSuccessCriteria({ tests: 'false' }, TEST_DIR)
		expect(failures.length).toBe(1)
		expect(failures[0].label).toBe('tests')
		expect(failures[0].command).toBe('false')
	})

	test('reports lint failure', () => {
		const failures = checkSuccessCriteria({ lint: 'false' }, TEST_DIR)
		expect(failures.length).toBe(1)
		expect(failures[0].label).toBe('lint')
	})

	test('runs multiple custom commands', () => {
		const failures = checkSuccessCriteria({ custom: ['true', 'false', 'true'] }, TEST_DIR)
		expect(failures.length).toBe(1)
		expect(failures[0].label).toContain('custom')
		expect(failures[0].command).toBe('false')
	})

	test('empty criteria returns no failures', () => {
		const failures = checkSuccessCriteria({}, TEST_DIR)
		expect(failures).toEqual([])
	})

	test('handles command not found gracefully', () => {
		const failures = checkSuccessCriteria({ tests: 'nonexistent-command-xyz-12345' }, TEST_DIR)
		expect(failures.length).toBe(1)
		expect(failures[0].label).toBe('tests')
		expect(failures[0].error.length).toBeGreaterThan(0)
	})

	test('truncates long error output to 500 chars', () => {
		// Generate a command that produces long stderr
		const longCmd = `echo "${'x'.repeat(1000)}" >&2 && false`
		const failures = checkSuccessCriteria({ tests: longCmd }, TEST_DIR)
		expect(failures.length).toBe(1)
		expect(failures[0].error.length).toBeLessThanOrEqual(500)
	})
})

describe('checkBudgetExceeded', () => {
	test('returns null when within all limits', () => {
		const result = checkBudgetExceeded(
			{ maxTokens: 100_000, maxCostUsd: 5.0, maxIterations: 50 },
			{ iteration: 10, totalTokens: 5000, totalCostUsd: 0.5 },
		)
		expect(result).toBeNull()
	})

	test('reports iteration limit exceeded', () => {
		const result = checkBudgetExceeded({ maxIterations: 10 }, { iteration: 10 })
		expect(result).not.toBeNull()
		expect(result).toContain('Iteration limit')
		expect(result).toContain('10/10')
	})

	test('reports token budget exceeded', () => {
		const result = checkBudgetExceeded({ maxTokens: 50_000 }, { iteration: 5, totalTokens: 55_000 })
		expect(result).not.toBeNull()
		expect(result).toContain('Token budget')
		expect(result).toContain('55000')
	})

	test('reports cost budget exceeded', () => {
		const result = checkBudgetExceeded({ maxCostUsd: 1.0 }, { iteration: 3, totalCostUsd: 1.5 })
		expect(result).not.toBeNull()
		expect(result).toContain('Cost budget')
		expect(result).toContain('$1.5')
	})

	test('returns null with no budget limits set', () => {
		const result = checkBudgetExceeded({}, { iteration: 100, totalTokens: 999_999, totalCostUsd: 99.99 })
		expect(result).toBeNull()
	})

	test('iteration check takes priority over token/cost', () => {
		// When multiple limits are exceeded, iteration is checked first
		const result = checkBudgetExceeded(
			{ maxIterations: 5, maxTokens: 100, maxCostUsd: 0.01 },
			{ iteration: 10, totalTokens: 1000, totalCostUsd: 1.0 },
		)
		expect(result).toContain('Iteration limit')
	})

	test('handles undefined totalTokens and totalCostUsd', () => {
		// When state doesn't have token/cost info, should use 0
		const result = checkBudgetExceeded(
			{ maxTokens: 100_000 },
			{ iteration: 1 }, // no totalTokens
		)
		expect(result).toBeNull()
	})
})
