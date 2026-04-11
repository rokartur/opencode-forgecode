import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'
import { readLoopStates, readLoopByName, shouldPollSidebar, type LoopInfo } from '../src/utils/tui-refresh-helpers'
import type { GraphStatusPayload } from '../src/utils/graph-status-store'

const TEST_DIR = '/tmp/opencode-tui-refresh-test-' + Date.now()

function createTestDb(): { db: Database; dbPath: string } {
  const dbPath = `${TEST_DIR}-${Math.random().toString(36).slice(2)}.db`
  const db = new Database(dbPath)
  db.run(`
    CREATE TABLE IF NOT EXISTS project_kv (
      project_id TEXT NOT NULL,
      key TEXT NOT NULL,
      data TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, key)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_project_kv_expires_at ON project_kv(expires_at)`)
  return { db, dbPath }
}

// Helper to get DB path from test database
function getDbPath(db: Database): string {
  return (db as any).path
}

describe('TUI Refresh Behavior', () => {
  let db: Database
  let dbPath: string
  const projectId = 'test-project'

  beforeEach(() => {
    const result = createTestDb()
    db = result.db
    dbPath = result.dbPath
  })

  afterEach(() => {
    try { db.close() } catch {}
    try { rmSync(dbPath) } catch {}
  })

  describe('readLoopStates', () => {
    test('Returns empty array when database does not exist', () => {
      const states = readLoopStates('non-existent-project')
      expect(states).toEqual([])
    })

    test('Returns loop states from KV store', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      const loopState = {
        worktreeName: 'test-loop',
        sessionId: 'test-session-123',
        phase: 'coding',
        iteration: 1,
        maxIterations: 5,
        active: true,
        startedAt: new Date().toISOString(),
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:test-loop', JSON.stringify(loopState), now + ttl, now, now)

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].name).toBe('test-loop')
      expect(states[0].active).toBe(true)
      expect(states[0].phase).toBe('coding')
    })

    test('Filters out expired loop entries', () => {
      const now = Date.now()
      const expiredTime = now - 1000 // 1 second ago
      const ttl = 7 * 24 * 60 * 60 * 1000
      
      const activeLoop = {
        worktreeName: 'active-loop',
        sessionId: 'session-1',
        phase: 'coding',
        iteration: 1,
        active: true,
      }
      
      const expiredLoop = {
        worktreeName: 'expired-loop',
        sessionId: 'session-2',
        phase: 'coding',
        iteration: 1,
        active: false,
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:active-loop', JSON.stringify(activeLoop), now + ttl, now, now)

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:expired-loop', JSON.stringify(expiredLoop), expiredTime, now - 2000, now - 2000)

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].name).toBe('active-loop')
    })

    test('Sorts active loops before inactive loops', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000

      const inactiveLoop = {
        worktreeName: 'inactive-loop',
        sessionId: 'session-1',
        phase: 'coding',
        iteration: 1,
        active: false,
        completedAt: new Date().toISOString(),
      }
      
      const activeLoop = {
        worktreeName: 'active-loop',
        sessionId: 'session-2',
        phase: 'coding',
        iteration: 1,
        active: true,
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:inactive-loop', JSON.stringify(inactiveLoop), now + ttl, now, now)

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:active-loop', JSON.stringify(activeLoop), now + ttl, now, now)

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(2)
      expect(states[0].name).toBe('active-loop')
      expect(states[0].active).toBe(true)
    })
  })

  describe('readLoopByName', () => {
    test('Returns null when database does not exist', () => {
      const result = readLoopByName('non-existent-project', 'test-loop')
      expect(result).toBeNull()
    })

    test('Returns loop state by name', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      const loopState = {
        worktreeName: 'specific-loop',
        sessionId: 'test-session-456',
        phase: 'auditing',
        iteration: 2,
        maxIterations: 5,
        active: true,
        startedAt: new Date().toISOString(),
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:specific-loop', JSON.stringify(loopState), now + ttl, now, now)

      const result = readLoopByName(projectId, 'specific-loop', dbPath)
      expect(result).toBeDefined()
      expect(result?.name).toBe('specific-loop')
      expect(result?.sessionId).toBe('test-session-456')
      expect(result?.phase).toBe('auditing')
      expect(result?.active).toBe(true)
    })

    test('Returns null when loop does not exist', () => {
      const result = readLoopByName(projectId, 'non-existent-loop', dbPath)
      expect(result).toBeNull()
    })

    test('Returns null for expired loop entries', () => {
      const now = Date.now()
      const expiredTime = now - 1000
      const loopState = {
        worktreeName: 'expired-loop',
        sessionId: 'test-session',
        phase: 'coding',
        iteration: 1,
        active: false,
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:expired-loop', JSON.stringify(loopState), expiredTime, now - 2000, now - 2000)

      const result = readLoopByName(projectId, 'expired-loop', dbPath)
      expect(result).toBeNull()
    })

    test('Returns null when loop state is missing required fields', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      const invalidState = {
        // Missing worktreeName and sessionId
        phase: 'coding',
        iteration: 1,
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:invalid', JSON.stringify(invalidState), now + ttl, now, now)

      const result = readLoopByName(projectId, 'invalid', dbPath)
      expect(result).toBeNull()
    })
  })

  describe('Stale state regression', () => {
    test('Active loops are visible in readLoopStates even if old', () => {
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      const oldTime = now - 10 * 60 * 1000 // 10 minutes ago
      
      const oldActiveLoop = {
        worktreeName: 'old-active-loop',
        sessionId: 'session-old',
        phase: 'coding',
        iteration: 1,
        active: true,
        startedAt: new Date(oldTime).toISOString(),
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:old-active-loop', JSON.stringify(oldActiveLoop), now + ttl, now, now)

      const states = readLoopStates(projectId, dbPath)
      expect(states.length).toBe(1)
      expect(states[0].active).toBe(true)
      expect(states[0].name).toBe('old-active-loop')
    })

    test('Inactive loops are returned by readLoopStates (UI filters by 5 min cutoff)', () => {
      // Note: readLoopStates returns all non-expired loops from KV
      // The 5-minute cutoff filtering happens in the Sidebar UI component
      const now = Date.now()
      const ttl = 7 * 24 * 60 * 60 * 1000
      const oldCutoff = now - 6 * 60 * 1000 // 6 minutes ago (beyond 5 min cutoff)

      const oldInactiveLoop = {
        worktreeName: 'old-inactive-loop',
        sessionId: 'session-old',
        phase: 'coding',
        iteration: 1,
        active: false,
        completedAt: new Date(oldCutoff).toISOString(),
      }

      db.prepare(
        'INSERT INTO project_kv (project_id, key, data, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run(projectId, 'loop:old-inactive-loop', JSON.stringify(oldInactiveLoop), now + ttl, now, now)

      const states = readLoopStates(projectId, dbPath)
      // readLoopStates returns it, but Sidebar would filter it out
      expect(states.length).toBe(1)
      expect(states[0].active).toBe(false)
      
      // Verify the UI filtering logic would exclude it
      const cutoff = now - 5 * 60 * 1000
      const visible = states.filter(l => 
        l.active || (l.completedAt && new Date(l.completedAt).getTime() > cutoff)
      )
      expect(visible.length).toBe(0)
    })
  })

  describe('shouldPollSidebar', () => {
    const createLoop = (overrides: Partial<LoopInfo>): LoopInfo => ({
      name: 'test-loop',
      sessionId: 'test-session',
      phase: 'coding',
      iteration: 1,
      maxIterations: 5,
      active: true,
      worktree: true,
      ...overrides,
    })

    const createGraphStatus = (overrides: Partial<GraphStatusPayload>): GraphStatusPayload => ({
      state: 'ready',
      ready: true,
      updatedAt: Date.now(),
      ...overrides,
    })

    test('should return true when there is an active worktree loop with ready graph status', () => {
      const loops: LoopInfo[] = [createLoop({ active: true, worktree: true })]
      const graphStatus = createGraphStatus({ state: 'ready', ready: true })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(true)
    })

    test('should return true when no active loops but graph status is indexing', () => {
      const loops: LoopInfo[] = [createLoop({ active: false, worktree: true })]
      const graphStatus = createGraphStatus({ state: 'indexing', ready: false })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(true)
    })

    test('should return true when no active loops but graph status is initializing', () => {
      const loops: LoopInfo[] = [createLoop({ active: false, worktree: true })]
      const graphStatus = createGraphStatus({ state: 'initializing', ready: false })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(true)
    })

    test('should return false when no active loops and graph status is ready', () => {
      const loops: LoopInfo[] = [createLoop({ active: false, worktree: true })]
      const graphStatus = createGraphStatus({ state: 'ready', ready: true })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(false)
    })

    test('should return false when no active loops and graph status is unavailable', () => {
      const loops: LoopInfo[] = [createLoop({ active: false, worktree: true })]
      const graphStatus = createGraphStatus({ state: 'unavailable', ready: false })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(false)
    })

    test('should return false when no active loops and graph status is error', () => {
      const loops: LoopInfo[] = [createLoop({ active: false, worktree: true })]
      const graphStatus = createGraphStatus({ state: 'error', ready: false })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(false)
    })

    test('should return false when no active loops and graph status is null', () => {
      const loops: LoopInfo[] = [createLoop({ active: false, worktree: true })]
      expect(shouldPollSidebar(loops, null)).toBe(false)
    })

    test('should return false when there is an active non-worktree loop with ready graph status', () => {
      // Only worktree loops trigger polling, not in-place loops
      const loops: LoopInfo[] = [createLoop({ active: true, worktree: false })]
      const graphStatus = createGraphStatus({ state: 'ready', ready: true })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(false)
    })

    test('should return false when empty loops and ready graph status', () => {
      const loops: LoopInfo[] = []
      const graphStatus = createGraphStatus({ state: 'ready', ready: true })
      expect(shouldPollSidebar(loops, graphStatus)).toBe(false)
    })
  })

  describe('New-repo lifecycle regression', () => {
    const createLoop = (overrides: Partial<LoopInfo>): LoopInfo => ({
      name: 'test-loop',
      sessionId: 'test-session',
      phase: 'coding',
      iteration: 1,
      maxIterations: 5,
      active: false,
      worktree: false,
      ...overrides,
    })

    test('should continue polling through initializing -> indexing -> ready lifecycle', () => {
      // Simulates the new-repo lifecycle where graph status transitions
      // from initializing to indexing to ready, with no active worktree loops
      
      const noActiveLoops: LoopInfo[] = []
      
      // Phase 1: initializing - should poll
      const initializing: GraphStatusPayload = {
        state: 'initializing',
        ready: false,
        updatedAt: Date.now(),
      }
      expect(shouldPollSidebar(noActiveLoops, initializing)).toBe(true)
      
      // Phase 2: indexing - should continue polling
      const indexing: GraphStatusPayload = {
        state: 'indexing',
        ready: false,
        updatedAt: Date.now(),
      }
      expect(shouldPollSidebar(noActiveLoops, indexing)).toBe(true)
      
      // Phase 3: ready - should stop polling
      const ready: GraphStatusPayload = {
        state: 'ready',
        ready: true,
        stats: { files: 10, symbols: 50, edges: 100, calls: 25 },
        updatedAt: Date.now(),
      }
      expect(shouldPollSidebar(noActiveLoops, ready)).toBe(false)
    })

    test('should stop polling for error state without requiring session.status event', () => {
      // Proves that error state is terminal and doesn't require
      // unrelated session.status traffic to stop polling
      const noActiveLoops: LoopInfo[] = []
      const error: GraphStatusPayload = {
        state: 'error',
        ready: false,
        message: 'Worker initialization failed',
        updatedAt: Date.now(),
      }
      expect(shouldPollSidebar(noActiveLoops, error)).toBe(false)
    })

    test('should stop polling for unavailable state without requiring session.status event', () => {
      // Proves that unavailable state is terminal and doesn't require
      // unrelated session.status traffic to stop polling
      const noActiveLoops: LoopInfo[] = []
      const unavailable: GraphStatusPayload = {
        state: 'unavailable',
        ready: false,
        updatedAt: Date.now(),
      }
      expect(shouldPollSidebar(noActiveLoops, unavailable)).toBe(false)
    })
  })
})
