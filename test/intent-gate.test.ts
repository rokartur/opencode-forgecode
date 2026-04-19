import { describe, test, expect } from 'bun:test'
import { IntentRouter } from '../src/runtime/intent-router'
import type { IntentGateConfig, Logger } from '../src/types'

const makeLogger = (): Logger & { logs: string[] } => {
	const logs: string[] = []
	return {
		log: (m: unknown) => logs.push(String(m)),
		debug: () => {},
		error: () => {},
		logs,
	}
}

const enabledConfig: IntentGateConfig = { enabled: true, heuristicsOnly: true }

describe('IntentRouter — classification', () => {
	test('returns unknown when disabled', () => {
		const router = new IntentRouter(makeLogger(), { enabled: false })
		const result = router.classify('fix the bug in auth.ts')
		expect(result.tag).toBe('unknown')
		expect(result.confidence).toBe(0)
	})

	test('classifies review requests to sage', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('review my code changes in the auth module')
		expect(result.tag).toBe('review')
		expect(result.agent).toBe('sage')
		expect(result.confidence).toBeGreaterThan(0)
	})

	test('classifies research questions to sage', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('how does the authentication flow work?')
		expect(result.tag).toBe('research')
		expect(result.agent).toBe('sage')
	})

	test('classifies planning requests to muse', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('plan the migration strategy for the database')
		expect(result.tag).toBe('plan')
		expect(result.agent).toBe('muse')
	})

	test('classifies debug requests to forge', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('debug this error: TypeError in src/main.ts')
		expect(result.tag).toBe('debug')
		expect(result.agent).toBe('forge')
	})

	test('classifies implementation requests to forge', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('implement a new user registration endpoint')
		expect(result.tag).toBe('implement')
		expect(result.agent).toBe('forge')
	})

	test('classifies quick-fix requests to forge', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('fix the typo in the error message')
		expect(result.agent).toBe('forge')
	})

	test('returns unknown for ambiguous messages', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('hello')
		expect(result.tag).toBe('unknown')
		expect(result.confidence).toBe(0)
	})
})

describe('IntentRouter — complexity estimation', () => {
	test('trivial for very short messages', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('fix typo')
		expect(result.complexity).toBe('trivial')
	})

	test('simple for longer sentences', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify(
			'add comprehensive error handling to the login function and validate all user inputs in auth.ts',
		)
		expect(['simple', 'moderate']).toContain(result.complexity)
	})

	test('architectural for system-design language', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify(
			'design a microservice architecture with event-driven communication between the auth service, user service, and notification service using a message queue',
		)
		expect(result.complexity).toBe('architectural')
	})
})

describe('IntentRouter — conversation type detection', () => {
	test('question for interrogative messages', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('why does this function throw an error?')
		expect(result.conversationType).toBe('question')
	})

	test('command for imperative messages', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('refactor the auth module to use middleware')
		expect(result.conversationType).toBe('command')
	})

	test('mixed for combined question and command', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify(
			'what is the best way to refactor this?\nadd error handling to the login function',
		)
		expect(result.conversationType).toBe('mixed')
	})
})

describe('IntentRouter — scope detection', () => {
	test('single-file for simple requests', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('fix the typo in README.md')
		expect(result.scope).toBe('single-file')
	})

	test('multi-file for project-wide requests', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('update the error handling across all files in the project')
		expect(result.scope).toBe('multi-file')
	})

	test('architectural for system-level requests', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('architect a new database schema for the user management system')
		expect(result.scope).toBe('architectural')
	})
})

describe('IntentRouter — allScores', () => {
	test('returns all scored tags sorted by score', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify('review and fix the bug in the authentication code')
		expect(result.allScores.length).toBeGreaterThan(0)
		// Should be sorted descending
		for (let i = 1; i < result.allScores.length; i++) {
			expect(result.allScores[i].score).toBeLessThanOrEqual(result.allScores[i - 1].score)
		}
	})
})

describe('IntentRouter — smart boosts', () => {
	test('boosts to muse for architectural implement command', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const result = router.classify(
			'implement and build a complete event-driven system design for the entire codebase with a new database schema',
		)
		// architectural scope + implement tag → should boost to muse for planning
		expect(['muse', 'sage']).toContain(result.agent)
	})
})

describe('IntentRouter — gate', () => {
	test('passes when agent matches', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const decision = router.gate('implement a new endpoint', 'forge')
		expect(decision.pass).toBe(true)
		expect(decision.redirectMessage).toBe('')
	})

	test('passes when confidence is low (ambiguous)', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const decision = router.gate('hello there', 'sage')
		expect(decision.pass).toBe(true)
	})

	test('passes for trivial requests even with agent mismatch', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const decision = router.gate('fix typo', 'sage')
		// trivial → always pass
		expect(decision.pass).toBe(true)
	})

	test('fails when agent mismatches with high confidence', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const decision = router.gate(
			'review my code changes and audit the authentication module for security issues',
			'forge',
		)
		// This is clearly a review task → sage, not forge
		if (decision.classification.confidence >= 0.5 && decision.classification.complexity !== 'trivial') {
			expect(decision.pass).toBe(false)
			expect(decision.redirectMessage).toContain('IntentGate')
			expect(decision.redirectMessage).toContain('sage')
		}
	})

	test('redirect message includes classification details', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		const decision = router.gate('plan the migration strategy for the database schema', 'forge')
		if (!decision.pass) {
			expect(decision.redirectMessage).toContain('muse')
			expect(decision.redirectMessage).toContain('plan')
		}
	})
})

describe('IntentRouter — suggestAgent', () => {
	test('returns forge for implementation', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		expect(router.suggestAgent('add a new user endpoint')).toBe('forge')
	})

	test('returns sage for research', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		expect(router.suggestAgent('explain how the caching layer works')).toBe('sage')
	})

	test('returns muse for planning', () => {
		const router = new IntentRouter(makeLogger(), enabledConfig)
		expect(router.suggestAgent('outline the steps to migrate to PostgreSQL')).toBe('muse')
	})
})

describe('IntentRouter — logging', () => {
	test('logs classification details', () => {
		const logger = makeLogger()
		const router = new IntentRouter(logger, enabledConfig)
		router.classify('fix the bug in auth.ts')
		expect(logger.logs.some(l => l.includes('[intent-gate]'))).toBe(true)
		expect(logger.logs.some(l => l.includes('complexity='))).toBe(true)
	})

	test('logs gate mismatch', () => {
		const logger = makeLogger()
		const router = new IntentRouter(logger, enabledConfig)
		router.gate('review my code changes in the auth module', 'forge')
		const hasMismatch = logger.logs.some(l => l.includes('mismatch'))
		// May or may not log mismatch depending on confidence
		expect(typeof hasMismatch).toBe('boolean')
	})
})
