/// <reference types="bun-types" />

import { EventEmitter } from 'events'
import type { RpcTransport } from './ipc-transport'
import { WorkerTransport } from './ipc-transport'

/**
 * Per-call RPC timeout in milliseconds.
 * This timeout applies to individual RPC method calls, not to multi-step operations like batch scans.
 * Configure via GRAPH_RPC_TIMEOUT_MS environment variable.
 * Default: 120000 (120 seconds)
 */
export const RPC_TIMEOUT_MS = parseInt(process.env.GRAPH_RPC_TIMEOUT_MS ?? '120000', 10)

/**
 * Per-call RPC timeout for scan-related methods (prepareScan, scanBatch, finalizeScan).
 * Scans can take minutes on large repos (tree-sitter parsing + SQLite writes), so they
 * get a much longer budget than regular read/query RPCs.
 * Configure via GRAPH_SCAN_TIMEOUT_MS environment variable.
 * Default: 600000 (10 minutes)
 */
export const RPC_SCAN_TIMEOUT_MS = parseInt(process.env.GRAPH_SCAN_TIMEOUT_MS ?? '600000', 10)

function isWorkerLike(x: unknown): x is Worker {
	return !!x && typeof (x as any).postMessage === 'function' && typeof (x as any).terminate === 'function'
}

/**
 * Generic RPC client. Speaks to either:
 *   - an in-process Worker (leader mode; WorkerTransport wraps it), or
 *   - a Unix socket / named pipe leader (follower mode; SocketTransport).
 *
 * The transport is responsible for delivery and liveness; RpcClient only
 * tracks pending calls and timeouts.
 */
export class RpcClient extends EventEmitter {
	private transport: RpcTransport
	private pendingCalls: Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: ReturnType<typeof setTimeout> }
	> = new Map()
	private callId = 0
	private terminated = false
	private transportError: Error | null = null

	constructor(
		transportOrWorker: RpcTransport | Worker,
		private logger?: { error: (msg: string, error?: unknown) => void; debug?: (msg: string) => void },
	) {
		super()
		this.transport = isWorkerLike(transportOrWorker) ? new WorkerTransport(transportOrWorker) : transportOrWorker
		this.setupTransportHandlers()
	}

	private setupTransportHandlers(): void {
		this.transport.onMessage(data => this.handleMessage(data))
		this.transport.onError(error => {
			this.transportError = error
			this.logger?.error('RPC transport error', error)
			this.rejectAllPending(new Error(`Transport error: ${error.message}`))
			this.emit('error', error)
		})
		this.transport.onClose(() => {
			this.terminated = true
			this.rejectAllPending(new Error('Transport closed'))
			this.emit('exit')
		})
	}

	private rejectAllPending(error: Error): void {
		for (const [, pending] of this.pendingCalls.entries()) {
			clearTimeout(pending.timeout)
			pending.reject(error)
		}
		this.pendingCalls.clear()
	}

	private handleMessage(data: unknown): void {
		if (data && typeof data === 'object' && 'callId' in data) {
			const msg = data as { callId: number; result?: unknown; error?: string; event?: string; payload?: unknown }

			if (msg.event) {
				// Handle events from worker
				this.emit(msg.event, msg.payload)
				return
			}

			const pending = this.pendingCalls.get(msg.callId)
			if (pending) {
				clearTimeout(pending.timeout)
				this.pendingCalls.delete(msg.callId)
				if (msg.error) {
					pending.reject(new Error(msg.error))
				} else {
					pending.resolve(msg.result)
				}
			}
		}
	}

	async call<T>(method: string, args: unknown[], timeoutMs: number = RPC_TIMEOUT_MS): Promise<T> {
		if (this.terminated) {
			throw new Error('Worker has been terminated')
		}
		if (this.transportError) {
			throw new Error(`Worker error: ${this.transportError.message}`)
		}

		const callId = ++this.callId
		const message = { callId, method, args }

		return new Promise<T>((resolve: (value: T) => void, reject) => {
			const timeout = setTimeout(() => {
				this.pendingCalls.delete(callId)
				reject(new Error(`RPC call '${method}' timed out after ${timeoutMs}ms`))
			}, timeoutMs)

			this.pendingCalls.set(callId, { resolve: resolve as (value: unknown) => void, reject, timeout })

			try {
				this.transport.send(message)
			} catch (error) {
				clearTimeout(timeout)
				this.pendingCalls.delete(callId)
				this.terminated = true
				const postError = error instanceof Error ? error : new Error(String(error))
				this.transportError = postError
				this.logger?.error('Failed to post message to worker', postError)
				this.rejectAllPending(postError)
				reject(postError)
			}
		})
	}

	terminate(): void {
		this.terminated = true
		this.transport.close()
	}

	isHealthy(): boolean {
		return !this.terminated && this.transportError === null && this.transport.isHealthy()
	}

	markTerminated(): void {
		this.terminated = true
		this.rejectAllPending(new Error('Worker terminated'))
	}

	/** Swap the underlying transport (used for failover — see Phase 4). */
	setTransport(transport: RpcTransport): void {
		this.rejectAllPending(new Error('Transport swapped'))
		try {
			this.transport.close()
		} catch {
			/* ignore */
		}
		this.transport = transport
		this.terminated = false
		this.transportError = null
		this.setupTransportHandlers()
	}
}

/**
 * RPC server for worker side
 */
export class RpcServer {
	private handlers: Map<string, (args: unknown[]) => Promise<unknown> | unknown> = new Map()

	register(method: string, handler: (args: unknown[]) => Promise<unknown> | unknown): void {
		this.handlers.set(method, handler)
	}

	async handle(message: unknown, postResponse: (response: unknown) => void): Promise<void> {
		if (!message || typeof message !== 'object') return

		const msg = message as { callId: number; method: string; args: unknown[] }
		const { callId, method, args } = msg

		try {
			const handler = this.handlers.get(method)
			if (!handler) {
				throw new Error(`Unknown method: ${method}`)
			}

			const result = await handler(args)
			postResponse({ callId, result })
		} catch (error) {
			postResponse({
				callId,
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}

	emit(_event: string, _payload?: unknown): void {
		// Will be called from worker to emit events to client
	}
}
