interface PromptResponsePart {
	type: string
	text?: string
}

interface SessionMessage {
	info: { role: string }
	parts: PromptResponsePart[]
}

export function buildCustomCompactionPrompt(): string {
	return `You are generating a continuation context for a very long coding session. Your summary will be the ONLY context after compaction — the agent will have ZERO memory of anything you omit.
Preserve everything needed for seamless continuation across potentially hours of additional work.

## CRITICAL - Preserve These Verbatim
1. The current task/objective (quote the user's original request exactly)
2. ALL file paths being actively worked on (with what's being done to each)
3. Key decisions made and their rationale (WHY, not just WHAT)
4. Any corrections, gotchas, or edge cases discovered during the session
5. Todo list state (what's done, in progress, pending — with IDs if available)
6. User preferences expressed during the session (coding style, naming, etc.)
7. Error patterns encountered and how they were resolved
8. External context: API endpoints, schema shapes, library versions mentioned

## Structure Your Summary As:

### Active Task
[Verbatim objective + what was happening when compaction fired]

### Session History (Condensed)
[Chronological list of major steps completed, 1-2 lines each]

### Key Context
[Decisions, constraints, user preferences, corrections, discovered patterns]

### Active Files
[filepath -> what's being done to it, current state]

### Errors & Resolutions
[Any error patterns and how they were fixed — prevents re-discovery]

### External Dependencies
[API schemas, library versions, endpoint URLs, auth patterns]

### Next Steps
[What should happen immediately after compaction, in priority order]

## Rules
- Use specific file paths, line numbers where available
- State what tools returned, not just that they were called
- Prefer completeness over brevity — this is the agent's ENTIRE working memory
- If a file was modified, note WHAT changed (not just "was edited")
- Preserve enough context that another agent could continue the work cold
- Include any test commands, build commands, or verification steps that were used`
}

export function formatCompactionDiagnostics(stats: {
	conventions: number
	decisions: number
	tokensInjected: number
}): string {
	const parts: string[] = []

	if (stats.conventions > 0) {
		parts.push(`${stats.conventions} convention${stats.conventions !== 1 ? 's' : ''}`)
	}

	if (stats.decisions > 0) {
		parts.push(`${stats.decisions} decision${stats.decisions !== 1 ? 's' : ''}`)
	}

	if (parts.length === 0) return ''

	return `> **Compaction preserved:** ${parts.join(', ')} (~${stats.tokensInjected} tokens injected)`
}

export function extractCompactionSummary(messages: SessionMessage[]): string | null {
	const reversed = [...messages].reverse()
	for (const msg of reversed) {
		if (msg.info.role !== 'assistant') continue
		const textParts = msg.parts
			.filter((p): p is PromptResponsePart & { text: string } => p.type === 'text' && typeof p.text === 'string')
			.map(p => p.text)
		if (textParts.length > 0) return textParts.join('\n')
	}
	return null
}

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4)
}

export function trimToTokenBudget(content: string, maxTokens: number, priority: 'high' | 'medium' | 'low'): string {
	const maxChars = maxTokens * 4
	if (content.length <= maxChars) return content

	if (priority === 'low') {
		return content.slice(0, maxChars) + '...'
	}

	const lines = content.split('\n')
	const trimmed: string[] = []

	let currentChars = 0
	const skipFromEnd = priority === 'medium' ? Math.floor(lines.length * 0.2) : 0

	const linesToUse = skipFromEnd > 0 ? lines.slice(0, -skipFromEnd) : lines

	for (const line of linesToUse) {
		if (currentChars + line.length + 1 > maxChars) break
		trimmed.push(line)
		currentChars += line.length + 1
	}

	if (trimmed.length < linesToUse.length) {
		trimmed.push('...')
	}

	return trimmed.join('\n')
}
