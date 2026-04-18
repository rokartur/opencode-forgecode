import { describe, test, expect } from 'bun:test'
import { createInMemoryKvService } from '../src/services/kv'

describe('createInMemoryKvService', () => {
	test('set + get roundtrip', () => {
		const kv = createInMemoryKvService()
		kv.set('p1', 'foo', { hello: 'world' })
		expect(kv.get('p1', 'foo')).toEqual({ hello: 'world' })
	})

	test('get returns null for missing key', () => {
		const kv = createInMemoryKvService()
		expect(kv.get('p1', 'missing')).toBeNull()
	})

	test('delete removes entry', () => {
		const kv = createInMemoryKvService()
		kv.set('p1', 'foo', 1)
		kv.delete('p1', 'foo')
		expect(kv.get('p1', 'foo')).toBeNull()
	})

	test('list returns entries for a project', () => {
		const kv = createInMemoryKvService()
		kv.set('p1', 'a', 1)
		kv.set('p1', 'b', 2)
		kv.set('p2', 'c', 3)
		const rows = kv.list('p1')
		expect(rows.map(r => r.key).sort()).toEqual(['a', 'b'])
	})

	test('listByPrefix filters by key prefix', () => {
		const kv = createInMemoryKvService()
		kv.set('p1', 'plan:x', 'x')
		kv.set('p1', 'plan:y', 'y')
		kv.set('p1', 'loop:z', 'z')
		const plans = kv.listByPrefix('p1', 'plan:')
		expect(plans.map(r => r.key).sort()).toEqual(['plan:x', 'plan:y'])
	})

	test('isolates projectId namespaces', () => {
		const kv = createInMemoryKvService()
		kv.set('p1', 'k', 'one')
		kv.set('p2', 'k', 'two')
		expect(kv.get('p1', 'k')).toBe('one')
		expect(kv.get('p2', 'k')).toBe('two')
	})

	test('TTL expires entries lazily on read', async () => {
		const kv = createInMemoryKvService(undefined, 20)
		kv.set('p1', 'foo', 1)
		expect(kv.get('p1', 'foo')).toBe(1)
		await new Promise(resolve => setTimeout(resolve, 40))
		expect(kv.get('p1', 'foo')).toBeNull()
	})

	test('list skips expired entries', async () => {
		const kv = createInMemoryKvService(undefined, 20)
		kv.set('p1', 'a', 1)
		await new Promise(resolve => setTimeout(resolve, 40))
		kv.set('p1', 'b', 2)
		const rows = kv.list('p1')
		expect(rows.map(r => r.key)).toEqual(['b'])
	})

	test('logs once when fallback is first used', () => {
		const logs: string[] = []
		const logger = {
			log: (msg: string) => logs.push(msg),
			error: () => {},
			debug: () => {},
		}
		const kv = createInMemoryKvService(logger as any)
		kv.set('p1', 'a', 1)
		kv.set('p1', 'b', 2)
		const kvWarnings = logs.filter(m => m.includes('in-memory fallback'))
		expect(kvWarnings.length).toBe(1)
	})
})
