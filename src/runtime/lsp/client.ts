/**
 * Lightweight LSP client — spawns a language server via stdio and
 * speaks JSON-RPC 2.0 to it (subset of the LSP spec).
 *
 * This is intentionally minimal: we support `initialize`, `shutdown`,
 * `textDocument/didOpen`, and the handful of request methods our tools need.
 * We do NOT implement the full LSP spec, workspace folders, semantic tokens, etc.
 */

import { spawn, type ChildProcess } from 'child_process'
import type { ServerEntry } from './server-registry'

// ---------- JSON-RPC types ----------

interface JsonRpcRequest {
	jsonrpc: '2.0'
	id: number
	method: string
	params?: unknown
}

interface JsonRpcNotification {
	jsonrpc: '2.0'
	method: string
	params?: unknown
}

interface JsonRpcResponse {
	jsonrpc: '2.0'
	id: number
	result?: unknown
	error?: { code: number; message: string; data?: unknown }
}

// ---------- LSP subset types ----------

export interface Diagnostic {
	range: {
		start: { line: number; character: number }
		end: { line: number; character: number }
	}
	severity?: number
	code?: number | string
	source?: string
	message: string
}

export interface Location {
	uri: string
	range: {
		start: { line: number; character: number }
		end: { line: number; character: number }
	}
}

export interface Hover {
	contents: string | { kind: string; value: string } | Array<string | { kind: string; value: string }>
}

export interface CodeAction {
	title: string
	kind?: string
	diagnostics?: Diagnostic[]
	isPreferred?: boolean
}

export interface WorkspaceEdit {
	changes?: Record<string, Array<{ range: Location['range']; newText: string }>>
}

// ---------- Client ----------

const CONTENT_LENGTH_RE = /^Content-Length:\s*(\d+)\s*$/i

export class LspClient {
	private proc: ChildProcess | null = null
	private nextId = 1
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
	private initialized = false

	constructor(
		private readonly entry: ServerEntry,
		private readonly rootUri: string,
		private readonly logger: { log: (...args: unknown[]) => void },
	) {}

	// ---------- lifecycle ----------

	/** Spawn the server, send initialize, wait for response. */
	async start(): Promise<void> {
		this.proc = spawn(this.entry.command, this.entry.args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env },
		})

		this.proc.on('error', err => {
			this.logger.log(`[lsp] ${this.entry.name} spawn error: ${err.message}`)
		})
		this.proc.on('exit', (code, signal) => {
			this.logger.log(`[lsp] ${this.entry.name} exited: code=${code} signal=${signal}`)
			this.rejectAll(new Error(`LSP server exited (code=${code})`))
		})

		// Read stdout using content-length framing
		this.setupReader()

		// Initialize
		const initResult = await this.request('initialize', {
			processId: process.pid,
			rootUri: this.rootUri,
			capabilities: {
				textDocument: {
					publishDiagnostics: { relatedInformation: true },
					hover: { contentFormat: ['markdown', 'plaintext'] },
					definition: { linkSupport: false },
					references: {},
					codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
					rename: { prepareSupport: false },
				},
			},
		})

		this.initialized = true
		// Send initialized notification
		this.notify('initialized', {})
		return initResult as void
	}

	/** Gracefully shut down the server. */
	async stop(): Promise<void> {
		if (!this.proc) return
		try {
			await this.request('shutdown', null)
			this.notify('exit', undefined)
		} catch {
			// Best-effort
		}
		setTimeout(() => {
			this.proc?.kill('SIGKILL')
		}, 2000)
		this.proc = null
		this.initialized = false
	}

	get alive(): boolean {
		return this.proc !== null && this.initialized
	}

	// ---------- LSP methods exposed to tools ----------

	async didOpen(uri: string, languageId: string, text: string): Promise<void> {
		this.notify('textDocument/didOpen', {
			textDocument: { uri, languageId, version: 1, text },
		})
	}

	async getDiagnostics(uri: string): Promise<Diagnostic[]> {
		// LSP publishes diagnostics asynchronously via notification,
		// so we open the file and wait briefly for diagnostics to arrive.
		return new Promise(resolve => {
			const diagnostics: Diagnostic[] = []
			const handler = (method: string, params: unknown) => {
				if (method === 'textDocument/publishDiagnostics') {
					const p = params as { uri: string; diagnostics: Diagnostic[] }
					if (p.uri === uri) {
						diagnostics.push(...p.diagnostics)
					}
				}
			}
			this.notificationHandlers.push(handler)
			// Wait up to 5s for diagnostics
			setTimeout(() => {
				this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler)
				resolve(diagnostics)
			}, 5000)
		})
	}

	async getDefinition(uri: string, line: number, character: number): Promise<Location[]> {
		const result = await this.request('textDocument/definition', {
			textDocument: { uri },
			position: { line, character },
		})
		if (!result) return []
		if (Array.isArray(result)) return result as Location[]
		return [result as Location]
	}

	async getReferences(uri: string, line: number, character: number): Promise<Location[]> {
		const result = await this.request('textDocument/references', {
			textDocument: { uri },
			position: { line, character },
			context: { includeDeclaration: true },
		})
		return (result as Location[] | null) ?? []
	}

	async getHover(uri: string, line: number, character: number): Promise<Hover | null> {
		const result = await this.request('textDocument/hover', {
			textDocument: { uri },
			position: { line, character },
		})
		return (result as Hover | null) ?? null
	}

	async getCodeActions(uri: string, range: Location['range'], diagnostics: Diagnostic[]): Promise<CodeAction[]> {
		const result = await this.request('textDocument/codeAction', {
			textDocument: { uri },
			range,
			context: { diagnostics },
		})
		return (result as CodeAction[] | null) ?? []
	}

	async rename(uri: string, line: number, character: number, newName: string): Promise<WorkspaceEdit | null> {
		const result = await this.request('textDocument/rename', {
			textDocument: { uri },
			position: { line, character },
			newName,
		})
		return (result as WorkspaceEdit | null) ?? null
	}

	// ---------- JSON-RPC transport ----------

	private notificationHandlers: Array<(method: string, params: unknown) => void> = []

	private request(method: string, params: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (!this.proc?.stdin?.writable) {
				return reject(new Error('LSP server not running'))
			}
			const id = this.nextId++
			this.pending.set(id, { resolve, reject })
			this.send({ jsonrpc: '2.0', id, method, params } as JsonRpcRequest)

			// Timeout
			setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id)
					reject(new Error(`LSP request ${method} timed out after 30s`))
				}
			}, 30_000)
		})
	}

	private notify(method: string, params: unknown): void {
		this.send({ jsonrpc: '2.0', method, params } as JsonRpcNotification)
	}

	private send(msg: JsonRpcRequest | JsonRpcNotification): void {
		const body = JSON.stringify(msg)
		const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
		this.proc?.stdin?.write(header + body)
	}

	private setupReader(): void {
		if (!this.proc?.stdout) return

		let contentLength = -1
		let buffer = ''

		this.proc.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf-8')

			while (true) {
				if (contentLength < 0) {
					// Look for Content-Length header
					const headerEnd = buffer.indexOf('\r\n\r\n')
					if (headerEnd < 0) break
					const header = buffer.slice(0, headerEnd)
					const match = CONTENT_LENGTH_RE.exec(header)
					if (match) {
						contentLength = parseInt(match[1], 10)
					}
					buffer = buffer.slice(headerEnd + 4)
				}

				if (contentLength >= 0 && buffer.length >= contentLength) {
					const body = buffer.slice(0, contentLength)
					buffer = buffer.slice(contentLength)
					contentLength = -1

					try {
						const msg = JSON.parse(body) as JsonRpcResponse | JsonRpcNotification
						this.handleMessage(msg)
					} catch {
						// Ignore malformed messages
					}
				} else {
					break
				}
			}
		})
	}

	private handleMessage(msg: JsonRpcResponse | JsonRpcNotification): void {
		if ('id' in msg && msg.id != null) {
			// Response
			const p = this.pending.get(msg.id)
			if (p) {
				this.pending.delete(msg.id)
				if (msg.error) {
					p.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`))
				} else {
					p.resolve(msg.result)
				}
			}
		} else if ('method' in msg) {
			// Notification
			for (const handler of this.notificationHandlers) {
				handler(msg.method, (msg as JsonRpcNotification).params)
			}
		}
	}

	private rejectAll(error: Error): void {
		for (const [, p] of this.pending) {
			p.reject(error)
		}
		this.pending.clear()
	}
}
