/**
 * CLI: `oc-forgecode stats` — quick insight into system operation.
 *
 * Reads from the local telemetry database and displays:
 * - Total events by type
 * - Time windows
 * - Success rates
 * - Fallback / undo / loop counts
 */

import { initializeDatabase, closeDatabase, resolveDataDir } from '../../storage'
import { loadPluginConfig } from '../../setup'

interface CliOptions {
	resolvedProjectId?: string
	dir?: string
	dbPath?: string
	json?: boolean
}

export async function cli(args: string[], globalOpts: CliOptions): Promise<void> {
	const code = await run(args, globalOpts)
	if (code !== 0) {
		process.exit(code)
	}
}

export async function run(args: string[], globalOpts: CliOptions = {}): Promise<number> {
	const config = loadPluginConfig()
	const dataDir = globalOpts.dir || config.dataDir || resolveDataDir()
	const json = globalOpts.json || args.includes('--json')

	// Parse time window from args
	let sinceDays = 7
	const daysArg = args.find(a => a.startsWith('--days='))
	if (daysArg) {
		sinceDays = parseInt(daysArg.split('=')[1]!, 10) || 7
	}
	if (args.includes('--today')) sinceDays = 1
	if (args.includes('--week')) sinceDays = 7
	if (args.includes('--month')) sinceDays = 30
	if (args.includes('--all')) sinceDays = 0

	const since = sinceDays > 0 ? Date.now() - sinceDays * 24 * 60 * 60 * 1000 : 0

	let db
	try {
		db = initializeDatabase(dataDir)
	} catch {
		console.error('Failed to open forge database. Run `oc-forgecode doctor` to diagnose.')
		return 1
	}

	try {
		// Check if telemetry table exists
		const tableCheck = db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_events'")
			.get() as { name: string } | undefined

		if (!tableCheck) {
			if (json) {
				console.log(
					JSON.stringify(
						{ window: 'all', total: 0, byType: [], note: 'telemetry disabled or no events recorded' },
						null,
						2,
					),
				)
				return 0
			}
			console.log('No telemetry data found. Enable telemetry in forge-config.jsonc:')
			console.log('  "telemetry": { "enabled": true }')
			return 0
		}

		const whereClause = since > 0 ? 'WHERE timestamp >= ?' : ''
		const params = since > 0 ? [since] : []

		const totalRow = db.prepare(`SELECT COUNT(*) as count FROM telemetry_events ${whereClause}`).get(...params) as {
			count: number
		}

		const typeRows = db
			.prepare(
				`SELECT type, COUNT(*) as count FROM telemetry_events ${whereClause} GROUP BY type ORDER BY count DESC`,
			)
			.all(...params) as Array<{ type: string; count: number }>

		const windowLabel = sinceDays > 0 ? `last ${sinceDays} day(s)` : 'all time'

		const loopRowsAll = db
			.prepare(
				`SELECT data FROM telemetry_events WHERE type = 'loop_outcome' ${since > 0 ? 'AND timestamp >= ?' : ''}`,
			)
			.all(...params) as Array<{ data: string }>
		let loopSuccesses = 0
		let loopFailures = 0
		for (const row of loopRowsAll) {
			try {
				const data = JSON.parse(row.data) as { status?: string }
				if (data.status === 'completed' || data.status === 'success') loopSuccesses++
				else loopFailures++
			} catch {
				// skip malformed
			}
		}
		const loopTotal = loopSuccesses + loopFailures

		const fallbackRow = db
			.prepare(
				`SELECT COUNT(*) as count FROM telemetry_events WHERE type = 'fallback' ${since > 0 ? 'AND timestamp >= ?' : ''}`,
			)
			.get(...params) as { count: number }

		const undoRow = db
			.prepare(
				`SELECT COUNT(*) as count FROM telemetry_events WHERE type = 'undo' ${since > 0 ? 'AND timestamp >= ?' : ''}`,
			)
			.get(...params) as { count: number }

		if (json) {
			console.log(
				JSON.stringify(
					{
						window: sinceDays > 0 ? `${sinceDays}d` : 'all',
						sinceMs: since,
						total: totalRow.count,
						byType: typeRows,
						loop: { successes: loopSuccesses, failures: loopFailures, total: loopTotal },
						fallbacks: fallbackRow.count,
						undos: undoRow.count,
					},
					null,
					2,
				),
			)
			return 0
		}

		console.log(`Forge Stats (${windowLabel})`)
		console.log('')
		console.log(`Total events: ${totalRow.count}`)
		console.log('')

		if (typeRows.length > 0) {
			console.log('Events by type:')
			const maxLabel = Math.max(...typeRows.map(r => r.type.length), 10)
			for (const row of typeRows) {
				console.log(`  ${row.type.padEnd(maxLabel)}  ${row.count}`)
			}
		} else {
			console.log('No events recorded in this window.')
		}

		if (loopTotal > 0) {
			const rate = ((loopSuccesses / loopTotal) * 100).toFixed(1)
			console.log('')
			console.log(`Loop success rate: ${rate}% (${loopSuccesses}/${loopTotal})`)
		}

		if (fallbackRow.count > 0) {
			console.log(`Fallback transitions: ${fallbackRow.count}`)
		}

		if (undoRow.count > 0) {
			console.log(`Undo operations: ${undoRow.count}`)
		}

		console.log('')
		return 0
	} finally {
		closeDatabase(db)
	}
}

export function help(): void {
	console.log(
		`
Show telemetry statistics

Usage:
  oc-forgecode stats [options]

Options:
  --days=<n>   Show stats for the last N days (default: 7)
  --today      Show stats for today only
  --week       Show stats for the last 7 days
  --month      Show stats for the last 30 days
  --all        Show all-time stats
  --json       Emit results as a JSON document

Exit codes:
  0  Success
  1  Database access failed
  `.trim(),
	)
}
