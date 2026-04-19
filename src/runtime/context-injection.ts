/**
 * Context injection — automatically inject local rules and project context
 * into agent sessions on startup.
 *
 * Sources (in priority order):
 * 1. AGENTS.md (project root)
 * 2. README.md (project root, first N chars)
 * 3. .opencode/context/*.md (project-specific context files)
 * 4. Conditional rules based on file globs
 *
 * Deduplication ensures the same content is not injected twice across
 * session rotations.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import type { ContextInjectionConfig, Logger } from '../types'

/** Maximum total characters to inject to avoid bloating context. */
const MAX_INJECTION_CHARS = 50_000
/** Maximum characters from README.md. */
const MAX_README_CHARS = 4_000

export interface InjectedContext {
	/** Source label for logging/audit. */
	source: string
	/** The injected text content. */
	content: string
}

export interface ContextInjectionResult {
	items: InjectedContext[]
	totalChars: number
	truncated: boolean
}

export class ContextInjector {
	private config: ContextInjectionConfig
	private logger: Logger
	private directory: string
	/** Track injected content hashes to avoid re-injection across session rotations. */
	private injectedHashes = new Set<string>()

	constructor(logger: Logger, directory: string, config?: ContextInjectionConfig) {
		this.logger = logger
		this.directory = directory
		this.config = config ?? { enabled: false }
	}

	/**
	 * Whether context injection is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled ?? false
	}

	/**
	 * Collect all context to inject for a new session.
	 */
	collect(touchedFiles?: string[]): ContextInjectionResult {
		if (!this.isEnabled()) {
			return { items: [], totalChars: 0, truncated: false }
		}

		const items: InjectedContext[] = []
		let totalChars = 0
		let truncated = false

		const addItem = (source: string, content: string): boolean => {
			if (!content.trim()) return false
			const hash = simpleHash(content)
			if (this.injectedHashes.has(hash)) return false

			if (totalChars + content.length > MAX_INJECTION_CHARS) {
				truncated = true
				const remaining = MAX_INJECTION_CHARS - totalChars
				if (remaining > 200) {
					const truncContent = content.slice(0, remaining) + '\n\n[... truncated ...]'
					items.push({ source, content: truncContent })
					totalChars += truncContent.length
					this.injectedHashes.add(hash)
				}
				return false
			}

			items.push({ source, content })
			totalChars += content.length
			this.injectedHashes.add(hash)
			return true
		}

		// 1. AGENTS.md
		const agentsPath = join(this.directory, 'AGENTS.md')
		if (existsSync(agentsPath)) {
			try {
				const content = readFileSync(agentsPath, 'utf-8')
				if (addItem('AGENTS.md', content)) {
					this.logger.log('[context-injection] injected AGENTS.md')
				}
			} catch (err) {
				this.logger.debug('[context-injection] failed to read AGENTS.md', err)
			}
		}

		// 2. README.md (truncated)
		const readmePath = join(this.directory, 'README.md')
		if (existsSync(readmePath)) {
			try {
				const content = readFileSync(readmePath, 'utf-8')
				const truncReadme =
					content.length > MAX_README_CHARS
						? content.slice(0, MAX_README_CHARS) + '\n\n[... README truncated ...]'
						: content
				if (addItem('README.md', truncReadme)) {
					this.logger.log('[context-injection] injected README.md')
				}
			} catch (err) {
				this.logger.debug('[context-injection] failed to read README.md', err)
			}
		}

		// 3. Explicit files from config
		for (const filePath of this.config.files ?? []) {
			const absPath = join(this.directory, filePath)
			if (existsSync(absPath)) {
				try {
					const content = readFileSync(absPath, 'utf-8')
					if (addItem(filePath, content)) {
						this.logger.log(`[context-injection] injected ${filePath}`)
					}
				} catch (err) {
					this.logger.debug(`[context-injection] failed to read ${filePath}`, err)
				}
			}
		}

		// 4. .opencode/context/*.md
		const contextDir = join(this.directory, '.opencode', 'context')
		if (existsSync(contextDir)) {
			try {
				const entries = readdirSync(contextDir)
					.filter(f => f.endsWith('.md'))
					.sort()
				for (const entry of entries) {
					const absPath = join(contextDir, entry)
					if (statSync(absPath).isFile()) {
						try {
							const content = readFileSync(absPath, 'utf-8')
							if (addItem(`.opencode/context/${entry}`, content)) {
								this.logger.log(`[context-injection] injected .opencode/context/${entry}`)
							}
						} catch (err) {
							this.logger.debug(`[context-injection] failed to read .opencode/context/${entry}`, err)
						}
					}
				}
			} catch (err) {
				this.logger.debug('[context-injection] failed to read .opencode/context/', err)
			}
		}

		// 5. Conditional rules based on touched files
		if (touchedFiles && this.config.conditionalRules?.length) {
			for (const rule of this.config.conditionalRules) {
				if (matchesGlob(touchedFiles, rule.glob)) {
					if (addItem(`conditional:${rule.glob}`, rule.instruction)) {
						this.logger.log(`[context-injection] injected conditional rule for glob ${rule.glob}`)
					}
				}
			}
		}

		return { items, totalChars, truncated }
	}

	/**
	 * Format injected context as a single prompt string.
	 */
	format(result: ContextInjectionResult): string {
		if (result.items.length === 0) return ''

		const sections = result.items.map(item => `<context source="${item.source}">\n${item.content}\n</context>`)

		return `<injected-context>\n${sections.join('\n\n')}\n</injected-context>`
	}

	/**
	 * Reset deduplication tracking (e.g. on fresh session).
	 */
	resetDedup(): void {
		this.injectedHashes.clear()
	}
}

/**
 * Simple glob matching for conditional rules.
 * Supports `*` (any chars except /) and `**` (any path).
 */
function matchesGlob(files: string[], glob: string): boolean {
	const regex = globToRegex(glob)
	return files.some(f => regex.test(f))
}

function globToRegex(glob: string): RegExp {
	let pattern = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '<<<GLOBSTAR>>>')
		.replace(/\*/g, '[^/]*')
		.replace(/<<<GLOBSTAR>>>/g, '.*')
	return new RegExp(`^${pattern}$`)
}

function simpleHash(content: string): string {
	let hash = 0
	for (let i = 0; i < content.length; i++) {
		const char = content.charCodeAt(i)
		hash = (hash << 5) - hash + char
		hash |= 0
	}
	return hash.toString(36)
}
