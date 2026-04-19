import { describe, expect, test } from 'bun:test'
import { AgentBudgetEnforcer } from '../src/runtime/agent-budget'
import { TelemetryCollector } from '../src/runtime/telemetry'
import { createBudgetHooks } from '../src/hooks/budget'
import type { PluginConfig } from '../src/types'

const logger = {
	log: (_msg: string) => {},
	error: (_msg: string, _err?: unknown) => {},
}

describe('agent budget wiring', () => {
	test('budget hook records turns per agent and enforces maxTurns', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn_then_stop')
		const config: PluginConfig = {
			agents: {
				forge: { budget: { maxTurns: 3 } },
			},
		}
		const hooks = createBudgetHooks(enforcer, logger, config)

		// 3 turns should be fine, 4th should be blocked
		hooks.onMessage({ sessionID: 's1', agent: 'forge' })
		hooks.onMessage({ sessionID: 's1', agent: 'forge' })
		const stateBeforeLimit = enforcer.getState('forge:s1')
		expect(stateBeforeLimit.turns).toBe(2)

		hooks.onMessage({ sessionID: 's1', agent: 'forge' })
		const check = enforcer.checkBudget('forge', 's1')
		expect(check.allowed).toBe(false)
		expect(check.violations).toContain('max_turns')
	})

	test('budget hook records tool failures from metadata.is_error', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn_then_stop')
		const config: PluginConfig = {
			agents: {
				forge: { budget: { maxToolFailuresPerTurn: 2 } },
			},
		}
		const hooks = createBudgetHooks(enforcer, logger, config)

		const output = { output: 'some output', metadata: { is_error: true, agent: 'forge' } }
		hooks.onToolAfter({ sessionID: 's1', tool: 'bash' }, output)
		hooks.onToolAfter({ sessionID: 's1', tool: 'bash' }, output)

		const check = enforcer.checkBudget('forge', 's1')
		expect(check.allowed).toBe(false)
		expect(check.violations).toContain('max_tool_failures')
	})

	test('budget hook ignores messages without agent name', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn_then_stop')
		const config: PluginConfig = {
			agents: {
				forge: { budget: { maxTurns: 1 } },
			},
		}
		const hooks = createBudgetHooks(enforcer, logger, config)

		hooks.onMessage({ sessionID: 's1' }) // no agent
		const state = enforcer.getState('forge:s1')
		expect(state.turns).toBe(0)
	})

	test('budget hook emits telemetry on warning threshold', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn')
		const telemetry = new TelemetryCollector(logger, { enabled: true })
		const recorded: Array<{ type: string; data: Record<string, unknown> }> = []
		const originalRecord = telemetry.record.bind(telemetry)
		telemetry.record = event => {
			recorded.push({ type: event.type, data: event.data })
			originalRecord(event)
		}

		const config: PluginConfig = {
			agents: {
				forge: { budget: { maxTurns: 5 } }, // warning at 80% = turn 4
			},
		}
		const hooks = createBudgetHooks(enforcer, logger, config, telemetry, 'proj1')

		// 4 turns → triggers 80% warning
		for (let i = 0; i < 4; i++) {
			hooks.onMessage({ sessionID: 's1', agent: 'forge' })
		}

		expect(recorded.some(r => r.type === 'budget_warning')).toBe(true)
	})

	test('budget hook appends notice to tool output on violation', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn_then_stop')
		const config: PluginConfig = {
			agents: {
				forge: { budget: { maxToolFailuresPerTurn: 1 } },
			},
		}
		const hooks = createBudgetHooks(enforcer, logger, config)

		const output = { output: 'error result', metadata: { is_error: true, agent: 'forge' } }
		hooks.onToolAfter({ sessionID: 's1', tool: 'bash' }, output)

		// After 1 failure, the limit (1) is reached
		expect(output.output).toContain('Budget limit reached')
	})

	test('budget hook persists snapshot to KV when kvService is provided', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn')
		const config: PluginConfig = {
			agents: {
				forge: { budget: { maxTurns: 5 } }, // warning at 80% = turn 4
			},
		}
		const writes: Array<{ projectId: string; key: string; data: unknown }> = []
		const fakeKv = {
			set: (projectId: string, key: string, data: unknown) => {
				writes.push({ projectId, key, data })
			},
			get: () => null,
			delete: () => {},
			list: () => [],
			listByPrefix: () => [],
		}
		const hooks = createBudgetHooks(
			enforcer,
			logger,
			config,
			undefined,
			'proj1',
			fakeKv as unknown as Parameters<typeof createBudgetHooks>[5],
		)

		// Turn 4 of 5 hits warning threshold (0.8 × 5 = 4)
		for (let i = 0; i < 4; i++) {
			hooks.onMessage({ sessionID: 's1', agent: 'forge' })
		}

		expect(writes.length).toBeGreaterThanOrEqual(4)
		const last = writes.at(-1)!
		expect(last.projectId).toBe('proj1')
		expect(last.key).toBe('budget:s1:forge')
		const snap = last.data as {
			agent: string
			sessionId: string
			state: { turns: number }
			warnings: string[]
			budget: { maxTurns?: number } | null
		}
		expect(snap.agent).toBe('forge')
		expect(snap.sessionId).toBe('s1')
		expect(snap.state.turns).toBe(4)
		expect(snap.budget?.maxTurns).toBe(5)
		expect(snap.warnings).toContain('max_turns')
	})

	test('budget hook does not persist snapshot for unbudgeted agent', () => {
		const enforcer = new AgentBudgetEnforcer(logger, 'warn')
		const writes: Array<{ key: string }> = []
		const fakeKv = {
			set: (_projectId: string, key: string) => {
				writes.push({ key })
			},
			get: () => null,
			delete: () => {},
			list: () => [],
			listByPrefix: () => [],
		}
		const hooks = createBudgetHooks(
			enforcer,
			logger,
			{ agents: {} },
			undefined,
			'proj1',
			fakeKv as unknown as Parameters<typeof createBudgetHooks>[5],
		)

		hooks.onMessage({ sessionID: 's1', agent: 'untracked' })
		expect(writes.length).toBe(0)
	})
})
