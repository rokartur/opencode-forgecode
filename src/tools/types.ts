import type { Database } from '../runtime/sqlite'
import type { PluginConfig, Logger } from '../types'
import type { createKvService } from '../services/kv'
import type { createLoopService } from '../services/loop'
import type { createLoopEventHandler } from '../hooks'
import type { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import type { PluginInput } from '@opencode-ai/plugin'
import type { createSandboxManager } from '../sandbox/manager'
import type { GraphService } from '../graph/service'
import type { SessionRecoveryManager } from '../runtime/session-recovery'
import type { AgentBudgetEnforcer } from '../runtime/agent-budget'
import type { TelemetryCollector } from '../runtime/telemetry'
import type { LspPool } from '../runtime/lsp/pool'
import type { BackgroundSpawner } from '../runtime/background/spawner'
import type { BackgroundManager } from '../runtime/background/manager'
import type { ConcurrencyManager } from '../runtime/background/concurrency'

/**
 * Context passed to all tool implementations providing access to plugin services.
 */
export interface ToolContext {
	/** The current project ID. */
	projectId: string
	/** The working directory of the project. */
	directory: string
	/** The plugin configuration. */
	config: PluginConfig
	/** Logger instance for the plugin. */
	logger: Logger
	/** Bun SQLite database instance. `null` when the plugin is running in
	 * degraded mode because `initializeDatabase` failed; callers must only
	 * rely on `kvService` for persistent state in that case. */
	db: Database | null
	/** Data directory path for plugin storage. */
	dataDir: string
	/** KV service for key-value storage. Transparently switches to an
	 * in-memory backend in degraded mode. */
	kvService: ReturnType<typeof createKvService>
	/** Loop service for managing autonomous loops. */
	loopService: ReturnType<typeof createLoopService>
	/** Loop event handler for triggering loop lifecycle events. */
	loopHandler: ReturnType<typeof createLoopEventHandler>
	/** OpenCode v2 API client. */
	v2: ReturnType<typeof createV2Client>
	/** Cleanup function to call on plugin shutdown. */
	cleanup: () => Promise<void>
	/** Original plugin input from OpenCode. */
	input: PluginInput
	/** Sandbox manager instance, null if sandboxing is disabled. */
	sandboxManager: ReturnType<typeof createSandboxManager> | null
	/** Graph service instance, null if graph is disabled. */
	graphService: GraphService | null
	/** Session recovery manager for timeout/overload/context-overflow resilience. */
	recoveryManager: SessionRecoveryManager
	/** Per-agent budget enforcer for turn/failure/request/token limits. */
	budgetEnforcer: AgentBudgetEnforcer
	/** Local telemetry collector (may be disabled). */
	telemetry: TelemetryCollector
	/** LSP client pool for language-server tools, null if LSP is disabled. */
	lspPool: LspPool | null
	/** Background task spawner, null if background runtime is disabled. */
	bgSpawner: BackgroundSpawner | null
	/** Background task manager for querying task state, null if disabled. */
	bgManager: BackgroundManager | null
	/** Concurrency manager for background tasks, null if disabled. */
	bgConcurrency: ConcurrencyManager | null
	/** True when plugin init fell back to in-memory KV due to DB failure. */
	degraded?: boolean
}
