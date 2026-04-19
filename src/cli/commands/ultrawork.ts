/**
 * CLI: `oc-forgecode ultrawork` — autonomous multi-step coding pipeline.
 *
 * Ultrawork mode orchestrates: Intent → Plan → Execute → Audit → Report.
 * Uses the slash command template for the pipeline definition.
 *
 * Usage:
 *   oc-forgecode ultrawork "add pagination to the users API"
 *   oc-forgecode ultrawork --plan-only "refactor auth module"
 */

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

interface UltraworkOptions {
	planOnly?: boolean
	maxSteps?: number
	autoApprove?: boolean
}

export function loadTemplate(): string {
	const templatePath = join(__dirname, '..', '..', 'command', 'template', 'ultrawork.txt')
	return readFileSync(templatePath, 'utf-8')
}

export function parseArgs(args: string[]): { task: string; options: UltraworkOptions } {
	const options: UltraworkOptions = {
		planOnly: false,
		maxSteps: 50,
		autoApprove: true,
	}

	const positional: string[] = []

	for (const arg of args) {
		if (arg === '--plan-only') {
			options.planOnly = true
		} else if (arg === '--no-auto-approve') {
			options.autoApprove = false
		} else if (arg.startsWith('--max-steps=')) {
			options.maxSteps = parseInt(arg.split('=')[1]!, 10) || 50
		} else if (!arg.startsWith('-')) {
			positional.push(arg)
		}
	}

	return {
		task: positional.join(' '),
		options,
	}
}

export function buildPrompt(task: string, options: UltraworkOptions): string {
	const template = loadTemplate()
	let prompt = template.replace('$ARGUMENTS', task)

	if (options.planOnly) {
		prompt += '\n\n**MODE: PLAN ONLY** — Stop after Stage 2 (Strategic Plan). Do not execute changes.'
	}

	if (!options.autoApprove) {
		prompt += '\n\n**MODE: MANUAL APPROVAL** — Ask for user confirmation before each task in Stage 3.'
	}

	if (options.maxSteps) {
		prompt += `\n\n**MAX STEPS**: ${options.maxSteps}`
	}

	return prompt
}

export async function cli(args: string[]): Promise<void> {
	const { task, options } = parseArgs(args)

	if (!task) {
		console.log(`Usage: oc-forgecode ultrawork <task description>

Options:
  --plan-only         Stop after creating the plan (no execution)
  --no-auto-approve   Ask for confirmation before each task
  --max-steps=<n>     Maximum pipeline steps (default: 50)

Examples:
  oc-forgecode ultrawork "add pagination to the users API"
  oc-forgecode ultrawork --plan-only "refactor the auth module"
  oc-forgecode ultrawork --no-auto-approve "migrate to new ORM"
`)
		return
	}

	const prompt = buildPrompt(task, options)

	// The prompt is emitted for the calling agent loop to consume.
	// In a real execution context, this is passed to the agent as a slash command.
	console.log(`🔥 Ultrawork mode activated`)
	console.log(`   Task: ${task}`)
	console.log(`   Auto-approve: ${options.autoApprove ? 'yes' : 'no'}`)
	console.log(`   Plan-only: ${options.planOnly ? 'yes' : 'no'}`)
	console.log(`   Max steps: ${options.maxSteps}`)
	console.log('')
	console.log('Pipeline: Intent Gate → Strategic Plan → Execute → Audit → Report')
	console.log('─'.repeat(60))

	// In the plugin context, the prompt is passed to the agent loop.
	// For CLI standalone invocation, write the assembled prompt to stdout for piping.
	if (process.env.FORGE_ULTRAWORK_EMIT_PROMPT === '1') {
		process.stdout.write(prompt)
	}
}

/**
 * Programmatic entry — for use by the agent loop or harness.
 * Returns the assembled ultrawork prompt for injection into the conversation.
 */
export function createUltraworkPrompt(task: string, opts: Partial<UltraworkOptions> = {}): string {
	return buildPrompt(task, {
		planOnly: opts.planOnly ?? false,
		maxSteps: opts.maxSteps ?? 50,
		autoApprove: opts.autoApprove ?? true,
	})
}
