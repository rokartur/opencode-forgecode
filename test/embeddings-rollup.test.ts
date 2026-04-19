import { test, expect } from 'bun:test'
import { rollupSmallChunks, estimateTokensCharQuarter, type CodeChunk } from '../src/runtime/embeddings/chunker'

function mk(
	filePath: string,
	startLine: number,
	endLine: number,
	content: string,
	opts: { symbolName?: string; symbolKind?: string } = {},
): CodeChunk {
	return {
		id: `${filePath}:${startLine}-${endLine}`,
		filePath,
		startLine,
		endLine,
		content,
		symbolName: opts.symbolName,
		symbolKind: opts.symbolKind,
	}
}

test('estimateTokensCharQuarter approximates 1 token per 4 chars', () => {
	expect(estimateTokensCharQuarter('')).toBe(0)
	expect(estimateTokensCharQuarter('abcd')).toBe(1)
	expect(estimateTokensCharQuarter('a'.repeat(40))).toBe(10)
})

test('rollupSmallChunks merges two tiny adjacent chunks', () => {
	const chunks = [
		mk('a.ts', 1, 3, 'const a = 1', { symbolName: 'a', symbolKind: 'const' }),
		mk('a.ts', 4, 6, 'const b = 2', { symbolName: 'b', symbolKind: 'const' }),
	]
	const out = rollupSmallChunks(chunks)
	expect(out.length).toBe(1)
	expect(out[0].startLine).toBe(1)
	expect(out[0].endLine).toBe(6)
	expect(out[0].content).toBe('const a = 1\nconst b = 2')
	// Different symbols → merged chunk drops symbol metadata.
	expect(out[0].symbolName).toBeUndefined()
	expect(out[0].symbolKind).toBeUndefined()
})

test('rollupSmallChunks keeps symbol metadata when both chunks share it', () => {
	const chunks = [
		mk('a.ts', 1, 2, 'x', { symbolName: 'foo', symbolKind: 'function' }),
		mk('a.ts', 3, 4, 'y', { symbolName: 'foo', symbolKind: 'function' }),
	]
	const out = rollupSmallChunks(chunks)
	expect(out.length).toBe(1)
	expect(out[0].symbolName).toBe('foo')
	expect(out[0].symbolKind).toBe('function')
})

test('rollupSmallChunks does NOT merge across files', () => {
	const chunks = [mk('a.ts', 1, 2, 'a'), mk('b.ts', 1, 2, 'b')]
	const out = rollupSmallChunks(chunks)
	expect(out.length).toBe(2)
	expect(out[0].filePath).toBe('a.ts')
	expect(out[1].filePath).toBe('b.ts')
})

test('rollupSmallChunks does NOT merge when lines are not contiguous', () => {
	const chunks = [mk('a.ts', 1, 3, 'a'), mk('a.ts', 10, 12, 'b')]
	const out = rollupSmallChunks(chunks)
	expect(out.length).toBe(2)
})

test('rollupSmallChunks does NOT merge two already-large chunks', () => {
	const big = 'x'.repeat(300) // ~75 tokens at char/4
	const chunks = [mk('a.ts', 1, 10, big), mk('a.ts', 11, 20, big)]
	const out = rollupSmallChunks(chunks, { minChunkTokens: 50, maxChunkTokens: 400 })
	expect(out.length).toBe(2)
})

test('rollupSmallChunks merges small into previous large if under cap', () => {
	const medium = 'x'.repeat(200) // ~50 tokens
	const tiny = 'y' // ~1 token
	const chunks = [mk('a.ts', 1, 10, medium), mk('a.ts', 11, 12, tiny)]
	const out = rollupSmallChunks(chunks, { minChunkTokens: 50, maxChunkTokens: 400 })
	expect(out.length).toBe(1)
	expect(out[0].endLine).toBe(12)
})

test('rollupSmallChunks refuses a merge that would exceed maxChunkTokens', () => {
	// medium ~50 tokens, tiny ~45 tokens → sum 95 > cap 80, refuse.
	const medium = 'a'.repeat(200)
	const tiny = 'b'.repeat(180)
	const chunks = [mk('a.ts', 1, 10, medium), mk('a.ts', 11, 12, tiny)]
	const out = rollupSmallChunks(chunks, { minChunkTokens: 50, maxChunkTokens: 80 })
	expect(out.length).toBe(2)
})

test('rollupSmallChunks chains multiple tiny adjacent chunks into one group', () => {
	const chunks = [mk('a.ts', 1, 1, 'a'), mk('a.ts', 2, 2, 'b'), mk('a.ts', 3, 3, 'c'), mk('a.ts', 4, 4, 'd')]
	const out = rollupSmallChunks(chunks)
	expect(out.length).toBe(1)
	expect(out[0].startLine).toBe(1)
	expect(out[0].endLine).toBe(4)
	expect(out[0].content).toBe('a\nb\nc\nd')
})

test('rollupSmallChunks does not mutate the input array', () => {
	const chunks = [mk('a.ts', 1, 1, 'a'), mk('a.ts', 2, 2, 'b')]
	const snapshot = JSON.parse(JSON.stringify(chunks))
	rollupSmallChunks(chunks)
	expect(chunks).toEqual(snapshot)
})

test('rollupSmallChunks custom token estimator is honoured', () => {
	// Estimator counts whitespace-separated words; tiny chunks have 1 word each.
	const estimate = (t: string) => t.split(/\s+/).filter(Boolean).length
	const chunks = [mk('a.ts', 1, 1, 'alpha'), mk('a.ts', 2, 2, 'beta')]
	const out = rollupSmallChunks(chunks, {
		minChunkTokens: 5,
		maxChunkTokens: 10,
		estimateTokens: estimate,
	})
	expect(out.length).toBe(1)
})
