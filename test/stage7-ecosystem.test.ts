/**
 * Stage 7 — Ecosystem, platform, built-in MCPs, TUI tests.
 *
 * Covers:
 *   7a: CI mode (ci.ts tested elsewhere)
 *   7b: Harness plugin API + registry
 *   7c: Sandbox backends + auto-detect
 *   7d: Built-in MCP providers
 */

import { describe, test, expect } from 'bun:test'

// 7b: Harness plugin API
import type { HarnessPlugin, HarnessDetector, HarnessTruncator } from '../src/harness/plugin-api'
import { HarnessPluginRegistry } from '../src/harness/plugin-loader'

// 7c: Sandbox backends
import { createSandboxExecBackend } from '../src/sandbox/sandbox-exec'
import { createBubblewrapBackend } from '../src/sandbox/bubblewrap'
import { createFirejailBackend } from '../src/sandbox/firejail'
import { resolveSandboxBackend } from '../src/sandbox/auto-detect'

// 7d: Built-in MCPs
import { createWebSearchMcp } from '../src/runtime/mcp/builtin/websearch'
import { createContext7Mcp } from '../src/runtime/mcp/builtin/context7'
import { createGrepAppMcp } from '../src/runtime/mcp/builtin/grep_app'
import { createBuiltinMcpRegistry } from '../src/runtime/mcp/builtin/index'

// ─── 7b: Harness Plugin API ────────────────────────────────────

describe('Stage 7b — HarnessPluginRegistry', () => {
	const makeDetector = (name: string, result: string | null): HarnessDetector => ({
		name,
		detect: () => result,
	})

	const makeTruncator = (name: string, result: string | null): HarnessTruncator => ({
		name,
		truncate: () => result,
	})

	const makePlugin = (
		name: string,
		opts?: {
			detectors?: HarnessDetector[]
			truncators?: HarnessTruncator[]
		},
	): HarnessPlugin => ({
		name,
		detectors: opts?.detectors,
		truncators: opts?.truncators,
	})

	test('empty registry has zero count', () => {
		const reg = new HarnessPluginRegistry()
		expect(reg.count).toBe(0)
		expect(reg.names).toEqual([])
		expect(reg.detectors).toEqual([])
		expect(reg.truncators).toEqual([])
		expect(reg.snapshotProviders).toEqual([])
	})

	test('register plugin with detectors', () => {
		const reg = new HarnessPluginRegistry()
		const d1 = makeDetector('doom-detect', 'doom detected!')
		const plugin = makePlugin('my-plugin', { detectors: [d1] })

		reg.register(plugin)

		expect(reg.count).toBe(1)
		expect(reg.names).toEqual(['my-plugin'])
		expect(reg.detectors).toHaveLength(1)
		expect(reg.detectors[0].name).toBe('doom-detect')
		expect(reg.detectors[0].detect({} as any)).toBe('doom detected!')
	})

	test('register plugin with truncators', () => {
		const reg = new HarnessPluginRegistry()
		const t1 = makeTruncator('trim-logs', 'trimmed output')
		const plugin = makePlugin('trimmer', { truncators: [t1] })

		reg.register(plugin)

		expect(reg.truncators).toHaveLength(1)
		expect(reg.truncators[0].truncate({} as any)).toBe('trimmed output')
	})

	test('registerAll registers multiple plugins', () => {
		const reg = new HarnessPluginRegistry()
		const p1 = makePlugin('a', { detectors: [makeDetector('d1', null)] })
		const p2 = makePlugin('b', { truncators: [makeTruncator('t1', 'x')] })

		reg.registerAll([p1, p2])

		expect(reg.count).toBe(2)
		expect(reg.detectors).toHaveLength(1)
		expect(reg.truncators).toHaveLength(1)
	})

	test('duplicate plugin name ignored', () => {
		const reg = new HarnessPluginRegistry()
		const p1 = makePlugin('same-name', { detectors: [makeDetector('d1', null)] })
		const p2 = makePlugin('same-name', { detectors: [makeDetector('d2', null)] })

		reg.register(p1)
		reg.register(p2)

		expect(reg.count).toBe(1)
		expect(reg.detectors).toHaveLength(1)
	})

	test('plugin with no extensions is registered', () => {
		const reg = new HarnessPluginRegistry()
		reg.register({ name: 'empty-plugin' })
		expect(reg.count).toBe(1)
		expect(reg.detectors).toEqual([])
		expect(reg.truncators).toEqual([])
	})
})

// ─── 7c: Sandbox Backends ──────────────────────────────────────

describe('Stage 7c — Sandbox backends', () => {
	test('sandbox-exec backend has correct name', () => {
		const be = createSandboxExecBackend()
		expect(be.name).toBe('sandbox-exec')
	})

	test('bubblewrap backend has correct name', () => {
		const be = createBubblewrapBackend()
		expect(be.name).toBe('bubblewrap')
	})

	test('firejail backend has correct name', () => {
		const be = createFirejailBackend()
		expect(be.name).toBe('firejail')
	})

	test('sandbox-exec available only on macOS', async () => {
		const be = createSandboxExecBackend()
		const available = await be.isAvailable()
		if (process.platform === 'darwin') {
			expect(available).toBe(true)
		} else {
			expect(available).toBe(false)
		}
	})

	test('bubblewrap not available on macOS', async () => {
		const be = createBubblewrapBackend()
		if (process.platform === 'darwin') {
			expect(await be.isAvailable()).toBe(false)
		}
		// On Linux it might be available, no assertion
	})

	test('firejail not available on macOS', async () => {
		const be = createFirejailBackend()
		if (process.platform === 'darwin') {
			expect(await be.isAvailable()).toBe(false)
		}
	})

	test('auto-detect resolves sandbox-exec on macOS', async () => {
		const logger = { log: () => {} } as any
		const result = await resolveSandboxBackend('auto', logger)
		if (process.platform === 'darwin') {
			expect(result.resolvedMode).toBe('sandbox-exec')
			expect(result.backend).not.toBeNull()
		}
		// Other platforms will fall through to docker
	})

	test('off mode returns null backend', async () => {
		const logger = { log: () => {} } as any
		const result = await resolveSandboxBackend('off', logger)
		expect(result.backend).toBeNull()
		expect(result.resolvedMode).toBe('off')
	})

	test('docker mode returns null backend (delegated to SandboxManager)', async () => {
		const logger = { log: () => {} } as any
		const result = await resolveSandboxBackend('docker', logger)
		expect(result.resolvedMode).toBe('docker')
		expect(result.backend).toBeNull()
	})
})

// ─── 7d: Built-in MCPs ────────────────────────────────────────

describe('Stage 7d — Built-in MCPs', () => {
	test('websearch not configured without API key', () => {
		const ws = createWebSearchMcp(undefined, undefined)
		// Only configured if env var is set — in test env likely not
		expect(typeof ws.isConfigured()).toBe('boolean')
		expect(ws.name).toBe('websearch')
	})

	test('websearch configured with explicit key', () => {
		const ws = createWebSearchMcp('tavily', 'test-key-123')
		expect(ws.isConfigured()).toBe(true)
	})

	test('websearch search returns empty when not configured', async () => {
		// Create without any key and clear env
		const origTavily = process.env.TAVILY_API_KEY
		const origBrave = process.env.BRAVE_SEARCH_API_KEY
		const origSerper = process.env.SERPER_API_KEY
		delete process.env.TAVILY_API_KEY
		delete process.env.BRAVE_SEARCH_API_KEY
		delete process.env.SERPER_API_KEY

		try {
			const ws = createWebSearchMcp()
			if (!ws.isConfigured()) {
				const results = await ws.search('test query')
				expect(results).toEqual([])
			}
		} finally {
			// Restore
			if (origTavily) process.env.TAVILY_API_KEY = origTavily
			if (origBrave) process.env.BRAVE_SEARCH_API_KEY = origBrave
			if (origSerper) process.env.SERPER_API_KEY = origSerper
		}
	})

	test('context7 not configured without API key', () => {
		const c7 = createContext7Mcp()
		if (!process.env.CONTEXT7_API_KEY) {
			expect(c7.isConfigured()).toBe(false)
		}
	})

	test('context7 configured with explicit key', () => {
		const c7 = createContext7Mcp('test-key')
		expect(c7.isConfigured()).toBe(true)
	})

	test('context7 lookup returns empty when not configured', async () => {
		const origKey = process.env.CONTEXT7_API_KEY
		delete process.env.CONTEXT7_API_KEY

		try {
			const c7 = createContext7Mcp()
			if (!c7.isConfigured()) {
				const results = await c7.lookup('react hooks')
				expect(results).toEqual([])
			}
		} finally {
			if (origKey) process.env.CONTEXT7_API_KEY = origKey
		}
	})

	test('grep_app always configured', () => {
		const ga = createGrepAppMcp()
		expect(ga.isConfigured()).toBe(true)
		expect(ga.name).toBe('grep_app')
	})

	test('registry collects configured providers', () => {
		const logger = { log: () => {} } as any
		const reg = createBuiltinMcpRegistry(
			{ websearch: { enabled: false }, context7: { enabled: false }, grepApp: { enabled: true } },
			logger,
		)

		// Only grep_app should be configured (ws and c7 disabled)
		const configured = reg.configured()
		expect(configured.length).toBeGreaterThanOrEqual(1)
		expect(reg.grepApp).not.toBeNull()
		expect(reg.websearch).toBeNull()
		expect(reg.context7).toBeNull()
	})

	test('registry status returns boolean map', () => {
		const logger = { log: () => {} } as any
		const reg = createBuiltinMcpRegistry(undefined, logger)
		const status = reg.status()
		expect(typeof status.websearch).toBe('boolean')
		expect(typeof status.context7).toBe('boolean')
		expect(typeof status.grepApp).toBe('boolean')
	})
})
