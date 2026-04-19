import { describe, test, expect, beforeEach } from 'bun:test'
import { createSessionRetryHooks } from '../src/hooks/session-retry'
import type { LoopService } from '../src/services/loop'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { Logger } from '../src/types'

function makeLogger(): Logger {
	return { log: () => {}, error: () => {}, debug: () => {} }
}

function makeLoopService(loopName: string | null): LoopService {
	return {
		resolveLoopName: () => loopName,
	} as unknown as LoopService
}

interface MockCall {
	sessionID: string
	parts: unknown
	agent?: string
}

function makeV2(calls: MockCall[], fail = false): OpencodeClient {
	return {
		session: {
			promptAsync: async (args: MockCall) => {
				calls.push(args)
				return fail ? { error: 'mock-fail' } : { data: {} }
			},
		},
	} as unknown as OpencodeClient
}

function userMessage(sessionID: string, id: string, text: string, agent?: string) {
	return {
		info: { role: 'user' as const, id, sessionID, agent },
		parts: [{ type: 'text', text }],
	}
}

describe('session-retry hook', () => {
	let calls: MockCall[]
	beforeEach(() => {
		calls = []
	})

	test('retries non-loop session on timeout error', async () => {
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService(null),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})

		hooks.onMessagesTransform({ messages: [userMessage('s1', 'm1', 'hello world', 'forge')] })

		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'ProviderTimeout', data: { message: 'request timed out' } },
				},
			},
		})

		expect(calls.length).toBe(1)
		expect(calls[0].sessionID).toBe('s1')
		expect(calls[0].agent).toBe('forge')
	})

	test('does not retry when session is a loop', async () => {
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService('my-loop'),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})
		hooks.onMessagesTransform({ messages: [userMessage('s1', 'm1', 'hello')] })
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { name: 'x', data: { message: 'timed out' } } },
			},
		})
		expect(calls.length).toBe(0)
	})

	test('does not retry user-initiated abort', async () => {
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService(null),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})
		hooks.onMessagesTransform({ messages: [userMessage('s1', 'm1', 'hello')] })
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { name: 'MessageAbortedError' } },
			},
		})
		expect(calls.length).toBe(0)
	})

	test('retries MessageAbortedError when message indicates a stream timeout', async () => {
		// Provider stream-timeouts (e.g. tool-call args like a big `patch` payload
		// that times out mid-stream, surfaces in the TUI as
		// "~ Preparing patch... / Tool execution aborted / The operation timed out")
		// share the MessageAbortedError name with a user Esc. Disambiguate by
		// message content.
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService(null),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})
		hooks.onMessagesTransform({ messages: [userMessage('s1', 'm1', 'hello', 'forge')] })
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: {
						name: 'MessageAbortedError',
						data: { message: 'Tool execution aborted. The operation timed out.' },
					},
				},
			},
		})
		expect(calls.length).toBe(1)
		expect(calls[0].sessionID).toBe('s1')
		expect(calls[0].agent).toBe('forge')
	})

	test('does not retry non-timeout errors', async () => {
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService(null),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})
		hooks.onMessagesTransform({ messages: [userMessage('s1', 'm1', 'hello')] })
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: {
					sessionID: 's1',
					error: { name: 'ValidationError', data: { message: 'invalid request' } },
				},
			},
		})
		expect(calls.length).toBe(0)
	})

	test('retries at most once per messageID', async () => {
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService(null),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})
		hooks.onMessagesTransform({ messages: [userMessage('s1', 'm1', 'hello')] })
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { data: { message: 'timed out' } } },
			},
		})
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: { sessionID: 's1', error: { data: { message: 'timed out' } } },
			},
		})
		expect(calls.length).toBe(1)
	})

	test('skips retry when no cached prompt', async () => {
		const hooks = createSessionRetryHooks({
			loopService: makeLoopService(null),
			v2: makeV2(calls),
			directory: '/tmp',
			logger: makeLogger(),
			backoffMs: 1,
		})
		await hooks.onEvent({
			event: {
				type: 'session.error',
				properties: { sessionID: 's-unknown', error: { data: { message: 'timed out' } } },
			},
		})
		expect(calls.length).toBe(0)
	})
})
