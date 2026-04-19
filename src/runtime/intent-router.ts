/**
 * IntentGate — multi-signal intent classification that analyzes true user
 * intent before routing to an agent.
 *
 * Signals used (all heuristic, no LLM calls):
 *   1. Keyword/pattern matching (primary)
 *   2. Complexity estimation (word count, question structure, file refs)
 *   3. Conversational context (question vs command vs mixed)
 *   4. Scope detection (single-file vs multi-file vs architectural)
 *
 * The gate can operate in two modes:
 *   - 'advise' (default): appends a system hint suggesting the right agent
 *   - 'gate': blocks mismatched agent execution with a redirect message
 */

import type { IntentGateConfig, Logger } from '../types'

export type IntentTag = 'research' | 'plan' | 'implement' | 'review' | 'debug' | 'quick-fix' | 'unknown'
export type RoutedAgent = 'forge' | 'muse' | 'sage'

export type ComplexityLevel = 'trivial' | 'simple' | 'moderate' | 'complex' | 'architectural'

export interface IntentClassification {
	tag: IntentTag
	agent: RoutedAgent
	confidence: number
	method: 'heuristic' | 'llm'
	/** Estimated complexity of the request. */
	complexity: ComplexityLevel
	/** Whether the message is a question, command, or mixed. */
	conversationType: 'question' | 'command' | 'mixed'
	/** Scope: how many files/components are likely affected. */
	scope: 'single-file' | 'multi-file' | 'architectural'
	/** All scored tags, not just the winner (for diagnostics). */
	allScores: Array<{ tag: IntentTag; agent: RoutedAgent; score: number }>
}

interface HeuristicRule {
	tag: IntentTag
	agent: RoutedAgent
	patterns: RegExp[]
	/** Weight multiplier when multiple rules match. */
	weight: number
}

const HEURISTIC_RULES: HeuristicRule[] = [
	{
		tag: 'review',
		agent: 'sage',
		weight: 1.2,
		patterns: [
			/\breview\b/i,
			/\baudit\b/i,
			/\bcheck\s+(my\s+)?(code|changes|diff|pr|pull\s*request)\b/i,
			/\bcode\s+review\b/i,
			/\blook\s+(at|over)\s+(my\s+)?(changes|code|diff)\b/i,
			/\bfind\s+(bugs|issues|problems)\b/i,
		],
	},
	{
		tag: 'research',
		agent: 'sage',
		weight: 1.0,
		patterns: [
			/\bresearch\b/i,
			/\bexplain\b/i,
			/\bwhat\s+is\b/i,
			/\bhow\s+does\b/i,
			/\bwhy\s+(does|is|do)\b/i,
			/\bunderstand\b/i,
			/\banalyze\b/i,
			/\binvestigate\b/i,
			/\barchitecture\b/i,
			/\bdesign\s+pattern\b/i,
			/\bcompare\b/i,
		],
	},
	{
		tag: 'plan',
		agent: 'muse',
		weight: 1.1,
		patterns: [
			/\bplan\b/i,
			/\bdesign\b/i,
			/\bstrateg(y|ize)\b/i,
			/\bpropose\b/i,
			/\boutline\b/i,
			/\barchitect\b/i,
			/\bblueprint\b/i,
			/\broad\s*map\b/i,
			/\bbreak\s+(it\s+)?down\b/i,
			/\bsteps?\s+to\b/i,
		],
	},
	{
		tag: 'debug',
		agent: 'forge',
		weight: 1.15,
		patterns: [
			/\bdebug\b/i,
			/\bfix\b/i,
			/\bbug\b/i,
			/\berror\b/i,
			/\bcrash(es|ing)?\b/i,
			/\bfailing\b/i,
			/\bbroken\b/i,
			/\bdoesn'?t\s+work\b/i,
			/\bnot\s+working\b/i,
			/\btroubleshoot\b/i,
			/\bstack\s*trace\b/i,
		],
	},
	{
		tag: 'quick-fix',
		agent: 'forge',
		weight: 1.3,
		patterns: [
			/\btypo\b/i,
			/\brename\b/i,
			/\bdelete\s+(this|that|the)\s+(line|import|variable|function)\b/i,
			/\bremove\s+(unused|dead)\b/i,
			/\bformat(ting)?\b/i,
			/\blint\s*fix\b/i,
			/\bquick\s*fix\b/i,
		],
	},
	{
		tag: 'implement',
		agent: 'forge',
		weight: 1.0,
		patterns: [
			/\bimplement\b/i,
			/\bcreate\b/i,
			/\bbuild\b/i,
			/\badd\b/i,
			/\bwrite\b/i,
			/\brefactor\b/i,
			/\bmodify\b/i,
			/\bupdate\b/i,
			/\bchange\b/i,
			/\bmigrat(e|ion)\b/i,
			/\bsetup\b/i,
			/\bconfigure\b/i,
			/\binstall\b/i,
		],
	},
]

// ────────────────────────────────────────────────────────────
// Complexity signals
// ────────────────────────────────────────────────────────────

const FILE_REF_PATTERN = /(?:@\[.+?\]|[a-zA-Z0-9_/.-]+\.[a-zA-Z]{1,6})/g
const QUESTION_MARKERS = /[?？]|^(?:what|how|why|where|when|which|who|can|could|would|should|is|are|do|does)\b/im
const COMMAND_MARKERS =
	/^(?:add|create|build|write|implement|fix|refactor|remove|delete|rename|update|change|move|install|configure|setup|migrate|deploy)\b/im
const MULTI_FILE_MARKERS =
	/\b(?:across|all\s+files|every\s+file|project[- ]wide|codebase|entire|whole\s+(?:project|repo))\b/i
const ARCH_MARKERS =
	/\b(?:architect|system\s+design|data\s+model|database\s+schema|api\s+design|microservice|monolith|event[- ]driven|message\s+queue)\b/i

function estimateComplexity(message: string): ComplexityLevel {
	const words = message.split(/\s+/).length
	const fileRefs = (message.match(FILE_REF_PATTERN) || []).length
	const hasMultiFile = MULTI_FILE_MARKERS.test(message)
	const hasArch = ARCH_MARKERS.test(message)

	if (hasArch || words > 150) return 'architectural'
	if (hasMultiFile || fileRefs > 3 || words > 80) return 'complex'
	if (fileRefs > 1 || words > 30) return 'moderate'
	if (words > 10) return 'simple'
	return 'trivial'
}

function detectConversationType(message: string): 'question' | 'command' | 'mixed' {
	const isQuestion = QUESTION_MARKERS.test(message)
	const isCommand = COMMAND_MARKERS.test(message)
	if (isQuestion && isCommand) return 'mixed'
	if (isQuestion) return 'question'
	return 'command'
}

function detectScope(message: string): 'single-file' | 'multi-file' | 'architectural' {
	if (ARCH_MARKERS.test(message)) return 'architectural'
	if (MULTI_FILE_MARKERS.test(message)) return 'multi-file'
	const fileRefs = (message.match(FILE_REF_PATTERN) || []).length
	if (fileRefs > 2) return 'multi-file'
	return 'single-file'
}

// ────────────────────────────────────────────────────────────
// Gate decision
// ────────────────────────────────────────────────────────────

export interface GateDecision {
	/** Whether the current agent is appropriate. */
	pass: boolean
	/** Classification result. */
	classification: IntentClassification
	/** Human-readable redirect message (non-empty only when pass=false). */
	redirectMessage: string
}

export class IntentRouter {
	private config: IntentGateConfig
	private logger: Logger

	constructor(logger: Logger, config?: IntentGateConfig) {
		this.logger = logger
		this.config = config ?? { enabled: false, heuristicsOnly: true }
	}

	/**
	 * Whether intent routing is enabled.
	 */
	isEnabled(): boolean {
		return this.config.enabled ?? false
	}

	/**
	 * Full classification with all signals.
	 */
	classify(message: string): IntentClassification {
		if (!this.isEnabled()) {
			return {
				tag: 'unknown',
				agent: 'forge',
				confidence: 0,
				method: 'heuristic',
				complexity: 'simple',
				conversationType: 'command',
				scope: 'single-file',
				allScores: [],
			}
		}

		const result = this.heuristicClassify(message)

		this.logger.log(
			`[intent-gate] classified "${truncate(message, 60)}" → tag=${result.tag} agent=${result.agent} confidence=${result.confidence.toFixed(2)} complexity=${result.complexity} type=${result.conversationType} scope=${result.scope}`,
		)

		return result
	}

	/**
	 * Gate check: given the current agent, decide if the message should pass
	 * or be redirected.
	 */
	gate(message: string, currentAgent: string): GateDecision {
		const classification = this.classify(message)

		// Low confidence → always pass (too ambiguous to redirect)
		if (classification.confidence < 0.5) {
			return { pass: true, classification, redirectMessage: '' }
		}

		// Agent matches → pass
		if (classification.agent === currentAgent) {
			return { pass: true, classification, redirectMessage: '' }
		}

		// Complexity-aware gating: trivial quick-fixes pass through any agent.
		// Review/debug/research/plan tags always redirect even when phrased briefly —
		// a short "review my code" is still a review request.
		if (
			classification.complexity === 'trivial' &&
			(classification.tag === 'quick-fix' || classification.tag === 'unknown')
		) {
			return { pass: true, classification, redirectMessage: '' }
		}

		const redirectMessage = formatRedirectMessage(classification, currentAgent)

		this.logger.log(
			`[intent-gate] mismatch: current=${currentAgent} suggested=${classification.agent} mode=${this.config.mode ?? 'advise'}`,
		)

		return { pass: false, classification, redirectMessage }
	}

	/**
	 * Get the suggested agent for a message without full classification details.
	 */
	suggestAgent(message: string): RoutedAgent {
		return this.classify(message).agent
	}

	private heuristicClassify(message: string): IntentClassification {
		const scores = new Map<IntentTag, { agent: RoutedAgent; score: number }>()

		for (const rule of HEURISTIC_RULES) {
			let matchCount = 0
			for (const pattern of rule.patterns) {
				if (pattern.test(message)) {
					matchCount++
				}
			}
			if (matchCount > 0) {
				const score = matchCount * rule.weight
				const existing = scores.get(rule.tag)
				if (!existing || score > existing.score) {
					scores.set(rule.tag, { agent: rule.agent, score })
				}
			}
		}

		const complexity = estimateComplexity(message)
		const conversationType = detectConversationType(message)
		const scope = detectScope(message)

		const allScores: IntentClassification['allScores'] = []
		for (const [tag, { agent, score }] of scores) {
			allScores.push({ tag, agent, score })
		}
		allScores.sort((a, b) => b.score - a.score)

		if (scores.size === 0) {
			return {
				tag: 'unknown',
				agent: 'forge',
				confidence: 0,
				method: 'heuristic',
				complexity,
				conversationType,
				scope,
				allScores,
			}
		}

		// Find the best match
		let bestTag: IntentTag = 'unknown'
		let bestAgent: RoutedAgent = 'forge'
		let bestScore = 0
		let totalScore = 0

		for (const [tag, { agent, score }] of scores) {
			totalScore += score
			if (score > bestScore) {
				bestScore = score
				bestTag = tag
				bestAgent = agent
			}
		}

		// Boost: questions about architecture → sage even if "plan" scored higher
		if (conversationType === 'question' && scope === 'architectural' && bestAgent !== 'sage') {
			const sageScore = scores.get('research')?.score ?? 0
			if (sageScore > 0 && sageScore >= bestScore * 0.6) {
				bestTag = 'research'
				bestAgent = 'sage'
				bestScore = sageScore
			}
		}

		// Boost: large scope + command → muse for planning first
		if (conversationType === 'command' && scope === 'architectural' && bestTag === 'implement') {
			bestTag = 'plan'
			bestAgent = 'muse'
		}

		// Confidence is the fraction of total score captured by the best match
		const confidence = totalScore > 0 ? bestScore / totalScore : 0

		return {
			tag: bestTag,
			agent: bestAgent,
			confidence,
			method: 'heuristic',
			complexity,
			conversationType,
			scope,
			allScores,
		}
	}
}

const AGENT_DESCRIPTIONS: Record<RoutedAgent, string> = {
	forge: 'implementation and code changes',
	muse: 'strategic planning and scoping',
	sage: 'research, review, and code analysis',
}

function formatRedirectMessage(classification: IntentClassification, currentAgent: string): string {
	const suggestedDesc = AGENT_DESCRIPTIONS[classification.agent] || classification.agent
	return [
		`🚦 IntentGate: This looks like a **${classification.tag}** request (${classification.complexity} complexity, ${classification.scope} scope).`,
		`The **${classification.agent}** agent is better suited for ${suggestedDesc}.`,
		`You're currently using **${currentAgent}**. Consider switching for better results.`,
	].join('\n')
}

function truncate(s: string, maxLen: number): string {
	return s.length > maxLen ? s.slice(0, maxLen) + '...' : s
}
