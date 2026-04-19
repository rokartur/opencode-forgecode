import { describe, expect, test } from 'bun:test'
import { classifyModelError, resolveFallbackModelEntries, retryWithModelFallback } from '../src/utils/model-fallback'
import { SessionRecoveryManager } from '../src/runtime/session-recovery'

const logger = {
	log: (_message: string) => {},
	error: (_message: string, _err?: unknown) => {},
}

describe('model fallback utilities', () => {
	test('resolveFallbackModelEntries supports mixed string and object entries', () => {
		const result = resolveFallbackModelEntries([
			'openai/gpt-5.4-mini',
			{ model: 'anthropic/claude-sonnet-4', temperature: 0.1, maxTokens: 2048 },
		])

		expect(result).toEqual([
			{
				providerID: 'openai',
				modelID: 'gpt-5.4-mini',
				model: 'openai/gpt-5.4-mini',
			},
			{
				providerID: 'anthropic',
				modelID: 'claude-sonnet-4',
				model: 'anthropic/claude-sonnet-4',
				temperature: 0.1,
				maxTokens: 2048,
			},
		])
	})

	test('retryWithModelFallback walks fallback chain before default model', async () => {
		const calls: string[] = []
		const primary = { providerID: 'anthropic', modelID: 'claude-opus-4' }

		const result = await retryWithModelFallback(
			async model => {
				calls.push(model.model)
				if (model.model === 'openai/gpt-5.4-mini') {
					return { data: 'ok' }
				}
				return { error: { name: 'ProviderError', message: `${model.model} unavailable` } }
			},
			async () => {
				calls.push('default')
				return { data: 'default' }
			},
			primary,
			logger,
			{
				maxRetries: 1,
				fallbackModels: ['anthropic/claude-sonnet-4', 'openai/gpt-5.4-mini'],
			},
		)

		expect(calls).toEqual(['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'openai/gpt-5.4-mini'])
		expect(result.usedModel).toEqual({
			providerID: 'openai',
			modelID: 'gpt-5.4-mini',
		})
		expect(result.result.data).toBe('ok')
	})

	test('retryWithModelFallback applies context-window recovery before default fallback', async () => {
		const calls: string[] = []
		let recovered = false
		const primary = { providerID: 'openai', modelID: 'gpt-5.4' }

		const result = await retryWithModelFallback(
			async model => {
				calls.push(model.model)
				if (!recovered) {
					return { error: { name: 'ContextWindowError', message: 'context window exceeded' } }
				}
				return { data: 'recovered' }
			},
			async () => {
				calls.push('default')
				return { data: 'default' }
			},
			primary,
			logger,
			{
				maxRetries: 2,
				onContextWindowError: async () => {
					recovered = true
					return true
				},
			},
		)

		expect(calls).toEqual(['openai/gpt-5.4', 'openai/gpt-5.4'])
		expect(result.usedModel).toEqual(primary)
		expect(result.result.data).toBe('recovered')
	})

	test('classifyModelError recognizes context window and overload errors', () => {
		expect(classifyModelError({ message: 'context window exceeded for prompt' }).kind).toBe('context_window')
		expect(classifyModelError({ message: 'provider overloaded 529' }).kind).toBe('overloaded')
	})

	test('retryWithModelFallback with recoveryManager retries timeouts within a candidate', async () => {
		const recoveryManager = new SessionRecoveryManager(logger, {
			maxTimeoutRetries: 2,
			initialBackoffMs: 1,
			maxBackoffMs: 2,
		})
		let attempts = 0
		const primary = { providerID: 'openai', modelID: 'gpt-5.4' }

		const result = await retryWithModelFallback(
			async model => {
				attempts++
				if (attempts <= 2) {
					return { error: new Error('Request timed out') }
				}
				return { data: `ok-from-${model.model}` }
			},
			async () => ({ data: 'default' }),
			primary,
			logger,
			{
				maxRetries: 1,
				recoveryManager,
				recoverySessionId: 'test-session',
			},
		)

		// withRecovery should have retried the timeout internally before giving up
		expect(attempts).toBeGreaterThan(1)
		expect(result.result.data).toBe('ok-from-openai/gpt-5.4')
		expect(result.usedModel).toEqual(primary)
		// Recovery events should be recorded
		expect(recoveryManager.getEvents().some(e => e.action === 'timeout_backoff')).toBe(true)
	})

	test('retryWithModelFallback with recoveryManager retries overloaded errors within a candidate', async () => {
		const recoveryManager = new SessionRecoveryManager(logger, {
			maxOverloadRetries: 2,
			initialBackoffMs: 1,
			maxBackoffMs: 2,
		})
		let attempts = 0
		const primary = { providerID: 'anthropic', modelID: 'claude-opus-4' }

		const result = await retryWithModelFallback(
			async model => {
				attempts++
				if (attempts <= 1) {
					return { error: new Error('Server overloaded 529') }
				}
				return { data: `ok-from-${model.model}` }
			},
			async () => ({ data: 'default' }),
			primary,
			logger,
			{
				maxRetries: 1,
				recoveryManager,
				recoverySessionId: 'test-session-overload',
			},
		)

		expect(attempts).toBe(2)
		expect(result.result.data).toBe('ok-from-anthropic/claude-opus-4')
		expect(recoveryManager.getEvents().some(e => e.action === 'overload_backoff')).toBe(true)
	})

	test('retryWithModelFallback with recoveryManager falls to next candidate on provider errors', async () => {
		const recoveryManager = new SessionRecoveryManager(logger, {
			initialBackoffMs: 1,
			maxBackoffMs: 2,
		})
		const calls: string[] = []
		const primary = { providerID: 'openai', modelID: 'gpt-5.4' }

		const result = await retryWithModelFallback(
			async model => {
				calls.push(model.model)
				if (model.model === 'openai/gpt-5.4') {
					return { error: new Error('ProviderError: authentication failed') }
				}
				return { data: `ok-from-${model.model}` }
			},
			async () => {
				calls.push('default')
				return { data: 'default' }
			},
			primary,
			logger,
			{
				maxRetries: 1,
				fallbackModels: ['anthropic/claude-sonnet-4'],
				recoveryManager,
				recoverySessionId: 'test-session-provider',
			},
		)

		// Provider error should NOT be retried by recovery — should fall to next candidate
		expect(calls).toEqual(['openai/gpt-5.4', 'anthropic/claude-sonnet-4'])
		expect(result.result.data).toBe('ok-from-anthropic/claude-sonnet-4')
	})

	test('retryWithModelFallback with recoveryManager delegates context-window to recovery callback', async () => {
		const recoveryManager = new SessionRecoveryManager(logger, {
			maxContextRetries: 2,
			initialBackoffMs: 1,
		})
		let callCount = 0
		let contextRecoveryCalled = false
		const primary = { providerID: 'openai', modelID: 'gpt-5.4' }

		const result = await retryWithModelFallback(
			async model => {
				callCount++
				if (callCount === 1) {
					return { error: new Error('context window exceeded') }
				}
				return { data: `ok-from-${model.model}` }
			},
			async () => ({ data: 'default' }),
			primary,
			logger,
			{
				maxRetries: 2,
				recoveryManager,
				recoverySessionId: 'test-context',
				onContextWindowError: async () => {
					contextRecoveryCalled = true
					return true
				},
			},
		)

		// Context recovery should be delegated to the recovery manager's onContextOverflow
		// which in turn calls our onContextWindowError
		expect(contextRecoveryCalled).toBe(true)
		expect(result.result.data).toBe('ok-from-openai/gpt-5.4')
		expect(recoveryManager.getEvents().some(e => e.action === 'compaction_retry')).toBe(true)
	})
})
