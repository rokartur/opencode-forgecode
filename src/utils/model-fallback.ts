import type { FallbackEntry } from '../types'
import type { SessionRecoveryManager, RecoveryCallbacks } from '../runtime/session-recovery'

export interface ResolvedModelEntry {
	providerID: string
	modelID: string
	model: string
	temperature?: number
	maxTokens?: number
}

export interface ClassifiedModelError {
	kind: 'context_window' | 'timeout' | 'overloaded' | 'provider' | 'unknown'
	message: string
}

interface RetryWithModelFallbackOptions {
	maxRetries?: number
	fallbackModels?: Array<string | FallbackEntry | ResolvedModelEntry>
	onContextWindowError?: () => Promise<boolean> | boolean
	/**
	 * When provided, each per-candidate attempt is wrapped with
	 * `recoveryManager.withRecovery()` — adding automatic timeout backoff,
	 * overload backoff, and context-overflow compaction *within* a single
	 * candidate before the chain moves to the next one.
	 */
	recoveryManager?: SessionRecoveryManager
	/** Session ID passed to `recoveryManager.withRecovery()`. */
	recoverySessionId?: string
	/** Extra callbacks forwarded to `recoveryManager.withRecovery()`. */
	recoveryCallbacks?: RecoveryCallbacks
}

export function parseModelString(modelStr?: string): { providerID: string; modelID: string } | undefined {
	if (!modelStr) return undefined
	const slashIndex = modelStr.indexOf('/')
	if (slashIndex <= 0 || slashIndex === modelStr.length - 1) return undefined
	return {
		providerID: modelStr.substring(0, slashIndex),
		modelID: modelStr.substring(slashIndex + 1),
	}
}

export function resolveFallbackModelEntries(
	entries?: Array<string | FallbackEntry | ResolvedModelEntry>,
): ResolvedModelEntry[] {
	if (!entries?.length) return []

	const resolved: ResolvedModelEntry[] = []
	const seen = new Set<string>()

	for (const entry of entries) {
		const parsed = resolveModelEntry(entry)
		if (!parsed) continue
		if (seen.has(parsed.model)) continue
		seen.add(parsed.model)
		resolved.push(parsed)
	}

	return resolved
}

export function classifyModelError(err: unknown): ClassifiedModelError {
	const message = extractErrorMessage(err).toLowerCase()

	if (
		/context window|context_length|token limit|too many tokens|maximum context|prompt is too long|context exceeded|context length/i.test(
			message,
		)
	) {
		return { kind: 'context_window', message }
	}

	if (/timeout|timed out|deadline exceeded|etimedout|econnreset/i.test(message)) {
		return { kind: 'timeout', message }
	}

	if (/overloaded|rate limit|too many requests|429|529|capacity|unavailable|service unavailable/i.test(message)) {
		return { kind: 'overloaded', message }
	}

	if (/provider|auth|model|api error|forbidden|unauthorized|not found|invalid request|bad request/i.test(message)) {
		return { kind: 'provider', message }
	}

	return { kind: 'unknown', message }
}

export async function retryWithModelFallback<T>(
	callWithModel: (model: ResolvedModelEntry) => Promise<{ data?: T; error?: unknown }>,
	callWithoutModel: () => Promise<{ data?: T; error?: unknown }>,
	model: { providerID: string; modelID: string } | undefined,
	logger: { error: (msg: string, err?: unknown) => void; log: (msg: string) => void },
	optionsOrMaxRetries: number | RetryWithModelFallbackOptions = 2,
): Promise<{ result: { data?: T; error?: unknown }; usedModel: { providerID: string; modelID: string } | undefined }> {
	const options = typeof optionsOrMaxRetries === 'number' ? { maxRetries: optionsOrMaxRetries } : optionsOrMaxRetries
	const maxRetries = options.maxRetries ?? 2
	const primaryModel = model
		? {
				providerID: model.providerID,
				modelID: model.modelID,
				model: `${model.providerID}/${model.modelID}`,
			}
		: undefined
	const fallbackModels = resolveFallbackModelEntries(options.fallbackModels)
	const candidates = primaryModel
		? [primaryModel, ...fallbackModels.filter(entry => entry.model !== primaryModel.model)]
		: fallbackModels

	if (candidates.length === 0) {
		return { result: await callWithoutModel(), usedModel: undefined }
	}

	let lastError: unknown
	let lastReason = 'unknown'

	for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
		const candidate = candidates[candidateIndex]!
		let contextRecoveryApplied = false

		for (let attempt = 1; attempt <= maxRetries; attempt++) {
			// When a recoveryManager is provided, wrap the call so that transient
			// failures (timeout, overload) get automatic backoff *within* the same
			// candidate — before we give up and move to the next one in the chain.
			let result: { data?: T; error?: unknown }
			if (options.recoveryManager) {
				try {
					result = await options.recoveryManager.withRecovery(
						options.recoverySessionId ?? 'unknown',
						candidate.model,
						async () => {
							const r = await callWithModel(candidate)
							if (r.error) {
								// Surface the error so withRecovery can classify and retry
								throw toError(r.error)
							}
							return r
						},
						{
							onContextOverflow: options.onContextWindowError
								? async () => {
										if (contextRecoveryApplied) return false
										contextRecoveryApplied = true
										const recovered = await options.onContextWindowError!()
										return !!recovered
									}
								: undefined,
							onRecoveryEvent: options.recoveryCallbacks?.onRecoveryEvent,
						},
					)
				} catch (recoveryErr) {
					// withRecovery exhausted its internal retries — surface as attempt failure
					result = { error: recoveryErr }
				}
			} else {
				result = await callWithModel(candidate)
			}

			if (!result.error) {
				return {
					result,
					usedModel: {
						providerID: candidate.providerID,
						modelID: candidate.modelID,
					},
				}
			}

			lastError = result.error
			const classified = classifyModelError(result.error)
			lastReason = classified.message || classified.kind

			// When using recoveryManager, context-window recovery is handled inside
			// withRecovery's onContextOverflow callback — skip the legacy path.
			if (
				!options.recoveryManager &&
				classified.kind === 'context_window' &&
				options.onContextWindowError &&
				!contextRecoveryApplied
			) {
				contextRecoveryApplied = true
				logger.log(`[recovery] context-window detected for ${candidate.model}; attempting same-model recovery`)
				try {
					const recovered = await options.onContextWindowError()
					if (recovered) {
						logger.log(`[recovery] same-model recovery prepared for ${candidate.model}; retrying`)
						continue
					}
				} catch (recoveryError) {
					logger.error(`[recovery] same-model recovery failed for ${candidate.model}`, recoveryError)
				}
			}

			if (attempt < maxRetries) {
				logger.log(`model attempt ${attempt}/${maxRetries} failed for ${candidate.model}, retrying`)
			} else {
				logger.log(`model attempt ${attempt}/${maxRetries} failed for ${candidate.model}`)
			}
		}

		const nextCandidate = candidates[candidateIndex + 1]
		if (nextCandidate) {
			logger.log(`[fallback] ${candidate.model} -> ${nextCandidate.model} (reason: ${lastReason})`)
		}
	}

	logger.error(
		`configured model chain unavailable after ${candidates.length} candidate(s), falling back to default`,
		lastError,
	)
	return { result: await callWithoutModel(), usedModel: undefined }
}

function resolveModelEntry(entry: string | FallbackEntry | ResolvedModelEntry): ResolvedModelEntry | undefined {
	if (typeof entry === 'string') {
		const parsed = parseModelString(entry)
		if (!parsed) return undefined
		return {
			...parsed,
			model: entry,
		}
	}

	if ('providerID' in entry && 'modelID' in entry && 'model' in entry) {
		return entry
	}

	const parsed = parseModelString(entry.model)
	if (!parsed) return undefined
	return {
		...parsed,
		model: entry.model,
		temperature: entry.temperature,
		maxTokens: entry.maxTokens,
	}
}

function extractErrorMessage(err: unknown): string {
	if (!err) return 'unknown error'
	if (typeof err === 'string') return err
	if (err instanceof Error) return err.message || err.name
	if (typeof err === 'object') {
		const record = err as Record<string, unknown>
		const nestedData = record['data']
		if (nestedData && typeof nestedData === 'object') {
			const nestedMessage = (nestedData as Record<string, unknown>)['message']
			if (typeof nestedMessage === 'string' && nestedMessage.trim() !== '') {
				return nestedMessage
			}
		}
		const directMessage = record['message']
		if (typeof directMessage === 'string' && directMessage.trim() !== '') {
			return directMessage
		}
		const name = record['name']
		if (typeof name === 'string' && name.trim() !== '') {
			return name
		}
		try {
			return JSON.stringify(err)
		} catch {
			return String(err)
		}
	}
	return String(err)
}

/** Coerce an arbitrary error-like value into an Error for `withRecovery`. */
function toError(err: unknown): Error {
	if (err instanceof Error) return err
	const msg = extractErrorMessage(err)
	const wrapped = new Error(msg)
	;(wrapped as unknown as Record<string, unknown>)['original'] = err
	return wrapped
}
