/**
 * LSP client pool — manages one LspClient per language per workspace.
 *
 * Handles crash recovery (restart up to MAX_RESTARTS within RESTART_WINDOW_MS),
 * lazy startup (first request triggers spawn), and graceful teardown.
 */

import { LspClient } from './client'
import { ServerRegistry, type ServerEntry } from './server-registry'

const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

interface PoolEntry {
	client: LspClient
	language: string
	restarts: number[]
}

export class LspPool {
	private pool = new Map<string, PoolEntry>()
	private registry: ServerRegistry

	constructor(
		private readonly rootUri: string,
		private readonly logger: { log: (...args: unknown[]) => void },
		userOverrides?: Record<string, string>,
	) {
		this.registry = new ServerRegistry(userOverrides)
	}

	/**
	 * Get a live client for the given language, starting one if needed.
	 * Returns null if no server entry exists for the language.
	 */
	async get(language: string): Promise<LspClient | null> {
		const existing = this.pool.get(language)
		if (existing?.client.alive) return existing.client

		const entry = this.registry.forLanguage(language)
		if (!entry) return null

		return this.startClient(language, entry)
	}

	/** Check whether a server is known for a language (without spawning). */
	has(language: string): boolean {
		return this.registry.forLanguage(language) !== null
	}

	/** Get a list of languages with running servers. */
	activeLanguages(): string[] {
		const out: string[] = []
		for (const [lang, entry] of this.pool) {
			if (entry.client.alive) out.push(lang)
		}
		return out
	}

	/** Shut down all running servers. */
	async closeAll(): Promise<void> {
		const tasks = Array.from(this.pool.values()).map(e => e.client.stop())
		await Promise.allSettled(tasks)
		this.pool.clear()
	}

	// ---------- internal ----------

	private async startClient(language: string, entry: ServerEntry): Promise<LspClient | null> {
		// Check restart budget
		const existing = this.pool.get(language)
		if (existing) {
			const now = Date.now()
			existing.restarts = existing.restarts.filter(t => now - t < RESTART_WINDOW_MS)
			if (existing.restarts.length >= MAX_RESTARTS) {
				this.logger.log(
					`[lsp-pool] ${entry.name} exceeded restart budget (${MAX_RESTARTS}x in ${RESTART_WINDOW_MS / 1000}s)`,
				)
				return null
			}
			existing.restarts.push(now)
		}

		const client = new LspClient(entry, this.rootUri, this.logger)
		try {
			await client.start()
			this.pool.set(language, {
				client,
				language,
				restarts: existing?.restarts ?? [],
			})
			this.logger.log(`[lsp-pool] ${entry.name} started for language=${language}`)
			return client
		} catch (err) {
			this.logger.log(`[lsp-pool] ${entry.name} failed to start: ${err instanceof Error ? err.message : err}`)
			return null
		}
	}
}
