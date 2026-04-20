import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { BackgroundManager } from '../src/runtime/background/manager'
import { ConcurrencyManager } from '../src/runtime/background/concurrency'
import { createBackgroundTools } from '../src/tools/background'

describe('background tools lite mode', () => {
	let db: Database
	let bgManager: BackgroundManager
	let bgConcurrency: ConcurrencyManager

	beforeEach(() => {
		db = new Database(':memory:')
		bgManager = new BackgroundManager(db as any)
		bgConcurrency = new ConcurrencyManager(bgManager, {
			maxConcurrent: 4,
			perModelLimit: 2,
		})
	})

	afterEach(() => {
		db.close()
	})

	function makeCtx(client: {
		session: {
			create: (...args: any[]) => Promise<any>
			promptAsync: (...args: any[]) => Promise<any>
			status: (...args: any[]) => Promise<any>
			messages: (...args: any[]) => Promise<any>
		}
	}) {
		return {
			directory: '/tmp/opencode-forge-lite-bg-test',
			input: { client },
			v2: {
				session: {
					abort: async () => ({ data: null }),
				},
			},
			logger: {
				log: () => {},
				debug: () => {},
				error: () => {},
			},
			bgSpawner: null,
			bgManager,
			bgConcurrency,
		} as any
	}

	test('bg_spawn uses lite mode when spawner is disabled', async () => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'ses-bg-lite-1' } }),
				promptAsync: async () => ({ data: null }),
				status: async () => ({ data: { 'ses-bg-lite-1': { type: 'running' } } }),
				messages: async () => ({ data: [] }),
			},
		}

		const tools = createBackgroundTools(makeCtx(client))
		const result = await (tools.bg_spawn as any).execute(
			{ agent: 'explore', prompt: 'Research the repo' },
			{ sessionID: 'parent-session-1' },
		)

		expect(result).toContain('Background task spawned (lite mode)')
		expect(result).not.toContain('disabled')

		const task = bgManager.getAll(1)[0]
		expect(task).toBeDefined()
		expect(task.sessionId).toBe('ses-bg-lite-1')
		expect(task.status).toBe('running')
	})

	test('bg_status refreshes lite tasks from session state', async () => {
		const client = {
			session: {
				create: async () => ({ data: { id: 'ses-bg-lite-2' } }),
				promptAsync: async () => ({ data: null }),
				status: async () => ({ data: { 'ses-bg-lite-2': { type: 'idle' } } }),
				messages: async () => ({
					data: [
						{
							info: { role: 'assistant' },
							parts: [{ type: 'text', text: 'Finished background analysis' }],
						},
					],
				}),
			},
		}

		const tools = createBackgroundTools(makeCtx(client))
		await (tools.bg_spawn as any).execute(
			{ agent: 'explore', prompt: 'Research the repo' },
			{ sessionID: 'parent-session-2' },
		)

		const taskId = bgManager.getAll(1)[0].id
		const result = await (tools.bg_status as any).execute({ id: taskId }, { sessionID: 'parent-session-2' })

		expect(result).toContain(taskId)
		expect(result).toContain('[completed]')
		expect(result).toContain('Finished background analysis')
	})
})
