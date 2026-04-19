import { describe, expect, test } from 'bun:test'
import { TelemetryCollector } from '../src/runtime/telemetry'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'

const logger = {
	log: (_msg: string) => {},
	error: (_msg: string, _err?: unknown) => {},
}

describe('telemetry emit', () => {
	test('records and queries events when enabled', () => {
		const dbPath = join(tmpdir(), `telemetry-test-${Date.now()}.db`)
		const db = new Database(dbPath)
		const collector = new TelemetryCollector(logger, { enabled: true })
		collector.init(db as unknown as Parameters<TelemetryCollector['init']>[0])

		collector.record({
			type: 'loop_outcome',
			sessionId: 's1',
			projectId: 'p1',
			data: { loopName: 'test-loop', reason: 'completed', iterations: 5 },
		})
		collector.record({
			type: 'recovery',
			sessionId: 's1',
			data: { action: 'timeout_backoff', model: 'openai/gpt-5.4', success: true },
		})

		const events = collector.query({ sessionId: 's1' })
		expect(events.length).toBe(2)
		expect(events.some(e => e.type === 'loop_outcome')).toBe(true)
		expect(events.some(e => e.type === 'recovery')).toBe(true)

		collector.close()
		db.close()
	})

	test('getStats returns aggregate counts by type', () => {
		const dbPath = join(tmpdir(), `telemetry-stats-${Date.now()}.db`)
		const db = new Database(dbPath)
		const collector = new TelemetryCollector(logger, { enabled: true })
		collector.init(db as unknown as Parameters<TelemetryCollector['init']>[0])

		collector.record({ type: 'budget_warning', data: { agent: 'forge' } })
		collector.record({ type: 'budget_warning', data: { agent: 'muse' } })
		collector.record({ type: 'budget_violation', data: { agent: 'forge' } })

		const stats = collector.getStats()
		expect(stats.totalEvents).toBe(3)
		expect(stats.byType['budget_warning']).toBe(2)
		expect(stats.byType['budget_violation']).toBe(1)

		collector.close()
		db.close()
	})

	test('does not record events when disabled', () => {
		const collector = new TelemetryCollector(logger, { enabled: false })

		collector.record({ type: 'loop_outcome', data: { reason: 'completed' } })

		const events = collector.query()
		expect(events.length).toBe(0)

		collector.close()
	})
})
