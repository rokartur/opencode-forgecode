/**
 * Transport abstraction for RpcClient. Lets the client speak either to an
 * in-process Worker (leader mode) or to a Unix socket / Windows named pipe
 * server (follower mode).
 *
 * Also defines the IPC wire protocol constants shared by both sides of the
 * socket (handshake + heartbeat). RPC call/response messages piggyback on
 * the same framing but pass through unchanged to RpcServer.
 */

import net from 'net'
import { EventEmitter } from 'events'
import { encodeFrame, FrameDecoder } from './ipc-framing'

/**
 * IPC protocol version. Bump whenever the framing or handshake format
 * changes in a backwards-incompatible way. Followers refuse to connect to
 * a leader with a different major version.
 */
export const GRAPH_IPC_VERSION = 1

/** Default time after which a peer with no heartbeat is considered dead. */
export const HEARTBEAT_TIMEOUT_MS = 30_000
/** Default interval at which peers exchange heartbeats. */
export const HEARTBEAT_INTERVAL_MS = 5_000

export type IpcMessage =
	| { kind: 'hello'; version: number; role: 'client' | 'server'; accepted?: boolean; reason?: string }
	| { kind: 'ping'; t: number }
	| { kind: 'pong'; t: number }
	| { kind: 'rpc'; payload: unknown }
	| { kind: 'goodbye'; reason?: string }

export interface RpcTransport {
	send(message: unknown): void
	onMessage(handler: (message: unknown) => void): void
	onError(handler: (error: Error) => void): void
	onClose(handler: () => void): void
	close(): void
	/** Cheap liveness probe — false means no further RPCs can succeed. */
	isHealthy(): boolean
}

/**
 * Wraps a Worker into the RpcTransport interface. Passes raw RPC payloads
 * through postMessage (no framing needed inside the process).
 */
export class WorkerTransport implements RpcTransport {
	private emitter = new EventEmitter()
	private closed = false
	private erroredWith: Error | null = null

	constructor(private worker: Worker) {
		worker.onmessage = (event: MessageEvent) => {
			this.emitter.emit('message', event.data)
		}
		worker.onerror = (event: ErrorEvent) => {
			const err = event instanceof Error ? event : new Error((event as any)?.message ?? 'Worker error')
			this.erroredWith = err
			this.emitter.emit('error', err)
		}
		worker.addEventListener('messageerror', () => {
			this.closed = true
			this.emitter.emit('close')
		})
	}

	send(message: unknown): void {
		if (this.closed) throw new Error('WorkerTransport: closed')
		this.worker.postMessage(message)
	}

	onMessage(handler: (message: unknown) => void): void {
		this.emitter.on('message', handler)
	}
	onError(handler: (error: Error) => void): void {
		this.emitter.on('error', handler)
	}
	onClose(handler: () => void): void {
		this.emitter.on('close', handler)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		try {
			this.worker.terminate()
		} catch {
			// ignore
		}
		this.emitter.emit('close')
	}

	isHealthy(): boolean {
		return !this.closed && this.erroredWith === null
	}
}

export interface SocketTransportOptions {
	socketPath: string
	connectTimeoutMs?: number
	heartbeatIntervalMs?: number
	heartbeatTimeoutMs?: number
	logger?: { error?: (msg: string, err?: unknown) => void; debug?: (msg: string) => void }
}

/**
 * Connect to a leader over a Unix socket / Windows named pipe. Does the
 * version handshake up-front; if it fails, `connect()` rejects and the
 * transport is closed.
 */
export class SocketTransport implements RpcTransport {
	private socket: net.Socket | null = null
	private decoder = new FrameDecoder()
	private emitter = new EventEmitter()
	private closed = false
	private erroredWith: Error | null = null
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null
	private heartbeatTimeoutHandle: ReturnType<typeof setTimeout> | null = null
	private lastPongAt = 0

	constructor(private opts: SocketTransportOptions) {}

	connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const connectTimeout = this.opts.connectTimeoutMs ?? 5_000
			const socket = net.createConnection({ path: this.opts.socketPath })
			this.socket = socket

			let handshakeDone = false
			const timer = setTimeout(() => {
				if (handshakeDone) return
				handshakeDone = true
				socket.destroy()
				reject(new Error(`SocketTransport: connect/handshake timed out after ${connectTimeout}ms`))
			}, connectTimeout)

			const fail = (err: Error) => {
				if (handshakeDone) return
				handshakeDone = true
				clearTimeout(timer)
				socket.destroy()
				reject(err)
			}

			socket.once('error', err => fail(err))
			socket.on('data', (chunk: Buffer) => {
				try {
					for (const raw of this.decoder.push(chunk)) {
						const msg = raw as IpcMessage
						if (!handshakeDone) {
							if (msg?.kind === 'hello') {
								if (!msg.accepted) {
									fail(
										new Error(
											`SocketTransport: leader rejected handshake: ${msg.reason ?? 'unknown'}`,
										),
									)
									return
								}
								if (msg.version !== GRAPH_IPC_VERSION) {
									fail(
										new Error(
											`SocketTransport: version mismatch (leader=${msg.version}, self=${GRAPH_IPC_VERSION})`,
										),
									)
									return
								}
								handshakeDone = true
								clearTimeout(timer)
								this.lastPongAt = Date.now()
								this.attachPostHandshakeHandlers()
								this.startHeartbeat()
								resolve()
							} else {
								fail(new Error(`SocketTransport: expected hello, got ${JSON.stringify(msg)}`))
							}
							return
						}
						this.dispatch(msg)
					}
				} catch (err) {
					fail(err as Error)
				}
			})

			socket.once('connect', () => {
				// Send client hello immediately after TCP/UDS connect.
				const hello: IpcMessage = { kind: 'hello', version: GRAPH_IPC_VERSION, role: 'client' }
				try {
					socket.write(encodeFrame(hello))
				} catch (err) {
					fail(err as Error)
				}
			})
		})
	}

	private attachPostHandshakeHandlers(): void {
		if (!this.socket) return
		this.socket.on('error', err => {
			this.erroredWith = err
			this.emitter.emit('error', err)
		})
		this.socket.on('close', () => {
			this.stopHeartbeat()
			this.closed = true
			this.emitter.emit('close')
		})
	}

	private dispatch(msg: IpcMessage): void {
		switch (msg?.kind) {
			case 'pong':
				this.lastPongAt = Date.now()
				return
			case 'ping':
				try {
					this.socket?.write(encodeFrame({ kind: 'pong', t: msg.t } satisfies IpcMessage))
				} catch {
					/* socket closing */
				}
				return
			case 'rpc':
				this.emitter.emit('message', msg.payload)
				return
			case 'goodbye':
				// Leader told us it's shutting down. Close transport now so
				// waiting RPCs surface a transport error and failover kicks in
				// immediately (without waiting for the heartbeat interval).
				this.opts.logger?.debug?.(`SocketTransport: leader goodbye (reason=${msg.reason ?? 'n/a'})`)
				this.close()
				return
			default:
				// Ignore unknown kinds for forward-compat; log once.
				this.opts.logger?.debug?.(`SocketTransport: dropping unknown message kind=${(msg as any)?.kind}`)
		}
	}

	private startHeartbeat(): void {
		const interval = this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
		const timeout = this.opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
		this.heartbeatTimer = setInterval(() => {
			try {
				this.socket?.write(encodeFrame({ kind: 'ping', t: Date.now() } satisfies IpcMessage))
			} catch {
				/* socket closing */
			}
			if (Date.now() - this.lastPongAt > timeout) {
				const err = new Error('SocketTransport: heartbeat timeout')
				this.erroredWith = err
				this.emitter.emit('error', err)
				this.close()
			}
		}, interval)
		;(this.heartbeatTimer as any).unref?.()
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
		if (this.heartbeatTimeoutHandle) {
			clearTimeout(this.heartbeatTimeoutHandle)
			this.heartbeatTimeoutHandle = null
		}
	}

	send(payload: unknown): void {
		if (this.closed || !this.socket) throw new Error('SocketTransport: closed')
		const frame = encodeFrame({ kind: 'rpc', payload } satisfies IpcMessage)
		this.socket.write(frame)
	}

	onMessage(handler: (message: unknown) => void): void {
		this.emitter.on('message', handler)
	}
	onError(handler: (error: Error) => void): void {
		this.emitter.on('error', handler)
	}
	onClose(handler: () => void): void {
		this.emitter.on('close', handler)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.stopHeartbeat()
		try {
			this.socket?.end()
			this.socket?.destroy()
		} catch {
			// ignore
		}
		this.emitter.emit('close')
	}

	isHealthy(): boolean {
		return !this.closed && this.erroredWith === null
	}
}
