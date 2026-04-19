/**
 * Budget enforcement hooks — wires AgentBudgetEnforcer into the plugin
 * hook lifecycle.
 *
 * - `chat.message` → recordTurn per agent+session
 * - `tool.execute.after` → recordToolFailure when metadata.is_error is truthy
 *
 * When a budget violation fires with policy=stop or warn_then_stop, the
 * hook appends a notice to the tool output so the model sees the budget
 * exhaustion.
 */

import type { AgentBudgetEnforcer, BudgetCheckResult } from '../runtime/agent-budget'
import type { TelemetryCollector } from '../runtime/telemetry'
import type { KvService } from '../services/kv'
import type { AgentBudget, Logger, PluginConfig } from '../types'

export interface BudgetHooks {
	/** Called from chat.message hook. */
	onMessage: (input: { sessionID: string; agent?: string }) => void
	/** Called from tool.execute.after hook. */
	onToolAfter: (input: { sessionID: string; tool: string }, output: { output: string; metadata: unknown }) => void
}

export interface BudgetSnapshot {
	agent: string
	sessionId: string
	state: { turns: number; toolFailures: number; requests: number; tokensUsed: number }
	budget: AgentBudget | null
	warnings: string[]
	violations: string[]
	detail: string
	allowed: boolean
	updatedAt: number
}

export function budgetSnapshotKey(sessionId: string, agent: string): string {
	return `budget:${sessionId}:${agent}`
}

export function createBudgetHooks(
	enforcer: AgentBudgetEnforcer,
	logger: Logger,
	config: PluginConfig,
	telemetry?: TelemetryCollector,
	projectId?: string,
	kvService?: KvService,
): BudgetHooks {
	// Configure per-agent budgets from config
	if (config.agents) {
		for (const [name, agentConfig] of Object.entries(config.agents)) {
			if (agentConfig.budget) {
				enforcer.configure(name, agentConfig.budget)
				logger.log(`[budget] configured limits for agent '${name}': ${JSON.stringify(agentConfig.budget)}`)
			}
		}
	}

	function emitTelemetry(result: BudgetCheckResult, agentName: string, sessionId: string): void {
		if (!telemetry) return

		for (const w of result.warnings) {
			telemetry.record({
				type: 'budget_warning',
				sessionId,
				projectId,
				data: { agent: agentName, violation: w, detail: result.detail },
			})
		}
		for (const v of result.violations) {
			telemetry.record({
				type: 'budget_violation',
				sessionId,
				projectId,
				data: { agent: agentName, violation: v, allowed: result.allowed, detail: result.detail },
			})
		}
	}

	/**
	 * Persist a budget snapshot to the project KV store so the TUI sidebar
	 * can surface live budget indicators. Only called when a budget is
	 * configured for the agent.
	 */
	function writeSnapshot(result: BudgetCheckResult, agentName: string, sessionId: string): void {
		if (!kvService || !projectId) return
		const budget = enforcer.getBudget(agentName)
		if (!budget) return

		const snapshot: BudgetSnapshot = {
			agent: agentName,
			sessionId,
			state: enforcer.getStateFor(agentName, sessionId),
			budget,
			warnings: result.warnings,
			violations: result.violations,
			detail: result.detail,
			allowed: result.allowed,
			updatedAt: Date.now(),
		}

		try {
			kvService.set(projectId, budgetSnapshotKey(sessionId, agentName), snapshot)
		} catch (err) {
			logger.debug('[budget] failed to persist snapshot', err)
		}
	}

	return {
		onMessage(input) {
			const agent = input.agent
			if (!agent) return

			const result = enforcer.recordTurn(agent, input.sessionID)
			emitTelemetry(result, agent, input.sessionID)
			writeSnapshot(result, agent, input.sessionID)

			if (!result.allowed) {
				logger.log(`[budget] agent '${agent}' blocked by budget enforcement: ${result.detail}`)
			}
		},

		onToolAfter(input, output) {
			// Detect tool failure via metadata.is_error (OpenCode convention)
			const meta = output.metadata as Record<string, unknown> | undefined
			if (!meta?.is_error) return

			// We need the agent name. Since tool.execute.after doesn't carry it,
			// we record the failure as a generic session-level counter.
			// The loop service can map sessionID → loopName → agent if needed.
			// For now, use 'unknown' agent — the enforcer still counts per session.
			const agentName = (meta.agent as string) || 'unknown'
			const result = enforcer.recordToolFailure(agentName, input.sessionID)
			emitTelemetry(result, agentName, input.sessionID)
			writeSnapshot(result, agentName, input.sessionID)

			if (!result.allowed) {
				// Append budget notice to tool output so the model sees it
				output.output += `\n\n⚠️ Budget limit reached: ${result.detail}. Further tool calls may be blocked.`
				logger.log(`[budget] tool failure limit reached for session ${input.sessionID}: ${result.detail}`)
			}
		},
	}
}
