/**
 * Per-agent runtime budget enforcement.
 *
 * Tracks turns, tool failures, requests, and tokens per session for each agent
 * and enforces configurable limits with warning thresholds and stop policies.
 */

import type { AgentBudget, Logger } from '../types'

export type BudgetViolation = 'max_turns' | 'max_tool_failures' | 'max_requests' | 'max_tokens'
export type StopPolicy = 'warn' | 'stop' | 'warn_then_stop'

export interface BudgetState {
	turns: number
	toolFailures: number
	requests: number
	tokensUsed: number
}

export interface BudgetCheckResult {
	allowed: boolean
	violations: BudgetViolation[]
	warnings: BudgetViolation[]
	detail: string
}

/** Default warning threshold as a fraction of the limit. */
const WARNING_THRESHOLD = 0.8

export class AgentBudgetEnforcer {
	private budgets = new Map<string, AgentBudget>()
	private states = new Map<string, BudgetState>()
	private logger: Logger
	private stopPolicy: StopPolicy

	constructor(logger: Logger, stopPolicy: StopPolicy = 'warn_then_stop') {
		this.logger = logger
		this.stopPolicy = stopPolicy
	}

	/**
	 * Register an agent's budget configuration.
	 */
	configure(agentName: string, budget: AgentBudget): void {
		this.budgets.set(agentName, budget)
	}

	/**
	 * Get the current state for an agent in a session.
	 */
	getState(key: string): BudgetState {
		return this.states.get(key) ?? { turns: 0, toolFailures: 0, requests: 0, tokensUsed: 0 }
	}

	/**
	 * Get the state for a specific agent + session pair.
	 */
	getStateFor(agentName: string, sessionId: string): BudgetState {
		return this.getState(budgetKey(agentName, sessionId))
	}

	/**
	 * Get the configured budget for an agent (or null if unconfigured).
	 */
	getBudget(agentName: string): AgentBudget | null {
		return this.budgets.get(agentName) ?? null
	}

	/**
	 * Record a turn for the agent.
	 */
	recordTurn(agentName: string, sessionId: string): BudgetCheckResult {
		const key = budgetKey(agentName, sessionId)
		const state = this.ensureState(key)
		state.turns++
		return this.check(agentName, key, state)
	}

	/**
	 * Record a tool failure.
	 */
	recordToolFailure(agentName: string, sessionId: string): BudgetCheckResult {
		const key = budgetKey(agentName, sessionId)
		const state = this.ensureState(key)
		state.toolFailures++
		return this.check(agentName, key, state)
	}

	/**
	 * Record a request.
	 */
	recordRequest(agentName: string, sessionId: string): BudgetCheckResult {
		const key = budgetKey(agentName, sessionId)
		const state = this.ensureState(key)
		state.requests++
		return this.check(agentName, key, state)
	}

	/**
	 * Record token usage.
	 */
	recordTokens(agentName: string, sessionId: string, tokens: number): BudgetCheckResult {
		const key = budgetKey(agentName, sessionId)
		const state = this.ensureState(key)
		state.tokensUsed += tokens
		return this.check(agentName, key, state)
	}

	/**
	 * Reset budget state for a session (e.g. on session reset / new turn).
	 */
	resetSession(agentName: string, sessionId: string): void {
		this.states.delete(budgetKey(agentName, sessionId))
	}

	/**
	 * Reset per-turn counters (tool failures, requests) while keeping session-level ones.
	 */
	resetTurn(agentName: string, sessionId: string): void {
		const key = budgetKey(agentName, sessionId)
		const state = this.states.get(key)
		if (state) {
			state.toolFailures = 0
			state.requests = 0
		}
	}

	/**
	 * Check budget without recording anything.
	 */
	checkBudget(agentName: string, sessionId: string): BudgetCheckResult {
		const key = budgetKey(agentName, sessionId)
		const state = this.getState(key)
		return this.check(agentName, key, state)
	}

	private ensureState(key: string): BudgetState {
		let state = this.states.get(key)
		if (!state) {
			state = { turns: 0, toolFailures: 0, requests: 0, tokensUsed: 0 }
			this.states.set(key, state)
		}
		return state
	}

	private check(agentName: string, _key: string, state: BudgetState): BudgetCheckResult {
		const budget = this.budgets.get(agentName)
		if (!budget) {
			return { allowed: true, violations: [], warnings: [], detail: 'no budget configured' }
		}

		const violations: BudgetViolation[] = []
		const warnings: BudgetViolation[] = []

		if (budget.maxTurns !== undefined && budget.maxTurns > 0) {
			if (state.turns >= budget.maxTurns) {
				violations.push('max_turns')
			} else if (state.turns >= budget.maxTurns * WARNING_THRESHOLD) {
				warnings.push('max_turns')
			}
		}

		if (budget.maxToolFailuresPerTurn !== undefined && budget.maxToolFailuresPerTurn > 0) {
			if (state.toolFailures >= budget.maxToolFailuresPerTurn) {
				violations.push('max_tool_failures')
			} else if (state.toolFailures >= budget.maxToolFailuresPerTurn * WARNING_THRESHOLD) {
				warnings.push('max_tool_failures')
			}
		}

		if (budget.maxRequestsPerTurn !== undefined && budget.maxRequestsPerTurn > 0) {
			if (state.requests >= budget.maxRequestsPerTurn) {
				violations.push('max_requests')
			} else if (state.requests >= budget.maxRequestsPerTurn * WARNING_THRESHOLD) {
				warnings.push('max_requests')
			}
		}

		if (budget.maxTokensPerSession !== undefined && budget.maxTokensPerSession > 0) {
			if (state.tokensUsed >= budget.maxTokensPerSession) {
				violations.push('max_tokens')
			} else if (state.tokensUsed >= budget.maxTokensPerSession * WARNING_THRESHOLD) {
				warnings.push('max_tokens')
			}
		}

		for (const w of warnings) {
			this.logger.log(`[budget] warning: agent ${agentName} approaching ${w} limit`)
		}

		const allowed = this.resolveAllowed(violations, agentName)
		const detail =
			violations.length > 0
				? `budget exceeded: ${violations.join(', ')}`
				: warnings.length > 0
					? `approaching limits: ${warnings.join(', ')}`
					: 'within budget'

		return { allowed, violations, warnings, detail }
	}

	private resolveAllowed(violations: BudgetViolation[], agentName: string): boolean {
		if (violations.length === 0) return true

		switch (this.stopPolicy) {
			case 'warn':
				this.logger.log(`[budget] agent ${agentName} exceeded budget but policy=warn, continuing`)
				return true
			case 'stop':
				this.logger.log(`[budget] agent ${agentName} exceeded budget, policy=stop, blocking`)
				return false
			case 'warn_then_stop':
				this.logger.log(`[budget] agent ${agentName} exceeded budget, policy=warn_then_stop, blocking`)
				return false
		}
	}
}

function budgetKey(agentName: string, sessionId: string): string {
	return `${agentName}:${sessionId}`
}
