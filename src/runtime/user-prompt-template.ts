/**
 * User prompt templating — simple template layer for augmenting per-agent
 * prompts with user-defined content.
 *
 * Supports {{variable}} substitution with explicit input fields.
 * No heavy templating engine — intentionally simple and predictable.
 */

import type { Logger } from '../types'

export interface TemplateContext {
	/** Current working directory. */
	cwd: string
	/** Project ID. */
	projectId: string
	/** Agent display name. */
	agentName: string
	/** Current session ID. */
	sessionId?: string
	/** Current date/time in ISO format. */
	datetime: string
	/** Any custom key/value pairs. */
	[key: string]: string | undefined
}

/** Built-in variables that are always available. */
const BUILTIN_VARS = new Set(['cwd', 'projectId', 'agentName', 'sessionId', 'datetime'])

export class UserPromptTemplate {
	private logger: Logger

	constructor(logger: Logger) {
		this.logger = logger
	}

	/**
	 * Render a template string by replacing {{variable}} placeholders
	 * with values from the context.
	 *
	 * Unknown variables are left as-is with a warning logged.
	 */
	render(template: string, context: TemplateContext): string {
		if (!template || !template.includes('{{')) {
			return template
		}

		return template.replace(/\{\{(\w+)\}\}/g, (_match, varName: string) => {
			const value = context[varName]
			if (value !== undefined) {
				return value
			}

			this.logger.debug(`[user-prompt-template] unknown variable: {{${varName}}}`)
			return `{{${varName}}}`
		})
	}

	/**
	 * Build the default template context from runtime values.
	 */
	buildContext(params: {
		cwd: string
		projectId: string
		agentName: string
		sessionId?: string
		extra?: Record<string, string>
	}): TemplateContext {
		return {
			cwd: params.cwd,
			projectId: params.projectId,
			agentName: params.agentName,
			sessionId: params.sessionId,
			datetime: new Date().toISOString(),
			...params.extra,
		}
	}

	/**
	 * Extract all variable names used in a template string.
	 */
	extractVariables(template: string): string[] {
		const vars = new Set<string>()
		const regex = /\{\{(\w+)\}\}/g
		let match: RegExpExecArray | null
		while ((match = regex.exec(template)) !== null) {
			vars.add(match[1]!)
		}
		return [...vars]
	}

	/**
	 * Validate a template string — returns warnings for unknown variables.
	 */
	validate(template: string, knownExtra?: string[]): string[] {
		const warnings: string[] = []
		const vars = this.extractVariables(template)
		const known = new Set([...BUILTIN_VARS, ...(knownExtra ?? [])])

		for (const v of vars) {
			if (!known.has(v)) {
				warnings.push(`Unknown template variable: {{${v}}}`)
			}
		}

		return warnings
	}
}
