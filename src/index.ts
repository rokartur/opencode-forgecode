import type { Plugin, PluginInput, Hooks } from '@opencode-ai/plugin'
import { createOpencodeClient as createV2Client } from '@opencode-ai/sdk/v2'
import { agents } from './agents'
import { createConfigHandler } from './config'
import { createSessionHooks, createLoopEventHandler, createHarnessHooks } from './hooks'
import { initializeDatabase, resolveDataDir, closeDatabase } from './storage'
import { createKvService, createInMemoryKvService } from './services/kv'
import { createLoopService, migrateRalphKeys } from './services/loop'
import { createGraphService } from './graph'
import { loadPluginConfig } from './setup'
import { resolveLogPath } from './storage'
import { createLogger } from './utils/logger'
import { createDockerService } from './sandbox/docker'
import { createSandboxManager } from './sandbox/manager'
import type { PluginConfig, CompactionConfig } from './types'
import {
	createTools,
	createToolExecuteBeforeHook,
	createToolExecuteAfterHook,
	createPlanApprovalEventHook,
} from './tools'
import { createSandboxToolBeforeHook, createSandboxToolAfterHook } from './hooks/sandbox-tools'
import { createHostToolBeforeHook, createHostToolAfterHook } from './hooks/host-tools'
import { createDeltaReadBeforeHook, createDeltaReadAfterHook } from './hooks/delta-read'
import { createToolArchiveAfterHook } from './hooks/tool-archive'
import { createGraphCommandEventHook } from './hooks/graph-command'
import { createGraphToolBeforeHook, createGraphToolAfterHook } from './hooks/graph-tools'
import type { ToolContext } from './tools'
import type { GraphService } from './graph'
import { createGraphStatusCallback, writeGraphStatus, UNAVAILABLE_STATUS } from './utils/graph-status-store'
import { logUnsupportedConfigIssues, getCapabilityDescriptors } from './runtime/feature-support'
import { SessionRecoveryManager } from './runtime/session-recovery'
import { AgentBudgetEnforcer } from './runtime/agent-budget'
import { TelemetryCollector } from './runtime/telemetry'
import { createBudgetHooks } from './hooks/budget'
import { createRestrictedShellHooks } from './hooks/restricted-shell'
import { createContextInjectionHooks } from './hooks/context-injection'
import { createSkillLoaderHooks } from './hooks/skill-loader'
import { createIntentRouterHooks } from './hooks/intent-router'
import { createUserPromptTemplateHooks } from './hooks/user-prompt-template'
import { LspPool } from './runtime/lsp/pool'
import { BackgroundManager } from './runtime/background/manager'
import { ConcurrencyManager } from './runtime/background/concurrency'
import { BackgroundSpawner } from './runtime/background/spawner'
import { ensureRtkInstalled } from './runtime/rtk'
import { createRtkGuidanceHooks } from './hooks/rtk-guidance'
import { createCommentCheckerHooks } from './hooks/comment-checker'
import { createSessionRetryHooks } from './hooks/session-retry'
import { createToolArchiveService } from './services/tool-archive'
import { QualityScorer, ProgressiveCheckpointManager } from './harness'
import { runAutoModelSetup } from './runtime/auto-model-setup'

/**
 * Creates an OpenCode plugin instance with loop management, graph indexing, and sandboxing.
 *
 * @param config - Plugin configuration including loop, graph, sandbox, and logging settings
 * @returns OpenCode Plugin instance with hooks for tools, events, and session management
 */
export function createForgePlugin(config: PluginConfig): Plugin {
	return async (input: PluginInput): Promise<Hooks> => {
		const { directory, project, client } = input
		const projectId = project.id

		const serverUrl = input.serverUrl
		const serverPassword = serverUrl.password || process.env['OPENCODE_SERVER_PASSWORD']
		const cleanUrl = new URL(serverUrl.toString())
		cleanUrl.username = ''
		cleanUrl.password = ''
		const v2ClientConfig: Parameters<typeof createV2Client>[0] = {
			baseUrl: cleanUrl.toString(),
			directory,
		}
		if (serverPassword) {
			v2ClientConfig.headers = {
				Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString('base64')}`,
			}
		}
		const v2 = createV2Client(v2ClientConfig)

		const loggingConfig = config.logging
		const logger = createLogger({
			enabled: loggingConfig?.enabled ?? false,
			file: loggingConfig?.file ?? resolveLogPath(),
			debug: loggingConfig?.debug ?? false,
		})
		logger.log(`Initializing plugin for directory: ${directory}, projectId: ${projectId}`)
		logger.log(`[diag] serverUrl raw=${input.serverUrl.toString()} clean=${cleanUrl.toString()} protocol=${cleanUrl.protocol} hostname=${cleanUrl.hostname} port=${cleanUrl.port}`)
		logUnsupportedConfigIssues(logger, config)
		const caps = getCapabilityDescriptors()
		const active = caps.filter(c => c.status === 'implemented').length
		logger.log(`Capabilities: ${active}/${caps.length} active`)

		// Auto-assign subagent models based on the user's connected providers.
		// Runs only for agents without an explicit `model` in forge-config.jsonc
		// and never fails plugin init. See src/runtime/auto-model-setup.ts.
		await runAutoModelSetup(client, directory, config, logger)

		// Fire-and-forget RTK installer. Never blocks plugin init.
		void ensureRtkInstalled(logger, config.rtk).catch(err => {
			logger.error(`[rtk] unexpected installer error: ${err instanceof Error ? err.message : String(err)}`)
		})

		const dataDir = config.dataDir || resolveDataDir()

		// Soft-fail DB init: if the persistent KV store cannot be opened (real
		// corruption, EACCES, read-only FS, disk full), fall back to an
		// in-memory KV so agents (forge/muse/sage) still get registered and
		// the session remains usable, just without persistence. A fresh
		// process start will retry normally.
		let db: ReturnType<typeof initializeDatabase> | null = null
		let kvService: ReturnType<typeof createKvService>
		let degraded = false
		try {
			db = initializeDatabase(dataDir)
			kvService = createKvService(db, logger, config.defaultKvTtlMs)
		} catch (err) {
			degraded = true
			logger.error('Degraded mode: DB init failed; KV is in-memory for this session (data will not persist)', err)
			kvService = createInMemoryKvService(logger, config.defaultKvTtlMs)
		}

		const loopService = createLoopService(kvService, projectId, logger, config.loop)
		try {
			migrateRalphKeys(kvService, projectId, logger)
		} catch (err) {
			logger.error('Failed to migrate ralph: KV entries', err)
		}

		// Best-effort loop state reconciliation. Never fail plugin init (and with it,
		// forge agent registration) because of a transient KV/DB hiccup here.
		let activeSandboxLoops: ReturnType<typeof loopService.listActive> = []
		try {
			activeSandboxLoops = loopService.listActive().filter(s => s.sandbox && s.loopName)
		} catch (err) {
			logger.error('Failed to list active loops; continuing with empty list', err)
		}

		try {
			const reconciledCount = loopService.reconcileStale()
			if (reconciledCount > 0) {
				logger.log(`Reconciled ${reconciledCount} stale loop(s) from previous session`)
			}
		} catch (err) {
			logger.error('Failed to reconcile stale loops; continuing', err)
		}

		let sandboxManager: ReturnType<typeof createSandboxManager> | null = null
		if (config.sandbox?.mode === 'docker') {
			const dockerService = createDockerService(logger)
			try {
				sandboxManager = createSandboxManager(
					dockerService,
					{
						image: config.sandbox?.image || 'oc-forge-sandbox:latest',
					},
					logger,
				)
				logger.log('Docker sandbox manager initialized')
			} catch (err) {
				logger.error('Failed to initialize Docker sandbox manager', err)
			}
		}

		if (sandboxManager) {
			const preserveLoops = activeSandboxLoops.map(s => s.loopName!).filter(Boolean)
			sandboxManager
				.cleanupOrphans(preserveLoops)
				.then(async count => {
					if (count > 0) logger.log(`Cleaned up ${count} orphaned sandbox container(s)`)
					for (const loop of activeSandboxLoops) {
						try {
							await sandboxManager!.restore(loop.loopName!, loop.worktreeDir, loop.startedAt)
							loopService.setState(loop.loopName!, { ...loop, active: true })
							logger.log(`Restored sandbox and reactivated loop for ${loop.loopName}`)
						} catch (err) {
							logger.error(`Failed to restore sandbox for ${loop.loopName}`, err)
						}
					}
				})
				.catch(err => logger.error('Failed to cleanup orphaned containers', err))
		}

		const recoveryManager = new SessionRecoveryManager(logger)
		logger.log(`Session recovery manager initialized (maxTimeoutRetries=${3}, maxOverloadRetries=${3})`)

		// Budget enforcer — per-agent turn/failure/request/token limits
		const budgetEnforcer = new AgentBudgetEnforcer(logger, config.agents ? 'warn_then_stop' : 'warn')

		// Telemetry collector — local-only, opt-in, SQLite-backed
		const telemetry = new TelemetryCollector(logger, config.telemetry)
		if (telemetry.isEnabled() && db) {
			telemetry.init(db as Parameters<TelemetryCollector['init']>[0])
			logger.log('[telemetry] collector initialized')
		}

		const budgetHooks = createBudgetHooks(budgetEnforcer, logger, config, telemetry, projectId, kvService)

		// Stage 4 hooks — safety & routing
		const shellHooks = createRestrictedShellHooks(logger, config)
		const contextHooks = createContextInjectionHooks(logger, directory, config)
		const skillHooks = createSkillLoaderHooks(logger, directory, config)
		const intentHooks = createIntentRouterHooks(logger, config)
		const userPromptHooks = createUserPromptTemplateHooks(logger, config)
		const rtkHooks = createRtkGuidanceHooks(logger, config)
		const commentCheckerHooks = createCommentCheckerHooks(logger, config)

		// Stage 5 hooks — token optimization
		const deltaReadBeforeHook = createDeltaReadBeforeHook({
			logger,
			cwd: directory,
			config: config.deltaRead,
		})
		const deltaReadAfterHook = createDeltaReadAfterHook({
			logger,
			cwd: directory,
			config: config.deltaRead,
		})

		const archiveService =
			config.toolArchive?.enabled !== false
				? createToolArchiveService(kvService, projectId, logger, config.toolArchive)
				: null
		const toolArchiveAfterHook = archiveService
			? createToolArchiveAfterHook({ archiveService, logger, enabled: true })
			: null

		const qualityScorer = config.qualityScore?.enabled !== false ? new QualityScorer(logger) : null

		const checkpointManager =
			config.checkpoints?.enabled !== false && qualityScorer
				? new ProgressiveCheckpointManager(kvService, projectId, logger, qualityScorer, config.checkpoints)
				: null

		const loopHandler = createLoopEventHandler(
			loopService,
			client,
			v2,
			logger,
			() => config,
			sandboxManager || undefined,
			projectId,
			dataDir,
			recoveryManager,
			telemetry,
		)

		// Initialize graph service if enabled
		const graphEnabled = config.graph?.enabled ?? true
		let graphService: GraphService | null = null

		if (graphEnabled) {
			try {
				// Create status callback for persisting graph state (scoped to cwd for worktree sessions)
				const graphStatusCallback = createGraphStatusCallback(kvService, projectId, directory)

				graphService = createGraphService({
					projectId,
					dataDir,
					cwd: directory,
					logger,
					watch: config.graph?.watch ?? true,
					debounceMs: config.graph?.debounceMs,
					onStatusChange: graphStatusCallback,
				})

				// Guarded auto-scan if enabled - checks cache freshness before scanning
				const autoScan = config.graph?.autoScan ?? true
				if (autoScan) {
					graphService.ensureStartupIndex().catch(err => {
						logger.error('Graph startup index check failed', err)
					})
				}
			} catch (err) {
				logger.error('Failed to initialize graph service', err)
				graphService = null
			}
		} else {
			// Graph is disabled - persist unavailable status
			writeGraphStatus(kvService, projectId, UNAVAILABLE_STATUS)
		}

		// Initialize LSP pool if enabled
		let lspPool: LspPool | null = null
		if (config.lsp?.enabled) {
			try {
				const rootUri = `file://${directory}`
				lspPool = new LspPool(
					rootUri,
					{ log: (msg: unknown, ...rest: unknown[]) => logger.log(String(msg), ...rest) },
					config.lsp.servers,
				)
				logger.log('[lsp] Pool initialized')
			} catch (err) {
				logger.error('Failed to initialize LSP pool', err)
				lspPool = null
			}
		}

		// Initialize background task runtime if enabled
		let bgManager: BackgroundManager | null = null
		let bgConcurrency: ConcurrencyManager | null = null
		let bgSpawner: BackgroundSpawner | null = null
		if (db) {
			try {
				const backgroundConfig = config.background ?? {
					enabled: false,
					maxConcurrent: 4,
					perModelLimit: 2,
					pollIntervalMs: 5000,
					idleTimeoutMs: 120000,
				}
				bgManager = new BackgroundManager(db)
				bgConcurrency = new ConcurrencyManager(bgManager, {
					maxConcurrent: backgroundConfig.maxConcurrent,
					perModelLimit: backgroundConfig.perModelLimit,
				})

				if (backgroundConfig.enabled) {
					bgSpawner = new BackgroundSpawner(
						v2,
						bgManager,
						bgConcurrency,
						directory,
						{ log: (msg: unknown, ...rest: unknown[]) => logger.log(String(msg), ...rest) },
						{
							pollIntervalMs: backgroundConfig.pollIntervalMs,
							idleTimeoutMs: backgroundConfig.idleTimeoutMs,
							onTaskEvent: ({ type, task }) => {
								// Emit a TUI toast so the user sees when a background task
								// finishes without having to poll the sidebar.
								const variant = type === 'completed' ? 'success' : type === 'error' ? 'error' : 'info'
								const verb = type === 'completed' ? 'completed' : type === 'error' ? 'failed' : 'cancelled'
								const title = `Background ${verb}`
								const message = `${task.targetAgent}: ${task.prompt.slice(0, 80)}${task.prompt.length > 80 ? '…' : ''}`
								v2.tui
									.showToast({
										directory,
										title,
										message,
										variant,
										duration: 5000,
									})
									.catch(err => logger.debug('[background] toast failed', err))
							},
						},
					)
					logger.log('[background] Runtime initialized')
				} else {
					logger.log('[background] Lite runtime initialized (session-backed bg_* tools; spawner disabled)')
				}
			} catch (err) {
				logger.error('Failed to initialize background runtime', err)
				bgManager = null
				bgConcurrency = null
				bgSpawner = null
			}
		}

		if (degraded) {
			// Surface the degraded session to the TUI status bar so the user
			// notices that persistence is off this session.
			try {
				writeGraphStatus(kvService, projectId, {
					state: 'error',
					ready: false,
					message: 'DB init failed; running with in-memory KV (no persistence)',
					updatedAt: Date.now(),
				})
			} catch (err) {
				logger.error('Failed to publish degraded status', err)
			}
		}

		const compactionConfig: CompactionConfig | undefined = config.compaction
		const messagesTransformConfig = config.messagesTransform
		const sessionHooks = createSessionHooks(projectId, logger, input, compactionConfig)

		const harnessHooks = createHarnessHooks({
			logger,
			projectId,
			directory,
			dataDir,
			config: config.harness,
			appendPrompt: async (_sessionId, text) => {
				try {
					await v2.tui.appendPrompt({ directory, text })
				} catch (err) {
					logger.debug('harness: tui.appendPrompt failed', err)
				}
			},
		})

		let cleanupPromise: Promise<void> | null = null

		const cleanup = (): Promise<void> => {
			if (cleanupPromise) {
				return cleanupPromise
			}
			cleanupPromise = (async () => {
				logger.log('Cleaning up plugin resources...')

				// Unregister process listeners before async work
				process.removeListener('exit', handleExit)
				process.removeListener('SIGINT', handleSigint)
				process.removeListener('SIGTERM', handleSigterm)

				if (sandboxManager) {
					const activeLoops = loopService.listActive()
					for (const state of activeLoops) {
						if (state.sandbox && sandboxManager) {
							try {
								await sandboxManager.stop(state.loopName!)
								logger.log(`Cleanup: stopped sandbox for ${state.loopName}`)
							} catch (err) {
								logger.error(`Cleanup: failed to stop sandbox for ${state.loopName}`, err)
							}
						}
					}
				}

				loopHandler.terminateAll()
				logger.log('Loop: all active loops terminated')

				loopHandler.clearAllRetryTimeouts()

				if (graphService) {
					await graphService.close()
					logger.log('Graph service closed')
				}

				if (lspPool) {
					await lspPool.closeAll()
					logger.log('LSP pool closed')
				}

				if (bgSpawner) {
					bgSpawner.shutdown()
					logger.log('Background spawner shut down')
				}

				telemetry.close()

				if (db) {
					closeDatabase(db)
				}
				logger.log('Plugin cleanup complete')
			})()
			return cleanupPromise
		}

		const handleExit = cleanup
		const handleSigint = cleanup
		const handleSigterm = cleanup

		process.once('exit', handleExit)
		process.once('SIGINT', handleSigint)
		process.once('SIGTERM', handleSigterm)

		const getCleanup = cleanup

		const ctx: ToolContext = {
			projectId,
			directory,
			config,
			logger,
			db,
			dataDir,
			kvService,
			loopService,
			loopHandler,
			v2,
			cleanup,
			input,
			sandboxManager,
			graphService: graphService || null,
			recoveryManager,
			budgetEnforcer,
			telemetry,
			lspPool,
			bgSpawner,
			bgManager,
			bgConcurrency,
			degraded,
		}

		const tools = createTools(ctx)
		// Add expand tool for archived results retrieval
		if (archiveService) {
			const { createExpandTools } = await import('./tools/expand')
			Object.assign(tools, createExpandTools(ctx, archiveService))
		}
		// Add quality tool for context quality scoring
		if (qualityScorer) {
			const { createQualityTools } = await import('./tools/quality')
			Object.assign(tools, createQualityTools(ctx, qualityScorer))
		}
		const toolExecuteBeforeHook = createToolExecuteBeforeHook(ctx)
		const toolExecuteAfterHook = createToolExecuteAfterHook(ctx)
		const planApprovalEventHook = createPlanApprovalEventHook(ctx)
		const sessionRetryHooks = createSessionRetryHooks({
			loopService,
			v2,
			directory,
			logger,
		})
		const sandboxBeforeHook = createSandboxToolBeforeHook({
			loopService,
			sandboxManager,
			logger,
		})
		const sandboxAfterHook = createSandboxToolAfterHook({
			loopService,
			sandboxManager,
			logger,
		})
		const hostBeforeHook = createHostToolBeforeHook({
			loopService,
			sandboxManager,
			logger,
			cwd: directory,
			enabled: config?.host?.fastGrep !== false,
		})
		const hostAfterHook = createHostToolAfterHook({
			loopService,
			sandboxManager,
			logger,
			cwd: directory,
			enabled: config?.host?.fastGrep !== false,
		})
		const graphBeforeHook = createGraphToolBeforeHook({
			graphService: graphService || null,
			logger,
			cwd: directory,
		})
		const graphAfterHook = createGraphToolAfterHook({
			graphService: graphService || null,
			logger,
			cwd: directory,
		})
		const graphCommandHook = createGraphCommandEventHook(graphService || null, logger)

		return {
			getCleanup,
			tool: tools,
			config: createConfigHandler(agents, config.agents),
			'chat.message': async (input, output) => {
				await sessionHooks.onMessage(input, output)
				budgetHooks.onMessage(input as { sessionID: string; agent?: string })
				shellHooks.trackAgent(input as { sessionID: string; agent?: string })
				contextHooks.onMessage(
					input as { sessionID: string; messageID?: string },
					output as { parts: Array<Record<string, unknown>> },
				)
				skillHooks.onMessage(
					input as { sessionID: string; messageID?: string; agent?: string },
					output as { parts: Array<Record<string, unknown>> },
				)
				rtkHooks.onMessage(
					input as { sessionID: string; messageID?: string; agent?: string },
					output as { parts: Array<Record<string, unknown>> },
				)

				// Quality scoring + checkpoint check on each user message
				const msgInput = input as { sessionID: string }
				if (qualityScorer && msgInput.sessionID) {
					qualityScorer.recordMessage(msgInput.sessionID, '', true)
					const { nudge, result } = qualityScorer.shouldNudge(msgInput.sessionID, config.qualityScore)
					if (nudge) {
						logger.log(
							`[quality] nudge for session ${msgInput.sessionID}: ${result.score} (${result.grade})`,
						)
						try {
							await v2.tui.appendPrompt({
								directory,
								text: `[Forge] Context quality: ${result.score}/100 (${result.grade}). Consider /compact or starting a new session.`,
							})
						} catch (err) {
							logger.debug('[quality] tui.appendPrompt failed', err)
						}
					}
					// Check checkpoint thresholds
					checkpointManager?.recordMessage(msgInput.sessionID, 0)
					checkpointManager?.checkAndCapture(msgInput.sessionID)
				}
			},
			event: async input => {
				const eventInput = input as {
					event: { type: string; properties?: Record<string, unknown> }
				}
				if (eventInput.event?.type === 'server.instance.disposed') {
					await cleanup()
					return
				}
				await loopHandler.onEvent(eventInput)
				await sessionHooks.onEvent(eventInput)
				await harnessHooks.onEvent(eventInput)
				await planApprovalEventHook(eventInput)
				await graphCommandHook(eventInput)
				await sessionRetryHooks.onEvent(eventInput)
			},
			'tool.execute.before': async (input, output) => {
				const loopName = loopService.resolveLoopName(input.sessionID)
				if (loopName) {
					logger.log(
						`[tool-before] ${input.tool} callID=${input.callID} session=${input.sessionID} loop=${loopName}`,
					)
				}
				// Restricted shell check runs first — may neuter the command
				shellHooks.toolBefore(input, output as { args: unknown })
				// Order: graph → harness → existing → host → sandbox
				// Graph hook must run BEFORE sandbox hook to inspect original command
				// Graph hook must also run BEFORE toolExecuteBeforeHook to capture original args
				await graphBeforeHook!(input, output)
				await harnessHooks.toolBefore({
					sessionID: input.sessionID,
					tool: input.tool,
					args: output.args,
				})
				// Delta-read: intercept re-reads and serve diffs
				await deltaReadBeforeHook!(input, output)
				// Quality scorer: track tool calls
				qualityScorer?.recordToolCall(input.sessionID)
				await toolExecuteBeforeHook!(input, output)
				await hostBeforeHook!(input, output)
				await sandboxBeforeHook!(input, output)
			},
			'tool.execute.after': async (input, output) => {
				const loopName = loopService.resolveLoopName(input.sessionID)
				if (loopName) {
					logger.log(
						`[tool-after] ${input.tool} callID=${input.callID} output=${output.output?.slice(0, 200)}`,
					)
				}
				// Order reverse of before: sandbox → host → existing → archive → delta → harness → graph
				await sandboxAfterHook!(input, output)
				await hostAfterHook!(input, output)
				await toolExecuteAfterHook!(input, output)
				// Tool archive: store large outputs before truncation
				if (toolArchiveAfterHook) await toolArchiveAfterHook(input, output)
				// Delta-read: cache file contents or serve pending diffs
				await deltaReadAfterHook!(input, output)
				await harnessHooks.toolAfter(
					{ sessionID: input.sessionID, tool: input.tool },
					output as { output: string },
				)
				await graphAfterHook!(input, output)
				// Comment checker runs last — inspects final output for AI slop
				commentCheckerHooks.toolAfter(
					{ sessionID: input.sessionID, tool: input.tool },
					output as { output: string },
				)
				budgetHooks.onToolAfter(input, output as { output: string; metadata: unknown })
			},
			'permission.ask': async (input, output) => {
				const loopName = loopService.resolveLoopName(input.sessionID)
				const state = loopName ? loopService.getActiveState(loopName) : null
				if (!state?.active) return

				const patterns = Array.isArray(input.pattern) ? input.pattern : input.pattern ? [input.pattern] : []

				if (patterns.some(p => p.startsWith('git push'))) {
					logger.log(`Loop: denied git push for session ${input.sessionID}`)
					output.status = 'deny'
					return
				}

				logger.log(`Loop: auto-allowing ${input.type} [${patterns.join(', ')}] for session ${input.sessionID}`)
				output.status = 'allow'
			},
			'experimental.session.compacting': async (input, output) => {
				logger.log(`Compacting triggered`)
				const typed = {
					input: input as { sessionID: string },
					output: output as { context: string[]; prompt?: string },
				}
				// Record compaction for quality tracking
				qualityScorer?.recordCompaction(typed.input.sessionID)
				// Harness summary-frame wins when enabled; fall back to legacy custom prompt.
				await harnessHooks.compact(typed.input, typed.output)
				if (!typed.output.prompt) {
					await sessionHooks.onCompacting(typed.input, typed.output)
				}
				// Enrich compaction with checkpoint restore context
				if (checkpointManager && typed.output.prompt) {
					const restoreCtx = checkpointManager.buildRestoreContext(typed.input.sessionID)
					if (restoreCtx) {
						typed.output.prompt = typed.output.prompt + '\n\n' + restoreCtx
						logger.log(`[checkpoints] enriched compaction with checkpoint context`)
					}
				}
			},
			'experimental.chat.messages.transform': async (
				_input: Record<string, never>,
				output: {
					messages: Array<{
						info: { role: string; agent?: string; id?: string }
						parts: Array<Record<string, unknown>>
					}>
				},
			) => {
				const messages = output.messages
				if (messages.length > 0) {
					const sessionId = (messages[0].info as { sessionID?: string }).sessionID
					if (sessionId) {
						harnessHooks.rememberMessages(sessionId, messages)
					}
				}

				// Intent routing hint (advisory, non-blocking)
				intentHooks.onMessagesTransform(output)
				// Session-retry hook: remember last user prompt for potential auto-retry on provider timeout
				sessionRetryHooks.onMessagesTransform(output)
				// User-prompt template injection
				userPromptHooks.onMessagesTransform(output, { directory, projectId })

				let userMessage: (typeof messages)[number] | undefined
				for (let i = messages.length - 1; i >= 0; i--) {
					if (messages[i].info.role === 'user') {
						userMessage = messages[i]
						break
					}
				}

				if (!userMessage) return

				const messagesTransformEnabled = messagesTransformConfig?.enabled ?? true
				if (!messagesTransformEnabled) return

				const isMuse = userMessage.info.agent === agents.muse.displayName
				if (!isMuse) return

				const museInfo = userMessage.info as Record<string, unknown>
				userMessage.parts.push({
					id: crypto.randomUUID(),
					sessionID: (museInfo.sessionID as string) ?? '',
					messageID: (museInfo.id as string) ?? '',
					type: 'text',
					text: `<system-reminder>
You are in READ-ONLY mode for file system operations. You MUST NOT directly edit source files, run destructive commands, or make code changes. You may only read, search, and analyze the codebase.

However, you CAN and SHOULD:
- Use \`plan-write\` to write the plan
- Use \`plan-edit\` to make targeted updates to the plan
- Use \`plan-read\` to review the plan, including by explicit \`loop_name\` when needed
- Use \`plan-execute\` or \`loop\` ONLY AFTER:
  1. The plan has been written via \`plan-write\`
  2. The user explicitly approves via the question tool

Follow the two-step approval flow:
1. After research/design, present findings and next steps, then use the \`question\` tool to ask whether to write the plan
2. Only after the user approves writing the plan, call \`plan-write\` to persist it
3. After the plan is written, present a summary and use the \`question\` tool to collect execution approval with the four canonical options

Never execute a plan without both a written plan and explicit approval via the question tool.
</system-reminder>`,
					synthetic: true,
				})
			},
		} as Hooks & { getCleanup: () => Promise<void> }
	}
}

const plugin: Plugin = async (input: PluginInput): Promise<Hooks> => {
	const config = loadPluginConfig()
	const factory = createForgePlugin(config)
	return factory(input)
}

const pluginModule = {
	id: 'oc-forge',
	server: plugin,
}

export default pluginModule
export type { PluginConfig, CompactionConfig } from './types'
export { VERSION } from './version'
