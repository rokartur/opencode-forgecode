/**
 * Comment Checker — detects and flags AI-generated "slop" in code comments.
 *
 * Scans code output from write/edit/patch tools for common low-quality
 * AI comment patterns: filler phrases, redundant narration, over-explanation
 * of obvious code, and marketing-style language that adds no value.
 *
 * Operates purely on heuristics — no LLM calls.
 */

import type { Logger } from '../types'

export interface CommentCheckerConfig {
	/** Enable the comment checker. Default: true. */
	enabled?: boolean
	/** Minimum number of violations to trigger a warning. Default: 2. */
	minViolations?: number
	/** Severity: 'warn' emits advisory, 'block' rejects the output. Default: 'warn'. */
	severity?: 'warn' | 'block'
}

export interface CommentViolation {
	/** The matched line (trimmed). */
	line: string
	/** Which pattern category matched. */
	category: string
	/** Human-readable explanation. */
	reason: string
}

export interface CheckResult {
	violations: CommentViolation[]
	/** Pre-formatted warning text (empty when no violations). */
	warning: string
}

interface SlopPattern {
	category: string
	reason: string
	pattern: RegExp
}

/**
 * Patterns that indicate low-quality AI-generated comments.
 * Each pattern is tested against individual comment lines (after stripping
 * the comment prefix).
 */
const SLOP_PATTERNS: SlopPattern[] = [
	// --- Filler / narration ---
	{
		category: 'narration',
		reason: 'Narrates what the code does instead of explaining why',
		pattern: /^(?:this|the following|here we|now we|first,? we|next,? we|then we|finally,? we)\b/i,
	},
	{
		category: 'narration',
		reason: 'States the obvious — the code already says this',
		pattern: /^(?:set|get|return|create|initialize|define|declare|assign|call|invoke|import)\s+(?:the|a|an)\b/i,
	},
	{
		category: 'narration',
		reason: 'Self-referential comment about the code itself',
		pattern: /^(?:the (?:above|below|following) (?:code|function|method|class|block|snippet))\b/i,
	},

	// --- Over-explanation ---
	{
		category: 'over-explanation',
		reason: 'Explains language syntax rather than intent',
		pattern:
			/(?:(?:this|it) (?:is|creates|returns|takes|accepts) (?:a|an|the) (?:new |async )?(?:function|method|class|variable|constant|array|object|promise|string|number|boolean))\b/i,
	},
	{
		category: 'over-explanation',
		reason: 'Type annotation in comment duplicates the type system',
		pattern: /^@?(?:type|param|returns?)\s*\{[^}]+\}\s*-?\s*(?:the|a|an)\s/i,
	},

	// --- Marketing / filler phrases ---
	{
		category: 'filler',
		reason: 'Marketing-style filler that adds no technical value',
		pattern:
			/\b(?:robust|elegant|seamless|streamlined|leverage|utilize|facilitate|comprehensive|cutting[- ]edge|best[- ]practice|industry[- ]standard|world[- ]class|enterprise[- ]grade|production[- ]ready|battle[- ]tested)\b/i,
	},
	{
		category: 'filler',
		reason: 'Vague hedge word that weakens the comment',
		pattern: /\b(?:basically|essentially|simply|just|actually|obviously|clearly|of course|needless to say)\b/i,
	},
	{
		category: 'filler',
		reason: 'AI disclaimer or hedging language',
		pattern: /\b(?:as (?:an ai|a language model)|note that|it(?:'s| is) (?:important|worth noting) (?:that|to))\b/i,
	},

	// --- Redundant section headers ---
	{
		category: 'section-noise',
		reason: 'Section divider comment that duplicates code structure',
		pattern: /^[-=─═*]{3,}\s*(?:imports?|exports?|types?|interfaces?|constants?|helpers?|utils?|main)\s*[-=─═*]*$/i,
	},
	{
		category: 'section-noise',
		reason: 'Redundant TODO/FIXME with no actionable content',
		pattern: /^(?:todo|fixme|hack|xxx)(?:\s*:)?\s*$/i,
	},

	// --- Excessive politeness ---
	{
		category: 'politeness',
		reason: 'Conversational tone inappropriate for code comments',
		pattern: /\b(?:please note|feel free|don't hesitate|happy to help|hope this helps|let me know)\b/i,
	},

	// --- Changelog narration ---
	{
		category: 'changelog',
		reason: 'Inline changelog — use git history instead',
		pattern: /^(?:added|removed|changed|updated|fixed|modified|refactored)\s+(?:by|on|in|for|to)\b/i,
	},
	{
		category: 'changelog',
		reason: 'Date-stamped comment — use git blame instead',
		pattern: /^\d{4}[-/]\d{2}[-/]\d{2}\b/,
	},
]

/**
 * Extract comment text from common comment syntaxes.
 * Returns an array of { line, text } where text is the comment body
 * without the comment prefix.
 */
function extractComments(content: string): Array<{ line: string; text: string }> {
	const results: Array<{ line: string; text: string }> = []
	const lines = content.split('\n')

	let inBlock = false

	for (const line of lines) {
		const trimmed = line.trim()

		// Block comment tracking (/* ... */ or /** ... */)
		if (!inBlock && /\/\*/.test(trimmed)) {
			inBlock = true
			const after = trimmed.replace(/^.*?\/\*+\s*/, '')
			if (after && !after.startsWith('*')) {
				results.push({ line: trimmed, text: after.replace(/\*\/\s*$/, '').trim() })
			}
		}
		if (inBlock) {
			if (/\*\//.test(trimmed)) {
				inBlock = false
				const before = trimmed
					.replace(/\*\/.*$/, '')
					.replace(/^\s*\*?\s*/, '')
					.trim()
				if (before) {
					results.push({ line: trimmed, text: before })
				}
			} else {
				const body = trimmed.replace(/^\s*\*?\s*/, '').trim()
				if (body) {
					results.push({ line: trimmed, text: body })
				}
			}
			continue
		}

		// Single-line comments: // or #
		const singleMatch = trimmed.match(/^(?:\/\/|#)\s*(.+)/)
		if (singleMatch) {
			results.push({ line: trimmed, text: singleMatch[1].trim() })
		}
	}

	return results
}

export class CommentChecker {
	private config: Required<CommentCheckerConfig>
	private logger: Logger

	constructor(logger: Logger, config?: CommentCheckerConfig) {
		this.logger = logger
		this.config = {
			enabled: config?.enabled ?? true,
			minViolations: config?.minViolations ?? 2,
			severity: config?.severity ?? 'warn',
		}
	}

	isEnabled(): boolean {
		return this.config.enabled
	}

	/**
	 * Check code content for AI slop comments.
	 */
	check(content: string): CheckResult {
		if (!this.config.enabled) {
			return { violations: [], warning: '' }
		}

		const comments = extractComments(content)
		const violations: CommentViolation[] = []
		const seen = new Set<string>()

		for (const { line, text } of comments) {
			// Skip very short comments (likely legitimate), but keep
			// enough room for "TODO:" and "FIXME" section-noise checks
			if (text.length < 5) continue

			for (const rule of SLOP_PATTERNS) {
				if (rule.pattern.test(text)) {
					// Dedupe by line to avoid double-counting
					const key = `${line}:${rule.category}`
					if (seen.has(key)) continue
					seen.add(key)

					violations.push({
						line: line.length > 120 ? line.slice(0, 120) + '…' : line,
						category: rule.category,
						reason: rule.reason,
					})
					break // One violation per comment line is enough
				}
			}
		}

		let warning = ''
		if (violations.length >= this.config.minViolations) {
			const lines = violations.map(v => `  • [${v.category}] ${v.reason}\n    └─ ${v.line}`)
			warning = [
				`⚠️ Comment Checker: ${violations.length} AI-slop comment(s) detected:`,
				'',
				...lines,
				'',
				'Write comments that explain *why*, not *what*. Remove filler words.',
				'A senior engineer should be able to read this code without cringing.',
			].join('\n')

			this.logger.log(`[comment-checker] ${violations.length} violation(s) found`)
		}

		return { violations, warning }
	}
}
