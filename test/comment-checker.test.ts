import { describe, test, expect } from 'bun:test'
import { CommentChecker } from '../src/runtime/comment-checker'
import type { Logger } from '../src/types'

const makeLogger = (): Logger => ({
	log: () => {},
	debug: () => {},
	error: () => {},
})

describe('CommentChecker', () => {
	describe('disabled state', () => {
		test('returns no violations when disabled', () => {
			const checker = new CommentChecker(makeLogger(), { enabled: false })
			const result = checker.check('// This is a robust, elegant solution')
			expect(result.violations).toHaveLength(0)
			expect(result.warning).toBe('')
		})

		test('isEnabled returns false when disabled', () => {
			const checker = new CommentChecker(makeLogger(), { enabled: false })
			expect(checker.isEnabled()).toBe(false)
		})
	})

	describe('clean code', () => {
		test('no violations for legitimate comments', () => {
			const code = `
// Retry with exponential backoff because the upstream API rate-limits at 100 req/s
function retry(fn: () => Promise<void>, maxRetries = 3) {
  // 2^attempt * 100ms base delay
  for (let i = 0; i < maxRetries; i++) {
    try { await fn(); return; } catch {}
  }
}
`
			const checker = new CommentChecker(makeLogger())
			const result = checker.check(code)
			expect(result.violations).toHaveLength(0)
		})

		test('no violations for short comments', () => {
			const code = `
// TODO: fix
// HACK
// tmp
`
			const checker = new CommentChecker(makeLogger())
			const result = checker.check(code)
			expect(result.violations).toHaveLength(0)
		})

		test('no false positives on regular code without comments', () => {
			const code = `
function add(a: number, b: number): number {
  return a + b
}
`
			const checker = new CommentChecker(makeLogger())
			const result = checker.check(code)
			expect(result.violations).toHaveLength(0)
		})
	})

	describe('narration detection', () => {
		test('detects "here we" narration pattern', () => {
			const code = `
// Here we create a new instance of the database connection
const db = new Database()
// This function handles the authentication flow
function auth() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.length).toBeGreaterThanOrEqual(1)
			expect(result.violations.some(v => v.category === 'narration')).toBe(true)
		})

		test('detects "set the" obvious narration', () => {
			const code = `
// Set the value of the counter variable
let counter = 0
// Get the user from the database
const user = db.getUser(id)
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'narration')).toBe(true)
		})
	})

	describe('filler detection', () => {
		test('detects marketing-style filler words', () => {
			const code = `
// This robust and elegant solution leverages the comprehensive API
function fetchData() {}
// A seamless integration with the enterprise-grade backend
const api = new Api()
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'filler')).toBe(true)
			expect(result.warning).toContain('Comment Checker')
		})

		test('detects vague hedge words', () => {
			const code = `
// Basically this just creates a simple connection
function connect() {}
// Obviously we need to handle errors here
try {} catch {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'filler')).toBe(true)
		})

		test('detects AI disclaimer language', () => {
			const code = `
// Note that it is important to validate input before processing
// As an AI, I recommend using the following approach
function validate() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'filler')).toBe(true)
		})
	})

	describe('over-explanation detection', () => {
		test('detects syntax explanation comments', () => {
			const code = `
// It is a new function that returns a string value
function greet(): string {
  // It creates a new array of items for processing
  const items = [1, 2, 3]
  return 'hello'
}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'over-explanation')).toBe(true)
		})
	})

	describe('section-noise detection', () => {
		test('detects redundant section dividers', () => {
			const code = `
// ─────────────── Imports ───────────────
import { foo } from './foo'
// ========= Constants =========
const MAX = 100
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'section-noise')).toBe(true)
		})

		test('detects empty TODO/FIXME', () => {
			const code = `
// TODO:
function incomplete() {}
// FIXME
const broken = null
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'section-noise')).toBe(true)
		})
	})

	describe('politeness detection', () => {
		test('detects conversational tone in comments', () => {
			const code = `
// Please note that this function may throw
// Feel free to modify the timeout value
function fetchWithTimeout() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'politeness')).toBe(true)
		})
	})

	describe('changelog detection', () => {
		test('detects inline changelog comments', () => {
			const code = `
// Added by John on 2024-03-15
// Changed to use async/await for better performance
function process() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.some(v => v.category === 'changelog')).toBe(true)
		})
	})

	describe('block comments', () => {
		test('detects slop in block comments', () => {
			const code = `
/**
 * This is a robust and comprehensive solution that leverages
 * the power of the enterprise-grade API
 */
function doStuff() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.length).toBeGreaterThanOrEqual(1)
		})

		test('handles multi-line block comments', () => {
			const code = `
/*
 * Here we initialize the database connection
 * This creates a new instance of the connection pool
 */
const pool = createPool()
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe('hash comments', () => {
		test('detects slop in hash-style comments', () => {
			const code = `
# Here we define the robust configuration
CONFIG = {}
# This basically just sets up the connection
connect()
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.violations.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe('minViolations threshold', () => {
		test('no warning when violations below threshold', () => {
			const code = `
// Here we do the thing
function doThing() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 5 })
			const result = checker.check(code)
			expect(result.violations.length).toBeGreaterThanOrEqual(1)
			expect(result.warning).toBe('') // below threshold
		})

		test('warning when violations meet threshold', () => {
			const code = `
// Here we create the service
// This function handles the connection
// Basically this just sets up the pool
function setup() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 2 })
			const result = checker.check(code)
			expect(result.violations.length).toBeGreaterThanOrEqual(2)
			expect(result.warning).not.toBe('')
			expect(result.warning).toContain('Comment Checker')
		})
	})

	describe('warning format', () => {
		test('warning includes category and reason', () => {
			const code = `
// Here we create the robust, enterprise-grade solution
// This basically leverages the comprehensive API
// Feel free to modify this seamless integration
function doStuff() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			expect(result.warning).toContain('AI-slop')
			expect(result.warning).toContain('└─')
			expect(result.warning).toContain('Write comments that explain')
		})
	})

	describe('deduplication', () => {
		test('does not double-count the same line', () => {
			const code = `
// This robust solution basically leverages the API
function f() {}
`
			const checker = new CommentChecker(makeLogger(), { minViolations: 1 })
			const result = checker.check(code)
			// Only one violation per line (first matching pattern wins)
			const matchingLine = result.violations.filter(v => v.line.includes('robust solution'))
			expect(matchingLine.length).toBeLessThanOrEqual(1)
		})
	})
})
