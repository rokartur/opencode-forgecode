import { describe, expect, it } from 'bun:test'
import { isSqliteBusyError, withSqliteBusyRetry } from '../src/graph/retry'

describe('isSqliteBusyError', () => {
	it('detects SQLITE_BUSY code', () => {
		expect(isSqliteBusyError({ code: 'SQLITE_BUSY', message: 'x' })).toBe(true)
	})

	it('detects SQLITE_LOCKED code', () => {
		expect(isSqliteBusyError({ code: 'SQLITE_LOCKED', message: 'x' })).toBe(true)
	})

	it("detects 'database is locked' message", () => {
		expect(isSqliteBusyError(new Error('database is locked'))).toBe(true)
	})

	it("detects 'database table is locked' message", () => {
		expect(isSqliteBusyError(new Error('database table is locked: files'))).toBe(true)
	})

	it('is case-insensitive for messages', () => {
		expect(isSqliteBusyError(new Error('Database Is Locked'))).toBe(true)
		expect(isSqliteBusyError(new Error('SQLITE_BUSY: busy'))).toBe(true)
	})

	it('rejects unrelated errors', () => {
		expect(isSqliteBusyError(new Error('no such table'))).toBe(false)
		expect(isSqliteBusyError({ code: 'SQLITE_CONSTRAINT' })).toBe(false)
		expect(isSqliteBusyError(null)).toBe(false)
		expect(isSqliteBusyError(undefined)).toBe(false)
		expect(isSqliteBusyError('string')).toBe(false)
	})
})

describe('withSqliteBusyRetry', () => {
	// Use tiny delays to keep tests fast.
	const fastDelays = [1, 1, 1, 1, 1] as const

	it('returns result on first success without retry', async () => {
		let calls = 0
		const result = await withSqliteBusyRetry(() => {
			calls += 1
			return 42
		}, fastDelays)
		expect(result).toBe(42)
		expect(calls).toBe(1)
	})

	it('retries on SQLITE_BUSY and eventually succeeds', async () => {
		let calls = 0
		const result = await withSqliteBusyRetry(() => {
			calls += 1
			if (calls < 3) {
				const err = new Error('database is locked')
				;(err as { code?: string }).code = 'SQLITE_BUSY'
				throw err
			}
			return 'ok'
		}, fastDelays)
		expect(result).toBe('ok')
		expect(calls).toBe(3)
	})

	it('propagates non-busy errors immediately without retry', async () => {
		let calls = 0
		await expect(
			withSqliteBusyRetry(() => {
				calls += 1
				throw new Error('no such column: foo')
			}, fastDelays),
		).rejects.toThrow('no such column')
		expect(calls).toBe(1)
	})

	it('re-throws after exhausting retries', async () => {
		let calls = 0
		const makeBusy = () => {
			const err = new Error('database is locked')
			;(err as { code?: string }).code = 'SQLITE_BUSY'
			return err
		}
		await expect(
			withSqliteBusyRetry(() => {
				calls += 1
				throw makeBusy()
			}, fastDelays),
		).rejects.toThrow('database is locked')
		// 1 initial attempt + fastDelays.length retries = 6 total
		expect(calls).toBe(fastDelays.length + 1)
	})

	it('supports async functions', async () => {
		let calls = 0
		const result = await withSqliteBusyRetry(async () => {
			calls += 1
			if (calls === 1) {
				const err = new Error('SQLITE_BUSY: busy')
				;(err as { code?: string }).code = 'SQLITE_BUSY'
				throw err
			}
			return 'async-ok'
		}, fastDelays)
		expect(result).toBe('async-ok')
		expect(calls).toBe(2)
	})
})
