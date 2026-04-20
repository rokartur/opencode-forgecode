import { describe, test, expect } from 'bun:test'
import { truncateShell, truncateSearch, truncateFetch, truncateForTool } from '../src/harness/truncation'

describe('truncateShell', () => {
	test('passes through short output', () => {
		const input = 'line1\nline2\nline3'
		expect(truncateShell(input)).toBe(input)
	})

	test('clips long individual lines', () => {
		const longLine = 'x'.repeat(3000)
		const result = truncateShell(longLine, { maxLineLength: 100 })
		expect(result).toContain('...[2900 more chars truncated]')
		expect(result.length).toBeLessThan(3000)
	})

	test('hides middle lines when prefix+suffix exceeded', () => {
		const lines = Array.from({ length: 500 }, (_, i) => `line${i}`).join('\n')
		const result = truncateShell(lines, { prefixLines: 10, suffixLines: 10 })
		expect(result).toContain('line0')
		expect(result).toContain('line499')
		expect(result).toContain('...[480 lines hidden')
		expect(result).not.toContain('line100')
	})

	test('reports clipped-lines count in banner when both apply', () => {
		const rows: string[] = []
		for (let i = 0; i < 500; i++) rows.push(i < 2 ? 'x'.repeat(3000) : `line${i}`)
		const result = truncateShell(rows.join('\n'), {
			prefixLines: 5,
			suffixLines: 5,
			maxLineLength: 100,
		})
		expect(result).toContain('long lines clipped')
	})
})

describe('truncateSearch', () => {
	test('passes through under limit', () => {
		const s = 'a\nb\nc'
		expect(truncateSearch(s, { maxLines: 10 })).toBe(s)
	})

	test('caps lines with a trailing marker', () => {
		const lines = Array.from({ length: 20 }, (_, i) => `r${i}`).join('\n')
		const result = truncateSearch(lines, { maxLines: 5 })
		expect(result).toContain('r0')
		expect(result).toContain('r4')
		expect(result).not.toContain('r15')
		expect(result).toContain('...[15 more matches truncated]')
	})
})

describe('truncateFetch', () => {
	test('passes through under limit', () => {
		const s = 'short'
		expect(truncateFetch(s, { maxChars: 100 })).toBe(s)
	})

	test('clips long content with a marker', () => {
		const s = 'x'.repeat(1000)
		const result = truncateFetch(s, { maxChars: 100 })
		expect(result.length).toBeLessThan(300)
		expect(result).toContain('...[900 chars truncated]')
	})
})

describe('truncateForTool', () => {
	test('bash routes to truncateShell', () => {
		// 1000 lines exceeds the default prefixLines(400) + suffixLines(400) = 800
		const lines = Array.from({ length: 1000 }, (_, i) => `l${i}`).join('\n')
		const result = truncateForTool('bash', lines)
		expect(result).toContain('lines hidden')
	})

	test('grep routes to truncateSearch', () => {
		const lines = Array.from({ length: 600 }, (_, i) => `m${i}`).join('\n')
		const result = truncateForTool('grep', lines)
		expect(result).toContain('more matches truncated')
	})

	test('webfetch routes to truncateFetch', () => {
		// 100K chars exceeds the default maxChars(80_000)
		const s = 'y'.repeat(100_000)
		const result = truncateForTool('webfetch', s)
		expect(result).toContain('chars truncated')
	})

	test('unknown tool returns input unchanged', () => {
		expect(truncateForTool('custom_tool', 'hello')).toBe('hello')
	})
})
