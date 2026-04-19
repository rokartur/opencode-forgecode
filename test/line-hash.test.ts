import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildAnchoredView, hashLine, parseAnchor } from '../src/utils/line-hash'

describe('line hash utils', () => {
	const tempDirs: string[] = []

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	test('hashLine is deterministic and truncated', () => {
		expect(hashLine('alpha')).toBe(hashLine('alpha'))
		expect(hashLine('alpha')).toHaveLength(8)
		expect(hashLine('alpha')).not.toBe(hashLine('beta'))
	})

	test('parseAnchor parses valid anchors', () => {
		expect(parseAnchor('42#a3f9b2c1')).toEqual({ line: 42, hash: 'a3f9b2c1' })
		expect(parseAnchor('7#ABCDEF12')).toEqual({ line: 7, hash: 'abcdef12' })
	})

	test('parseAnchor rejects invalid anchors', () => {
		expect(() => parseAnchor('')).toThrow('Invalid anchor format')
		expect(() => parseAnchor('abc#12345678')).toThrow('Invalid anchor format')
		expect(() => parseAnchor('0#12345678')).toThrow('Invalid anchor line')
		expect(() => parseAnchor('1#short')).toThrow('Invalid anchor format')
	})

	test('buildAnchoredView renders numbered anchored lines', () => {
		const dir = mkdtempSync(join(tmpdir(), 'line-hash-'))
		tempDirs.push(dir)
		const file = join(dir, 'sample.txt')
		writeFileSync(file, 'first\nsecond\n', 'utf8')

		expect(buildAnchoredView(file)).toBe(`1#${hashLine('first')}: first\n2#${hashLine('second')}: second`)
	})
})
