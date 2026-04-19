/**
 * Skill loader — discovers, parses, and injects workflow instructions
 * from local project/user/global scopes.
 *
 * Skills are markdown files with optional YAML frontmatter that define
 * reusable instructions, workflows, or conventions that get injected
 * into agent prompts at runtime.
 *
 * Discovery order (higher priority wins):
 * 1. Project scope: .opencode/skills/*.md
 * 2. User scope: ~/.config/opencode/skills/*.md
 * 3. Global scope: explicit paths from config.skills.scopes[]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import type { Logger, SkillsConfig } from '../types'

export interface SkillFrontmatter {
	/** Skill name (defaults to filename without extension). */
	name?: string
	/** Description of what this skill does. */
	description?: string
	/** Priority for ordering (higher = injected first). Default: 0 */
	priority?: number
	/** Agent filter — only inject for these agents. Empty = all agents. */
	agents?: string[]
	/** Glob patterns — only inject when these files are touched. Empty = always. */
	globs?: string[]
	/** Whether this skill is enabled. Default: true */
	enabled?: boolean
}

export interface LoadedSkill {
	/** Resolved name of the skill. */
	name: string
	/** Source file path. */
	path: string
	/** Source scope. */
	scope: 'project' | 'user' | 'global'
	/** Parsed frontmatter. */
	meta: SkillFrontmatter
	/** Skill instruction body (without frontmatter). */
	body: string
}

export class SkillLoader {
	private logger: Logger
	private config: SkillsConfig
	private directory: string
	private skills: LoadedSkill[] = []
	private loaded = false

	constructor(logger: Logger, directory: string, config?: SkillsConfig) {
		this.logger = logger
		this.directory = directory
		this.config = config ?? { enabled: false }
	}

	/**
	 * Whether skill loading is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled ?? false
	}

	/**
	 * Discover and load all skills from all scopes.
	 */
	load(): LoadedSkill[] {
		if (!this.isEnabled()) return []
		if (this.loaded) return this.skills

		const registry = new Map<string, LoadedSkill>()

		// 3. Global scope (lowest priority, loaded first so project can override)
		for (const scopePath of this.config.scopes ?? []) {
			this.loadFromDir(scopePath, 'global', registry)
		}

		// 2. User scope
		const userSkillsDir = join(homedir(), '.config', 'opencode', 'skills')
		this.loadFromDir(userSkillsDir, 'user', registry)

		// 1. Project scope (highest priority, overrides others)
		const projectSkillsDir = join(this.directory, '.opencode', 'skills')
		this.loadFromDir(projectSkillsDir, 'project', registry)

		this.skills = [...registry.values()]
			.filter(s => s.meta.enabled !== false)
			.sort((a, b) => (b.meta.priority ?? 0) - (a.meta.priority ?? 0))

		this.loaded = true
		this.logger.log(`[skills] loaded ${this.skills.length} skill(s) from ${registry.size} discovered`)
		return this.skills
	}

	/**
	 * Get skills applicable for a specific agent and optionally filtered by touched files.
	 */
	getForAgent(agentName: string, touchedFiles?: string[]): LoadedSkill[] {
		const all = this.load()

		return all.filter(skill => {
			// Agent filter
			if (skill.meta.agents?.length && !skill.meta.agents.includes(agentName)) {
				return false
			}

			// Glob filter
			if (skill.meta.globs?.length && touchedFiles) {
				const hasMatch = skill.meta.globs.some(glob => {
					const regex = globToRegex(glob)
					return touchedFiles.some(f => regex.test(f))
				})
				if (!hasMatch) return false
			}

			return true
		})
	}

	/**
	 * Format skills for injection into a prompt.
	 */
	formatForPrompt(skills: LoadedSkill[]): string {
		if (skills.length === 0) return ''

		const sections = skills.map(skill => {
			const header = skill.meta.description
				? `## ${skill.name}\n_${skill.meta.description}_\n`
				: `## ${skill.name}\n`
			return `${header}\n${skill.body}`
		})

		return `<skills>\n${sections.join('\n\n---\n\n')}\n</skills>`
	}

	/**
	 * Reload skills from disk.
	 */
	reload(): LoadedSkill[] {
		this.loaded = false
		this.skills = []
		return this.load()
	}

	private loadFromDir(dir: string, scope: LoadedSkill['scope'], registry: Map<string, LoadedSkill>): void {
		if (!existsSync(dir)) return

		try {
			const entries = readdirSync(dir)
				.filter(f => f.endsWith('.md'))
				.sort()

			for (const entry of entries) {
				const filePath = join(dir, entry)
				try {
					if (!statSync(filePath).isFile()) continue
					const content = readFileSync(filePath, 'utf-8')
					const { frontmatter, body } = parseFrontmatter(content)
					const name = frontmatter.name ?? basename(entry, '.md')

					// Project scope overrides user scope overrides global scope
					registry.set(name, {
						name,
						path: filePath,
						scope,
						meta: frontmatter,
						body: body.trim(),
					})
				} catch (err) {
					this.logger.debug(`[skills] failed to load ${filePath}`, err)
				}
			}
		} catch (err) {
			this.logger.debug(`[skills] failed to read directory ${dir}`, err)
		}
	}
}

/**
 * Parse YAML-like frontmatter from a markdown file.
 * Handles basic key: value pairs and arrays.
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
	const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
	if (!match) {
		return { frontmatter: {}, body: content }
	}

	const yamlBlock = match[1]!
	const body = match[2]!
	const frontmatter: SkillFrontmatter = {}

	for (const line of yamlBlock.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed || trimmed.startsWith('#')) continue

		const colonIndex = trimmed.indexOf(':')
		if (colonIndex <= 0) continue

		const key = trimmed.slice(0, colonIndex).trim()
		const value = trimmed.slice(colonIndex + 1).trim()

		switch (key) {
			case 'name':
				frontmatter.name = unquote(value)
				break
			case 'description':
				frontmatter.description = unquote(value)
				break
			case 'priority':
				frontmatter.priority = parseInt(value, 10) || 0
				break
			case 'enabled':
				frontmatter.enabled = value === 'true'
				break
			case 'agents':
				frontmatter.agents = parseYamlArray(value)
				break
			case 'globs':
				frontmatter.globs = parseYamlArray(value)
				break
		}
	}

	return { frontmatter, body }
}

function parseYamlArray(value: string): string[] {
	// Handle inline array: [a, b, c]
	const inlineMatch = value.match(/^\[(.+)\]$/)
	if (inlineMatch) {
		return inlineMatch[1]!
			.split(',')
			.map(s => unquote(s.trim()))
			.filter(Boolean)
	}
	// Single value
	if (value) return [unquote(value)]
	return []
}

function unquote(s: string): string {
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		return s.slice(1, -1)
	}
	return s
}

function globToRegex(glob: string): RegExp {
	let pattern = glob
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*/g, '<<<GLOBSTAR>>>')
		.replace(/\*/g, '[^/]*')
		.replace(/<<<GLOBSTAR>>>/g, '.*')
	return new RegExp(`^${pattern}$`)
}
