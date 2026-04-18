import { RpcClient, RPC_SCAN_TIMEOUT_MS } from './rpc'
import type { RpcTransport } from './ipc-transport'
import { isReadOnlyMethod } from './read-only-methods'
import { LeaderLostError, isTransportFailure } from './errors'
import type {
	GraphStats,
	TopFileResult,
	FileDepResult,
	FileCoChangeResult,
	FileSymbolResult,
	SymbolSearchResult,
	SymbolSignatureResult,
	CallerResult,
	CalleeResult,
	UnusedExportResult,
	DuplicateStructureResult,
	NearDuplicateResult,
	ExternalPackageResult,
	PrepareScanResult,
	ScanBatchResult,
	OrphanFileResult,
	CircularDependencyResult,
	ChangeImpactResult,
	SymbolReferenceResult,
} from './types'
import type { Logger } from '../types'

interface GraphWorkerConfig {
	cwd: string
	dbPath: string
	logger?: Logger
}

/**
 * GraphClient communicates with the graph worker via RPC
 * All tree-sitter parsing and SQLite queries run in worker thread
 */
export class GraphClient {
	private client: RpcClient | null = null
	private worker: Worker | null = null
	private ready = false
	private workerError: Error | null = null
	private mode: 'leader' | 'follower' | null = null
	private failoverProvider: (() => Promise<void>) | null = null
	private logger?: Logger
	private activeFailover: Promise<void> | null = null
	private readOnlyDispatcher: ((method: string, args: unknown[]) => Promise<unknown>) | null = null

	async initialize(_config: GraphWorkerConfig): Promise<void> {
		// Worker / transport will be installed by service layer before use.
		this.ready = true
	}

	setWorker(worker: Worker, logger?: Logger): void {
		this.worker = worker
		this.logger = logger ?? this.logger
		this.client = new RpcClient(worker, logger)
		this.mode = 'leader'
		this.attachClientHandlers()
	}

	/**
	 * Point the client at an arbitrary RpcTransport (used in follower mode
	 * where we speak to a remote leader over a socket instead of owning a
	 * worker ourselves).
	 */
	setTransport(transport: RpcTransport, logger?: Logger, mode: 'leader' | 'follower' = 'follower'): void {
		this.logger = logger ?? this.logger
		this.client = new RpcClient(transport, logger)
		this.mode = mode
		this.attachClientHandlers()
	}

	/**
	 * Install the failover provider used by read-only retries. The provider
	 * is called when an RPC fails with a transport error. It is responsible
	 * for reinstalling a working transport (typically by calling
	 * `setTransport()` or `promoteToLeader()` on this client). GraphClient
	 * will then retry the failed call exactly once.
	 */
	setFailoverProvider(provider: () => Promise<void>): void {
		this.failoverProvider = provider
	}

	clearFailoverProvider(): void {
		this.failoverProvider = null
	}

	/**
	 * Promote this client from follower to leader. Used by the failover
	 * provider when the previous leader died and this process won the next
	 * lock acquisition. The worker reference is retained so close() can
	 * terminate it later.
	 */
	promoteToLeader(worker: Worker, logger?: Logger): void {
		this.worker = worker
		this.logger = logger ?? this.logger
		if (this.client) {
			try {
				this.client.terminate()
			} catch {
				/* ignore */
			}
		}
		// Leaders don't need the read-only fast path — they own the write
		// handle and route everything through the worker thread.
		this.readOnlyDispatcher = null
		this.client = new RpcClient(worker, logger)
		this.mode = 'leader'
		this.attachClientHandlers()
	}

	private attachClientHandlers(): void {
		if (!this.client) return
		this.client.on('error', (error: Error) => {
			this.ready = false
			this.workerError = error
		})
		this.client.on('exit', () => {
			this.ready = false
			// Phase 5: when the transport closes (e.g. leader sent goodbye),
			// we want to converge eagerly rather than waiting for the next
			// write call. This matters especially when the follower has the
			// read-only fast path installed — otherwise RO calls would keep
			// succeeding locally while the cluster never elected a new leader.
			// Only kick off failover in follower mode: on a leader, an exit
			// event means the worker died, which is a different failure mode
			// handled elsewhere (we currently don't auto-restart the worker).
			if (this.mode === 'follower' && this.failoverProvider) {
				void this.runFailover().catch(() => {})
			}
		})
	}

	getMode(): 'leader' | 'follower' | null {
		return this.mode
	}

	/**
	 * Install a local read-only dispatcher (Phase 5 fast path). When set,
	 * read-only RPC methods are served locally via this function instead of
	 * hopping over IPC to the leader. If the local dispatcher throws, we
	 * fall back to the remote transport so a transient read-only-handle
	 * problem (e.g. the file was rotated by a fresh scan) doesn't surface
	 * as an error to the caller.
	 */
	setReadOnlyDispatcher(dispatcher: (method: string, args: unknown[]) => Promise<unknown>): void {
		this.readOnlyDispatcher = dispatcher
	}

	clearReadOnlyDispatcher(): void {
		this.readOnlyDispatcher = null
	}

	/**
	 * Forwarding entry point used by the leader's IPC server to route
	 * follower RPC calls into the local worker. Delegates to the underlying
	 * RpcClient, which handles callId multiplexing so multiple followers +
	 * local callers can share the same worker safely.
	 */
	async forward<T = unknown>(method: string, args: unknown[]): Promise<T> {
		if (!this.client) throw new Error('Graph client not initialized')
		return this.client.call<T>(method, args)
	}

	/**
	 * Internal dispatch used by every typed method. On transport failure:
	 *   - read-only methods: wait for failover (if provider installed) and
	 *     retry exactly once;
	 *   - write methods: surface `LeaderLostError` so the caller knows the
	 *     operation may have been partially applied.
	 */
	private async invoke<T>(method: string, args: unknown[], timeoutMs?: number): Promise<T> {
		if (!this.client) throw new Error('Graph client not initialized')
		// If a failover is currently running (kicked off eagerly by a
		// transport 'exit' event, or by a previous failed call), wait for
		// it to complete before serving *any* method — including read-only
		// ones. Otherwise the RO fast path could keep returning locally
		// while the cluster is mid-promotion, which makes tests racy and,
		// more importantly, can surface partial results to callers right
		// after a leader switch.
		if (this.activeFailover) {
			try {
				await this.activeFailover
			} catch {
				/* runFailover already handled/logged; fall through and let the
           regular error paths below classify the failure. */
			}
			if (!this.client) throw new Error('Graph client not initialized')
		}
		// Phase 5 read-only fast path: if a local dispatcher is installed and
		// this is a read-only method, serve it locally. This is the default
		// for followers with their own read-only SQLite handle, eliminating
		// the IPC round-trip for queries (scan only happens on the leader).
		//
		// Important: we only take the fast path when the transport is known
		// healthy. If the transport is unhealthy, the leader is likely dead
		// and we want to fall through to the failover path so the cluster
		// converges (promotion / reconnect) — otherwise a follower could
		// silently serve stale reads forever while never triggering failover.
		if (this.readOnlyDispatcher && isReadOnlyMethod(method) && this.client.isHealthy()) {
			try {
				return (await this.readOnlyDispatcher(method, args)) as T
			} catch (err) {
				// Local dispatch failed — fall through to remote transport. This
				// covers schema-version mismatches after a fresh scan or a file
				// rotation race (very rare). The log is debug-only; the caller
				// sees a successful result via the slow path.
				this.logger?.debug?.(
					`GraphClient: local read-only dispatch for '${method}' failed, falling back to RPC: ${
						err instanceof Error ? err.message : String(err)
					}`,
				)
			}
		}
		// Fast path: if transport is already known dead, skip straight to
		// failover instead of letting the send queue into a dead socket and
		// waiting 120s for the RPC timeout.
		if (!this.client.isHealthy() && this.failoverProvider) {
			if (!isReadOnlyMethod(method)) {
				void this.runFailover().catch(() => {})
				throw new LeaderLostError(method)
			}
			try {
				await this.runFailover()
			} catch (failErr) {
				throw new LeaderLostError(method, failErr as Error)
			}
			if (!this.client) throw new LeaderLostError(method)
		}
		try {
			return await this.client.call<T>(method, args, timeoutMs)
		} catch (err) {
			if (!isTransportFailure(err)) throw err
			if (!this.failoverProvider) {
				if (!isReadOnlyMethod(method)) {
					throw new LeaderLostError(method, err as Error)
				}
				throw err
			}
			if (!isReadOnlyMethod(method)) {
				// Kick failover off in the background so read-only callers can
				// piggyback on it, but do NOT retry write methods.
				void this.runFailover().catch(() => {})
				throw new LeaderLostError(method, err as Error)
			}
			// Read-only path: await (and possibly start) a single failover cycle.
			try {
				await this.runFailover()
			} catch (failErr) {
				throw new LeaderLostError(method, failErr as Error)
			}
			if (!this.client) throw new LeaderLostError(method)
			return await this.client.call<T>(method, args, timeoutMs)
		}
	}

	private runFailover(): Promise<void> {
		if (!this.failoverProvider) return Promise.reject(new Error('no failover provider'))
		if (this.activeFailover) return this.activeFailover
		const provider = this.failoverProvider
		const p = (async () => {
			try {
				await provider()
				if (!this.client) {
					throw new Error('client closed during failover')
				}
			} finally {
				this.activeFailover = null
			}
		})()
		this.activeFailover = p
		return p
	}

	markWorkerDead(error?: Error): void {
		this.ready = false
		if (error) {
			this.workerError = error
		}
		if (this.client) {
			this.client.markTerminated()
		}
	}

	getWorkerError(): Error | null {
		return this.workerError
	}

	async scan(): Promise<void> {
		// Full-scan round-trip: use the long scan timeout; the worker drives
		// the whole scan internally (legacy non-batched path).
		await this.invoke<void>('scan', [], RPC_SCAN_TIMEOUT_MS)
	}

	async prepareScan(): Promise<PrepareScanResult> {
		return this.invoke<PrepareScanResult>('prepareScan', [], RPC_SCAN_TIMEOUT_MS)
	}

	async scanBatch(offset: number, batchSize: number): Promise<ScanBatchResult> {
		return this.invoke<ScanBatchResult>('scanBatch', [offset, batchSize], RPC_SCAN_TIMEOUT_MS)
	}

	async finalizeScan(): Promise<void> {
		await this.invoke<void>('finalizeScan', [], RPC_SCAN_TIMEOUT_MS)
	}

	async getStats(): Promise<GraphStats> {
		return this.invoke<GraphStats>('getStats', [])
	}

	async getTopFiles(limit = 20): Promise<TopFileResult[]> {
		return this.invoke<TopFileResult[]>('getTopFiles', [limit])
	}

	async getFileDependents(relPath: string): Promise<FileDepResult[]> {
		return this.invoke<FileDepResult[]>('getFileDependents', [relPath])
	}

	async getFileDependencies(relPath: string): Promise<FileDepResult[]> {
		return this.invoke<FileDepResult[]>('getFileDependencies', [relPath])
	}

	async getFileCoChanges(relPath: string): Promise<FileCoChangeResult[]> {
		return this.invoke<FileCoChangeResult[]>('getFileCoChanges', [relPath])
	}

	async getFileBlastRadius(relPath: string): Promise<number> {
		return this.invoke<number>('getFileBlastRadius', [relPath])
	}

	async getFileSymbols(relPath: string): Promise<FileSymbolResult[]> {
		return this.invoke<FileSymbolResult[]>('getFileSymbols', [relPath])
	}

	async findSymbols(name: string, limit = 50): Promise<SymbolSearchResult[]> {
		return this.invoke<SymbolSearchResult[]>('findSymbols', [name, limit])
	}

	async searchSymbolsFts(query: string, limit = 20): Promise<SymbolSearchResult[]> {
		return this.invoke<SymbolSearchResult[]>('searchSymbolsFts', [query, limit])
	}

	async getSymbolSignature(path: string, line: number): Promise<SymbolSignatureResult | null> {
		return this.invoke<SymbolSignatureResult | null>('getSymbolSignature', [path, line])
	}

	async getCallers(path: string, line: number): Promise<CallerResult[]> {
		return this.invoke<CallerResult[]>('getCallers', [path, line])
	}

	async getCallees(path: string, line: number): Promise<CalleeResult[]> {
		return this.invoke<CalleeResult[]>('getCallees', [path, line])
	}

	async getUnusedExports(limit = 20): Promise<UnusedExportResult[]> {
		return this.invoke<UnusedExportResult[]>('getUnusedExports', [limit])
	}

	async getDuplicateStructures(limit = 20): Promise<DuplicateStructureResult[]> {
		return this.invoke<DuplicateStructureResult[]>('getDuplicateStructures', [limit])
	}

	async getNearDuplicates(threshold = 0.8, limit = 50): Promise<NearDuplicateResult[]> {
		return this.invoke<NearDuplicateResult[]>('getNearDuplicates', [threshold, limit])
	}

	async getExternalPackages(limit = 20): Promise<ExternalPackageResult[]> {
		return this.invoke<ExternalPackageResult[]>('getExternalPackages', [limit])
	}

	async render(opts?: { maxFiles?: number; maxSymbols?: number }): Promise<{ content: string; paths: string[] }> {
		return this.invoke<{ content: string; paths: string[] }>('render', [opts])
	}

	async getOrphanFiles(limit = 50): Promise<OrphanFileResult[]> {
		return this.invoke<OrphanFileResult[]>('getOrphanFiles', [limit])
	}

	async getCircularDependencies(limit = 20): Promise<CircularDependencyResult[]> {
		return this.invoke<CircularDependencyResult[]>('getCircularDependencies', [limit])
	}

	async getChangeImpact(paths: string[], maxDepth = 5): Promise<ChangeImpactResult> {
		return this.invoke<ChangeImpactResult>('getChangeImpact', [paths, maxDepth])
	}

	async getSymbolReferences(name: string, limit = 50): Promise<SymbolReferenceResult[]> {
		return this.invoke<SymbolReferenceResult[]>('getSymbolReferences', [name, limit])
	}

	async onFileChanged(absPath: string): Promise<void> {
		if (!this.client) return
		if (!this.ready) {
			throw new Error('Graph client not ready - worker may be unavailable')
		}
		await this.invoke<void>('onFileChanged', [absPath])
	}

	async close(): Promise<void> {
		this.failoverProvider = null
		this.readOnlyDispatcher = null
		this.activeFailover = null
		if (this.client) {
			this.client.terminate()
			this.client = null
		}
		if (this.worker) {
			this.worker.terminate()
			this.worker = null
		}
		this.ready = false
		this.mode = null
	}

	isReady(): boolean {
		return this.ready
	}
}
