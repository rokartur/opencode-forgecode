/**
 * Port of the forgecode summary transformers.
 *
 * Operates on arrays of `ForgeMessage` (already converted from the opencode
 * payload) and mutates them in place so they can be fed into the
 * `summary-frame` template.
 *
 * Pipeline (matches `forge_app::transformers::SummaryTransformer`):
 *   1. drop(System)
 *   2. dedupeConsecutive(User)
 *   3. trimAssistant (one operation per resource)
 *   4. dedupeConsecutive(Assistant)
 *   5. stripWorkingDir
 */

import { sep } from 'node:path'

import type { ForgeMessage, ForgeMessageContent, ForgeToolCall, Role } from './types'

/**
 * Drops every message with the given role.
 * Mirrors `DropRole` from forgecode.
 */
export function dropRole(messages: ForgeMessage[], role: Role): ForgeMessage[] {
	return messages.filter(m => m.role !== role)
}

/**
 * Keeps only the first message in any consecutive run of the given role, and
 * within that message keeps only the first content entry.
 *
 * Mirrors `DedupeRole` from forgecode (`contents.drain(1..)`).
 */
export function dedupeConsecutive(messages: ForgeMessage[], role: Role): ForgeMessage[] {
	const out: ForgeMessage[] = []
	let last: Role | null = null
	for (const msg of messages) {
		if (msg.role === role) {
			if (last !== role) {
				out.push({ ...msg, contents: msg.contents.slice(0, 1) })
			}
			// else: drop
		} else {
			out.push(msg)
		}
		last = msg.role
	}
	return out
}

type Operation =
	| { kind: 'file'; path: string }
	| { kind: 'shell'; command: string }
	| { kind: 'search'; pattern: string }
	| { kind: 'sem_search'; queries: string }
	| { kind: 'skill'; name: string }
	| { kind: 'mcp'; name: string }
	| { kind: 'todo' }

function operationOf(call: ForgeToolCall): Operation | null {
	const t = call.tool
	if (t.file_read) return { kind: 'file', path: t.file_read.path }
	if (t.file_update) return { kind: 'file', path: t.file_update.path }
	if (t.file_remove) return { kind: 'file', path: t.file_remove.path }
	if (t.shell) return { kind: 'shell', command: t.shell.command }
	if (t.search) return { kind: 'search', pattern: t.search.pattern }
	if (t.sem_search)
		return {
			kind: 'sem_search',
			queries: t.sem_search.queries.map(q => q.use_case).join('|'),
		}
	if (t.skill) return { kind: 'skill', name: t.skill.name }
	if (t.mcp) return { kind: 'mcp', name: t.mcp.name }
	if (t.todo_write) return { kind: 'todo' }
	return null
}

function opEq(a: Operation, b: Operation): boolean {
	if (a.kind !== b.kind) return false
	switch (a.kind) {
		case 'file':
			return a.path === (b as typeof a).path
		case 'shell':
			return a.command === (b as typeof a).command
		case 'search':
			return a.pattern === (b as typeof a).pattern
		case 'sem_search':
			return a.queries === (b as typeof a).queries
		case 'skill':
		case 'mcp':
			return a.name === (b as typeof a).name
		case 'todo':
			return false // todos never collapse
	}
}

/**
 * Within each assistant message, keep only the last tool call per
 * (operation-type, resource) pair. Mirrors `TrimContextSummary`.
 */
export function trimAssistant(messages: ForgeMessage[]): ForgeMessage[] {
	return messages.map(msg => {
		if (msg.role !== 'assistant') return msg
		const seen: Array<{ op: Operation; idx: number }> = []
		const keep = new Array<boolean>(msg.contents.length).fill(true)
		for (let i = 0; i < msg.contents.length; i++) {
			const call = msg.contents[i].tool_call
			if (!call) continue
			const op = operationOf(call)
			if (!op) continue
			const prior = seen.find(s => opEq(s.op, op))
			if (prior) {
				keep[prior.idx] = false
				prior.idx = i
			} else {
				seen.push({ op, idx: i })
			}
		}
		return { ...msg, contents: msg.contents.filter((_, i) => keep[i]) }
	})
}

/**
 * Strip the working directory prefix from file paths inside tool calls.
 * Handles both POSIX and Windows paths so summaries remain portable.
 */
export function stripWorkingDir(messages: ForgeMessage[], workingDir: string): ForgeMessage[] {
	const prefixes = [workingDir, workingDir.endsWith(sep) ? workingDir : workingDir + sep]
	const stripOne = (p: string): string => {
		for (const pref of prefixes) {
			if (p.startsWith(pref)) return p.slice(pref.length).replace(/^[\\/]/, '') || '.'
		}
		return p
	}
	const patchCall = (c: ForgeMessageContent): ForgeMessageContent => {
		if (!c.tool_call) return c
		const t = c.tool_call.tool
		const out = structuredClone(c)
		const ot = out.tool_call!.tool
		if (t.file_read) ot.file_read = { path: stripOne(t.file_read.path) }
		if (t.file_update) ot.file_update = { path: stripOne(t.file_update.path) }
		if (t.file_remove) ot.file_remove = { path: stripOne(t.file_remove.path) }
		return out
	}
	return messages.map(m => ({ ...m, contents: m.contents.map(patchCall) }))
}

/**
 * Full transformer pipeline used by the compactor.
 */
export function summaryTransform(messages: ForgeMessage[], workingDir: string): ForgeMessage[] {
	let out = dropRole(messages, 'system')
	out = dedupeConsecutive(out, 'user')
	out = trimAssistant(out)
	out = dedupeConsecutive(out, 'assistant')
	out = stripWorkingDir(out, workingDir)
	return out
}
