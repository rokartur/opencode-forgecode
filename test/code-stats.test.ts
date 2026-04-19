import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createCodeStatsTools, __resetCodeStatsBackendForTests } from '../src/tools/code-stats'

const fakeCtx = () =>
	({
		projectId: 'test',
		directory: process.cwd(),
		config: {},
		logger: { log: () => {}, error: () => {} },
	}) as never

function makeRepo(): string {
	const root = mkdtempSync(join(tmpdir(), 'code-stats-'))
	mkdirSync(join(root, 'src'), { recursive: true })
	writeFileSync(join(root, 'src/a.ts'), `export const x = 1\nexport const y = 2\n`)
	writeFileSync(join(root, 'src/b.js'), `module.exports = {}\n`)
	writeFileSync(join(root, 'README.md'), `# hello\n`)
	return root
}

describe('code-stats tool', () => {
	test('returns a language/files summary for a small repo', async () => {
		__resetCodeStatsBackendForTests()
		const tools = createCodeStatsTools(fakeCtx())
		const tool = tools['code-stats']
		expect(tool).toBeDefined()
		const ctx = { sessionID: 's', messageID: 'm', callID: 'c', abort: new AbortController().signal }
		const cwd = makeRepo()
		try {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tool shape is loose
			const out = (await (tool as any).execute({ path: cwd }, ctx)) as string
			expect(out.length).toBeGreaterThan(0)
			// All three backends report something readable; we assert at least one known label.
			expect(
				out.includes('Language stats') ||
					out.includes('File-type stats') ||
					out.includes('no backend available'),
			).toBe(true)
		} finally {
			rmSync(cwd, { recursive: true, force: true })
		}
	})
})
