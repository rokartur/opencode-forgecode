import { test, expect } from 'bun:test'
import { extractJupyterCells, extractSvelteScripts, extractCodeBlocks } from '../src/graph/extractors'

// ---------------------------------------------------------------------
// Jupyter
// ---------------------------------------------------------------------

test('extractJupyterCells returns only code cells', () => {
	const nb = JSON.stringify({
		metadata: { kernelspec: { language: 'python' } },
		cells: [
			{ cell_type: 'markdown', source: '# heading\n' },
			{ cell_type: 'code', source: 'print(1)\n' },
			{ cell_type: 'raw', source: 'ignore me' },
			{ cell_type: 'code', source: ['x = 2\n', 'y = x + 1\n'] },
		],
	})
	const blocks = extractJupyterCells(nb)
	expect(blocks.length).toBe(2)
	expect(blocks[0].source).toBe('print(1)\n')
	expect(blocks[0].language).toBe('python')
	expect(blocks[0].origin).toBe('cell[1]')
	expect(blocks[1].source).toBe('x = 2\ny = x + 1\n')
	expect(blocks[1].origin).toBe('cell[3]')
})

test('extractJupyterCells respects per-cell language override', () => {
	const nb = JSON.stringify({
		metadata: { kernelspec: { language: 'python' } },
		cells: [{ cell_type: 'code', source: '%%typescript\nconst x = 1', metadata: { language: 'typescript' } }],
	})
	const blocks = extractJupyterCells(nb)
	expect(blocks[0].language).toBe('typescript')
})

test('extractJupyterCells skips empty code cells', () => {
	const nb = JSON.stringify({
		metadata: { kernelspec: { language: 'python' } },
		cells: [
			{ cell_type: 'code', source: '' },
			{ cell_type: 'code', source: 'x = 1' },
		],
	})
	const blocks = extractJupyterCells(nb)
	expect(blocks.length).toBe(1)
	expect(blocks[0].source).toBe('x = 1')
})

test('extractJupyterCells produces monotonically increasing startLines', () => {
	const nb = JSON.stringify({
		cells: [
			{ cell_type: 'code', source: 'a = 1\n' },
			{ cell_type: 'code', source: 'b = 2\nc = 3\n' },
			{ cell_type: 'code', source: 'd = 4\n' },
		],
	})
	const blocks = extractJupyterCells(nb)
	expect(blocks.length).toBe(3)
	for (let i = 1; i < blocks.length; i++) {
		expect(blocks[i].startLine).toBeGreaterThan(blocks[i - 1].startLine)
	}
})

test('extractJupyterCells throws on invalid JSON', () => {
	expect(() => extractJupyterCells('not json', 'bad.ipynb')).toThrow(/invalid notebook/)
})

test('extractJupyterCells handles missing cells array', () => {
	expect(extractJupyterCells('{}')).toEqual([])
})

test('extractJupyterCells falls back to language_info when kernelspec absent', () => {
	const nb = JSON.stringify({
		metadata: { language_info: { name: 'julia' } },
		cells: [{ cell_type: 'code', source: 'x = 1' }],
	})
	const blocks = extractJupyterCells(nb)
	expect(blocks[0].language).toBe('julia')
})

// ---------------------------------------------------------------------
// Svelte
// ---------------------------------------------------------------------

test('extractSvelteScripts handles a TS script block', () => {
	const svelte = `<script lang="ts">
  export let name: string = 'world'
  function greet() { return 'hi ' + name }
</script>
<h1>Hello {name}</h1>
`
	const blocks = extractSvelteScripts(svelte)
	expect(blocks.length).toBe(1)
	expect(blocks[0].language).toBe('typescript')
	expect(blocks[0].source).toContain('export let name')
	expect(blocks[0].source).toContain('function greet')
	expect(blocks[0].startLine).toBe(2) // body begins on line 2
})

test('extractSvelteScripts defaults to javascript without lang attr', () => {
	const svelte = `<script>let x = 1</script>`
	const blocks = extractSvelteScripts(svelte)
	expect(blocks[0].language).toBe('javascript')
})

test('extractSvelteScripts separates module script from component script', () => {
	const svelte = `<script context="module">
  export const meta = { title: 'x' }
</script>
<script lang="ts">
  let count = 0
</script>
`
	const blocks = extractSvelteScripts(svelte)
	expect(blocks.length).toBe(2)
	expect(blocks[0].origin).toBe('script[context=module]')
	expect(blocks[1].origin).toBe('script[lang=typescript]')
	expect(blocks[1].startLine).toBeGreaterThan(blocks[0].endLine)
})

test('extractSvelteScripts returns empty for templates without script', () => {
	expect(extractSvelteScripts('<h1>No script here</h1>')).toEqual([])
})

// ---------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------

test('extractCodeBlocks dispatches by extension', () => {
	const ipynb = JSON.stringify({ cells: [{ cell_type: 'code', source: 'x = 1' }] })
	expect(extractCodeBlocks('foo.ipynb', ipynb)?.length).toBe(1)
	expect(extractCodeBlocks('Foo.svelte', '<script>let y = 2</script>')?.length).toBe(1)
	expect(extractCodeBlocks('foo.ts', 'const x = 1')).toBeNull()
})
