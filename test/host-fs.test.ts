import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { executeHostGlob, executeHostGrep, parseRipgrepJson, isRipgrepAvailable } from '../src/tools/host-fs'

function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'host-fs-'))
	mkdirSync(join(root, 'src'), { recursive: true })
	writeFileSync(join(root, 'src/a.ts'), `export const foo = 1\nexport function bar() { return foo }\n`)
	writeFileSync(join(root, 'src/b.ts'), `import { foo } from './a'\nconsole.log(foo)\n`)
	writeFileSync(join(root, 'README.md'), `no matches here\n`)
	// Minified / long-line file to check submatch windowing.
	writeFileSync(join(root, 'src/min.js'), `var a=1;var b=2;${'x'.repeat(500)}var foo=42;${'y'.repeat(500)}\n`)
	return root
}

describe('host-fs', () => {
	if (!isRipgrepAvailable()) {
		test.skip('rg not installed — skipping host-fs tests', () => {})
		return
	}

	test('executeHostGlob lists matching files', () => {
		const cwd = makeRepo()
		try {
			const out = executeHostGlob('**/*.ts', { cwd })
			expect(out).not.toBeNull()
			expect(out!).toContain('src/a.ts')
			expect(out!).toContain('src/b.ts')
			expect(out!).not.toContain('README.md')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('executeHostGlob returns "No files found" for empty', () => {
		const cwd = makeRepo()
		try {
			const out = executeHostGlob('**/*.rs', { cwd })
			expect(out).toBe('No files found')
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('executeHostGrep groups matches per file', () => {
		const cwd = makeRepo()
		try {
			const out = executeHostGrep('foo', { cwd })
			expect(out).not.toBeNull()
			expect(out!).toContain('Found ')
			expect(out!).toContain('src/a.ts:')
			expect(out!).toContain('src/b.ts:')
			expect(out!).toMatch(/L\d+:/)
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('executeHostGrep windows around submatch on long lines', () => {
		const cwd = makeRepo()
		try {
			const out = executeHostGrep('foo=42', { cwd, include: '*.js' })
			expect(out).not.toBeNull()
			expect(out!).toContain('src/min.js')
			expect(out!).toContain('foo=42')
			// Long prefix/suffix must be elided (we should see an ellipsis).
			expect(out!).toContain('…')
			// The snippet in min.js must not carry the full 1000+-char line.
			const minLine = out!.split('\n').find(l => l.includes('foo=42')) ?? ''
			expect(minLine.length).toBeLessThan(400)
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})

	test('parseRipgrepJson handles empty stream', () => {
		expect(parseRipgrepJson('')).toBe('No matches found')
	})

	test('parseRipgrepJson ignores non-match events', () => {
		const stream =
			JSON.stringify({ type: 'begin', data: { path: { text: 'x' } } }) +
			'\n' +
			JSON.stringify({ type: 'summary', data: {} }) +
			'\n'
		expect(parseRipgrepJson(stream)).toBe('No matches found')
	})
})
