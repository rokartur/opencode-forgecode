/**
 * Tests for tool archive service + hook + expand tool.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { createToolArchiveService } from '../src/services/tool-archive'
import { createToolArchiveAfterHook } from '../src/hooks/tool-archive'
import type { KvService } from '../src/services/kv'

const noop = (..._args: unknown[]) => {}
const logger = { log: noop, debug: noop, error: noop } as any

// Simple in-memory KV mock
function mockKv(): KvService {
	const store = new Map<string, { data: string; expiresAt: number }>()
	return {
		get<T = unknown>(_pid: string, key: string): T | null {
			const entry = store.get(key)
			if (!entry) return null
			try {
				return JSON.parse(entry.data) as T
			} catch {
				return null
			}
		},
		set<T = unknown>(_pid: string, key: string, data: T): void {
			store.set(key, { data: JSON.stringify(data), expiresAt: Date.now() + 86400000 })
		},
		delete(_pid: string, key: string): void {
			store.delete(key)
		},
		list(_pid: string) {
			return Array.from(store.entries()).map(([key, val]) => ({
				key,
				data: JSON.parse(val.data),
				updatedAt: Date.now(),
				expiresAt: val.expiresAt,
			}))
		},
		listByPrefix(_pid: string, prefix: string) {
			return Array.from(store.entries())
				.filter(([key]) => key.startsWith(prefix))
				.map(([key, val]) => ({
					key,
					data: JSON.parse(val.data),
					updatedAt: Date.now(),
					expiresAt: val.expiresAt,
				}))
		},
	}
}

describe('Tool archive service', () => {
	test('archives output exceeding threshold', () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger, { thresholdChars: 100 })

		const bigOutput = 'x'.repeat(200)
		const result = service.archive('sess1', 'grep', bigOutput)

		expect(result.id).toBeDefined()
		expect(result.charCount).toBe(200)
		expect(result.preview).toBeTruthy()

		// Retrieve
		const full = service.retrieve(result.id)
		expect(full).toBe(bigOutput)
	})

	test('returns null for unknown archive ID', () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger)
		expect(service.retrieve('nonexistent')).toBeNull()
	})

	test('lists archives for a session', () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger, { thresholdChars: 10 })

		service.archive('sess1', 'grep', 'x'.repeat(100))
		service.archive('sess1', 'shell', 'y'.repeat(200))
		service.archive('sess2', 'grep', 'z'.repeat(50))

		const list = service.list('sess1')
		expect(list.length).toBe(2)
		expect(list[0].toolName).toBeTruthy()
	})

	test('exempt tools are identified', () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger)

		expect(service.isExempt('plan-read')).toBe(true)
		expect(service.isExempt('expand')).toBe(true)
		expect(service.isExempt('grep')).toBe(false)
		expect(service.isExempt('shell')).toBe(false)
	})
})

describe('Tool archive after hook', () => {
	test('replaces large output with preview + archive ID', async () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger, { thresholdChars: 50 })
		const hook = createToolArchiveAfterHook({ archiveService: service, logger })

		const bigOutput = Array.from({ length: 20 }, (_, i) => `line ${i}: ${'x'.repeat(10)}`).join('\n')
		const output = { title: 'grep', output: bigOutput, metadata: null }

		await hook({ tool: 'grep', sessionID: 'sess1', callID: 'c1', args: {} }, output)

		expect(output.output).toContain('truncated')
		expect(output.output).toContain('expand')
		expect(output.output).not.toBe(bigOutput)
	})

	test('skips small output', async () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger, { thresholdChars: 5000 })
		const hook = createToolArchiveAfterHook({ archiveService: service, logger })

		const smallOutput = 'hello world'
		const output = { title: 'grep', output: smallOutput, metadata: null }

		await hook({ tool: 'grep', sessionID: 'sess1', callID: 'c1', args: {} }, output)

		expect(output.output).toBe(smallOutput)
	})

	test('skips exempt tools', async () => {
		const kv = mockKv()
		const service = createToolArchiveService(kv, 'proj1', logger, { thresholdChars: 10 })
		const hook = createToolArchiveAfterHook({ archiveService: service, logger })

		const bigOutput = 'x'.repeat(100)
		const output = { title: 'plan-read', output: bigOutput, metadata: null }

		await hook({ tool: 'plan-read', sessionID: 'sess1', callID: 'c1', args: {} }, output)

		expect(output.output).toBe(bigOutput) // untouched
	})
})
