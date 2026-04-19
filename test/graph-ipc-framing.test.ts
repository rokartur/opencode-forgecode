import { describe, test, expect } from 'bun:test'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES } from '../src/graph/ipc-framing'

describe('ipc-framing', () => {
	test('encode + decode round-trip for small object', () => {
		const msg = { hello: 'world', n: 42 }
		const frame = encodeFrame(msg)
		const dec = new FrameDecoder()
		const messages = [...dec.push(frame)]
		expect(messages).toEqual([msg])
		expect(dec.buffered).toBe(0)
	})

	test('handles multiple frames in a single chunk', () => {
		const f1 = encodeFrame({ a: 1 })
		const f2 = encodeFrame({ b: 2 })
		const combined = Buffer.concat([f1, f2])
		const dec = new FrameDecoder()
		expect([...dec.push(combined)]).toEqual([{ a: 1 }, { b: 2 }])
	})

	test('handles frame split across chunks', () => {
		const frame = encodeFrame({ hello: 'split' })
		const dec = new FrameDecoder()
		// split header
		expect([...dec.push(frame.subarray(0, 2))]).toEqual([])
		expect([...dec.push(frame.subarray(2, 3))]).toEqual([])
		// split body
		expect([...dec.push(frame.subarray(3, frame.length - 2))]).toEqual([])
		expect([...dec.push(frame.subarray(frame.length - 2))]).toEqual([{ hello: 'split' }])
	})

	test('header arriving byte-by-byte still decodes', () => {
		const frame = encodeFrame({ x: 'y' })
		const dec = new FrameDecoder()
		for (let i = 0; i < frame.length - 1; i++) {
			expect([...dec.push(frame.subarray(i, i + 1))]).toEqual([])
		}
		expect([...dec.push(frame.subarray(frame.length - 1))]).toEqual([{ x: 'y' }])
	})

	test('throws on body exceeding MAX_FRAME_BYTES', () => {
		const dec = new FrameDecoder()
		const hugeHeader = Buffer.alloc(4)
		hugeHeader.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
		expect(() => [...dec.push(hugeHeader)]).toThrow(/exceeds MAX_FRAME_BYTES/)
	})

	test('throws on invalid JSON body', () => {
		const header = Buffer.alloc(4)
		const body = Buffer.from('{not-json', 'utf8')
		header.writeUInt32BE(body.length, 0)
		const dec = new FrameDecoder()
		expect(() => [...dec.push(Buffer.concat([header, body]))]).toThrow(/invalid JSON/)
	})

	test('reset() clears state between connections', () => {
		const dec = new FrameDecoder()
		const header = Buffer.alloc(4)
		header.writeUInt32BE(10, 0)
		// Iterate the generator so the partial chunk is consumed into the internal buffer.
		for (const _ of dec.push(Buffer.concat([header, Buffer.from('partial')]))) {
			// no complete frames expected
		}
		expect(dec.buffered).toBeGreaterThan(0)
		dec.reset()
		expect(dec.buffered).toBe(0)
		const ok = encodeFrame({ q: true })
		expect([...dec.push(ok)]).toEqual([{ q: true }])
	})

	test('encodeFrame rejects messages exceeding MAX_FRAME_BYTES', () => {
		// Construct a string whose JSON representation will be > 64 MiB.
		// Avoid actually allocating 64 MiB: stub JSON.stringify temporarily.
		const original = JSON.stringify
		;(JSON as any).stringify = () => 'x'.repeat(MAX_FRAME_BYTES + 1)
		try {
			expect(() => encodeFrame({})).toThrow(/exceeds MAX_FRAME_BYTES/)
		} finally {
			;(JSON as any).stringify = original
		}
	})
})
