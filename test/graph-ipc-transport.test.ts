import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RpcServer } from '../src/graph/rpc'
import { startIpcServer, type IpcServer } from '../src/graph/ipc-server'
import { SocketTransport, GRAPH_IPC_VERSION, WorkerTransport } from '../src/graph/ipc-transport'
import { encodeFrame } from '../src/graph/ipc-framing'
import net from 'net'
import { EventEmitter } from 'events'

function _makeSocketPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'ipc-transport-'))
	return { dir, path: join(dir, 'sock') } as unknown as string & { dir: string; path: string }
}

describe('ipc server + SocketTransport', () => {
	let dir: string
	let socketPath: string
	let server: IpcServer | null = null

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'ipc-transport-'))
		socketPath = join(dir, 'sock')
		server = null
	})

	afterEach(async () => {
		if (server) {
			await server.close()
			server = null
		}
		rmSync(dir, { recursive: true, force: true })
	})

	test('handshake succeeds and RPC round-trips', async () => {
		const rpc = new RpcServer()
		rpc.register('add', args => {
			const [a, b] = args as [number, number]
			return a + b
		})

		server = await startIpcServer({
			socketPath,
			rpcServer: rpc,
			heartbeatIntervalMs: 10_000,
			heartbeatTimeoutMs: 60_000,
		})

		const transport = new SocketTransport({
			socketPath,
			heartbeatIntervalMs: 10_000,
			heartbeatTimeoutMs: 60_000,
		})
		await transport.connect()

		const responsePromise = new Promise<unknown>(resolve => {
			transport.onMessage(msg => resolve(msg))
		})

		transport.send({ callId: 1, method: 'add', args: [2, 3] })
		const response = await responsePromise
		expect(response).toEqual({ callId: 1, result: 5 })

		transport.close()
	})

	test('RpcServer error propagates through the socket', async () => {
		const rpc = new RpcServer()
		rpc.register('boom', () => {
			throw new Error('kaboom')
		})

		server = await startIpcServer({
			socketPath,
			rpcServer: rpc,
			heartbeatIntervalMs: 10_000,
			heartbeatTimeoutMs: 60_000,
		})

		const transport = new SocketTransport({ socketPath, heartbeatIntervalMs: 10_000, heartbeatTimeoutMs: 60_000 })
		await transport.connect()

		const responsePromise = new Promise<any>(resolve => transport.onMessage(resolve))
		transport.send({ callId: 7, method: 'boom', args: [] })
		const response = await responsePromise
		expect(response.callId).toBe(7)
		expect(response.error).toBe('kaboom')
		transport.close()
	})

	test('server rejects handshake with wrong version', async () => {
		const rpc = new RpcServer()
		server = await startIpcServer({
			socketPath,
			rpcServer: rpc,
			heartbeatIntervalMs: 10_000,
			heartbeatTimeoutMs: 60_000,
		})

		// Connect manually and send wrong-version hello.
		await new Promise<void>((resolve, reject) => {
			const sock = net.createConnection({ path: socketPath })
			sock.once('connect', () => {
				const badHello = { kind: 'hello', version: GRAPH_IPC_VERSION + 999, role: 'client' }
				sock.write(encodeFrame(badHello))
			})
			sock.once('error', reject)
			sock.once('close', () => resolve())
			// Server closes our connection after rejecting; resolve on close.
		})
	})

	test('SocketTransport rejects on version mismatch from server', async () => {
		// Start a minimal fake server that always replies with wrong version.
		const fake = net.createServer(sock => {
			sock.once('data', () => {
				sock.write(encodeFrame({ kind: 'hello', version: 999, role: 'server', accepted: true }))
			})
		})
		await new Promise<void>(res => fake.listen(socketPath, () => res()))

		try {
			const transport = new SocketTransport({ socketPath, connectTimeoutMs: 2000 })
			await expect(transport.connect()).rejects.toThrow(/version mismatch/)
		} finally {
			await new Promise<void>(res => fake.close(() => res()))
		}
	})

	test('SocketTransport times out connect when nothing responds', async () => {
		// Server accepts but never sends hello reply.
		const fake = net.createServer(() => {})
		await new Promise<void>(res => fake.listen(socketPath, () => res()))
		try {
			const transport = new SocketTransport({ socketPath, connectTimeoutMs: 100 })
			await expect(transport.connect()).rejects.toThrow(/timed out/)
		} finally {
			await new Promise<void>(res => fake.close(() => res()))
		}
	})

	test('connectionCount reflects active followers', async () => {
		const rpc = new RpcServer()
		server = await startIpcServer({
			socketPath,
			rpcServer: rpc,
			heartbeatIntervalMs: 10_000,
			heartbeatTimeoutMs: 60_000,
		})
		expect(server.connectionCount).toBe(0)
		const a = new SocketTransport({ socketPath })
		const b = new SocketTransport({ socketPath })
		await a.connect()
		await b.connect()
		// Give the server a tick to register the connections.
		await new Promise(r => setTimeout(r, 20))
		expect(server.connectionCount).toBe(2)
		a.close()
		b.close()
		await new Promise(r => setTimeout(r, 50))
		expect(server.connectionCount).toBe(0)
	})
})

describe('WorkerTransport', () => {
	test('passes messages through without framing', async () => {
		// Build a minimal mock Worker.
		const incoming = new EventEmitter()
		const sent: unknown[] = []
		const mockWorker = {
			onmessage: null as ((e: MessageEvent) => void) | null,
			onerror: null as ((e: ErrorEvent) => void) | null,
			addEventListener: (_: string, __: any) => {},
			postMessage: (msg: unknown) => {
				sent.push(msg)
				// Echo back with callId + result.
				setTimeout(() => {
					const m = msg as { callId: number; args: unknown[] }
					mockWorker.onmessage?.({ data: { callId: m.callId, result: m.args[0] } } as MessageEvent)
				}, 0)
			},
			terminate: () => incoming.emit('close'),
		} as unknown as Worker

		const transport = new WorkerTransport(mockWorker)
		const received = new Promise<unknown>(r => transport.onMessage(r))
		transport.send({ callId: 1, method: 'echo', args: ['hi'] })
		expect(await received).toEqual({ callId: 1, result: 'hi' })
		expect(sent).toHaveLength(1)
		transport.close()
	})
})
