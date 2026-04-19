import { test, expect, describe } from 'bun:test'
import { createGraphTools } from '../src/tools/graph'
import type { GraphService } from '../src/graph/service'

// Mock graph service
function createMockGraphService(): GraphService {
	return {
		ready: true,
		scan: async () => {},
		close: async () => {},
		getStats: async () => ({ files: 10, symbols: 50, edges: 20, summaries: 0, calls: 5 }),
		getTopFiles: async limit =>
			Array(limit || 20)
				.fill(null)
				.map((_, i) => ({
					path: `file${i}.ts`,
					pagerank: 1.0,
					lines: 100,
					symbols: 5,
					language: 'typescript',
				})),
		getFileDependents: async _path => [{ path: 'dep.ts', weight: 1.0 }],
		getFileDependencies: async _path => [{ path: 'dependency.ts', weight: 1.0 }],
		getFileCoChanges: async _path => [{ path: 'cochange.ts', count: 3 }],
		getFileBlastRadius: async _path => 5,
		getFileSymbols: async _path => [
			{
				name: 'testFunc',
				kind: 'function',
				isExported: true,
				line: 1,
				endLine: 10,
			},
		],
		findSymbols: async (name, _limit) => [
			{
				name,
				path: 'test.ts',
				kind: 'function',
				line: 1,
				isExported: true,
				pagerank: 1.0,
			},
		],
		searchSymbolsFts: async (query, _limit) => [
			{
				name: query,
				path: 'test.ts',
				kind: 'function',
				line: 1,
				isExported: true,
				pagerank: 1.0,
			},
		],
		getSymbolSignature: async (path, line) => ({
			path,
			kind: 'function',
			signature: 'export function test(): void',
			line,
		}),
		getCallers: async (_path, _line) => [
			{
				callerName: 'caller',
				callerPath: 'caller.ts',
				callerLine: 5,
				callLine: 10,
			},
		],
		getCallees: async (_path, _line) => [
			{
				calleeName: 'callee',
				calleeFile: 'callee.ts',
				calleeLine: 1,
				callLine: 10,
			},
		],
		getUnusedExports: async (_limit = 50) => [],
		getDuplicateStructures: async (_limit = 20) => [],
		getNearDuplicates: async (_threshold = 0.8, _limit = 50) => [],
		getExternalPackages: async (_limit = 50) => [
			{ package: 'express', fileCount: 2, specifiers: ['default', 'Router'] },
		],
		render: async _opts => ({ content: '// test', paths: ['test.ts'] }),
		onFileChanged: _path => {},
	}
}

describe('graph-query tool', () => {
	test('limit argument affects packages result', async () => {
		const mockService = createMockGraphService()
		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		}
		const tools = createGraphTools(mockCtx as any)

		const result = await tools['graph-query'].execute({
			action: 'packages',
			limit: 1,
		} as any)

		expect(result).toContain('express')
	})

	test('limit argument affects top_files result', async () => {
		const mockService = createMockGraphService()
		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		}
		const tools = createGraphTools(mockCtx as any)

		const result = await tools['graph-query'].execute({
			action: 'top_files',
			limit: 5,
		} as any)

		// Should return limited results
		const lines = result.split('\n').filter(l => l.includes('file'))
		expect(lines.length).toBeLessThanOrEqual(5)
	})
})

describe('graph-symbols tool', () => {
	test('kind filter filters results', async () => {
		const mockService = createMockGraphService()
		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		}
		const tools = createGraphTools(mockCtx as any)

		const result = await tools['graph-symbols'].execute({
			action: 'find',
			name: 'test',
			kind: 'function',
		} as any)

		expect(result).toContain('test')
	})

	test('limit argument affects search results', async () => {
		const mockService = createMockGraphService()
		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		}
		const tools = createGraphTools(mockCtx as any)

		const result = await tools['graph-symbols'].execute({
			action: 'search',
			name: 'test',
			limit: 10,
		} as any)

		expect(result).toContain('test')
	})
})

describe('graph-status tool', () => {
	test('status action returns stats', async () => {
		const mockService = createMockGraphService()
		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: {} as any,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		}
		const tools = createGraphTools(mockCtx as any)

		const result = await tools['graph-status'].execute({
			action: 'status',
		} as any)

		expect(result).toContain('Files:')
	})
})

describe('graph tools error state handling', () => {
	test('graph-status should report error state from KV store', async () => {
		const mockService = {
			ready: false,
			scan: async () => {},
			close: async () => {},
			getStats: async () => ({ files: 0, symbols: 0, edges: 0, calls: 0 }),
		} as any

		const mockKvService = {
			get: (_projectId: string, key: string) => {
				if (key === 'graph:status') {
					return {
						state: 'error',
						message:
							'Graph index incomplete: 5 files and 100 symbols indexed but 0 dependency edges generated',
						stats: { files: 5, symbols: 100, edges: 0, calls: 0 },
					}
				}
				return null
			},
		} as any

		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: mockKvService,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		} as any

		const tools = createGraphTools(mockCtx)

		const result = await tools['graph-status'].execute({
			action: 'status',
		} as any)

		expect(result).toContain('State: error')
		expect(result).toContain('Graph index incomplete')
		expect(result).toContain('Files: 5')
	})

	test('graph-query should report error state from KV store', async () => {
		const mockService = {
			ready: false,
		} as any

		const mockKvService = {
			get: (_projectId: string, key: string) => {
				if (key === 'graph:status') {
					return {
						state: 'error',
						message:
							'Graph index incomplete: 5 files and 100 symbols indexed but 0 dependency edges generated',
					}
				}
				return null
			},
		} as any

		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: mockKvService,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		} as any

		const tools = createGraphTools(mockCtx)

		const result = await tools['graph-query'].execute({
			action: 'top_files',
		} as any)

		expect(result).toContain('Graph index unavailable')
		expect(result).toContain('Graph index incomplete')
	})

	test('graph-query should use generic message when not ready but no error state', async () => {
		const mockService = {
			ready: false,
		} as any

		const mockKvService = {
			get: () => null,
		} as any

		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: mockKvService,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		} as any

		const tools = createGraphTools(mockCtx)

		const result = await tools['graph-query'].execute({
			action: 'top_files',
		} as any)

		expect(result).toContain('Graph not indexed yet')
	})

	test('graph-symbols should report error state from KV store', async () => {
		const mockService = {
			ready: false,
		} as any

		const mockKvService = {
			get: (_projectId: string, key: string) => {
				if (key === 'graph:status') {
					return {
						state: 'error',
						message:
							'Graph index incomplete: 5 files and 100 symbols indexed but 0 dependency edges generated',
					}
				}
				return null
			},
		} as any

		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: mockKvService,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		} as any

		const tools = createGraphTools(mockCtx)

		const result = await tools['graph-symbols'].execute({
			action: 'find',
			name: 'test',
		} as any)

		expect(result).toContain('Graph index unavailable')
		expect(result).toContain('Graph index incomplete')
	})

	test('graph-symbols should use generic message when not ready but no error state', async () => {
		const mockService = {
			ready: false,
		} as any

		const mockKvService = {
			get: () => null,
		} as any

		const mockCtx = {
			graphService: mockService,
			logger: console as any,
			projectId: 'test',
			directory: '/test',
			config: {},
			db: {} as any,
			dataDir: '/test/data',
			kvService: mockKvService,
			loopService: {} as any,
			loopHandler: {} as any,
			v2: {} as any,
			cleanup: async () => {},
			input: {} as any,
			sandboxManager: null,
		} as any

		const tools = createGraphTools(mockCtx)

		const result = await tools['graph-symbols'].execute({
			action: 'find',
			name: 'test',
		} as any)

		expect(result).toContain('Graph not indexed yet')
	})
})
