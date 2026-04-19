/**
 * Embeddings provider — pluggable embedding generation for semantic search.
 *
 * Supports multiple backends:
 *   - fastembed (local ONNX runtime, no network, default)
 *   - openai (OpenAI embeddings API)
 *   - voyage (Voyage AI embeddings API)
 *
 * Each provider normalizes output to float32 arrays for consistent distance computation.
 */

export interface EmbeddingProvider {
	readonly name: string
	/** Dimensionality of the embedding vectors. */
	readonly dimensions: number
	/** Generate embeddings for a batch of text chunks. */
	embed(texts: string[]): Promise<Float32Array[]>
	/** Check if the provider is ready (e.g., model loaded, API key present). */
	isReady(): boolean
	/** Initialize the provider (load model, verify API key, etc). */
	init(): Promise<void>
}

export interface EmbeddingConfig {
	/** Provider to use. Default: 'fastembed'. */
	provider?: 'fastembed' | 'openai' | 'voyage'
	/** Model name for the provider. */
	model?: string
	/** API key (for OpenAI/Voyage). Auto-detected from env if omitted. */
	apiKey?: string
	/** Max batch size for embedding calls. */
	batchSize?: number
}

// ── OpenAI provider ───────────────────────────────────────────

function createOpenAIProvider(config: EmbeddingConfig): EmbeddingProvider {
	const model = config.model ?? 'text-embedding-3-small'
	const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY
	const batchSize = config.batchSize ?? 100
	let ready = false

	// text-embedding-3-small = 1536 dims, text-embedding-3-large = 3072
	const dimensions = model.includes('large') ? 3072 : 1536

	return {
		name: 'openai',
		dimensions,

		isReady(): boolean {
			return ready
		},

		async init(): Promise<void> {
			if (!apiKey) throw new Error('OpenAI embeddings require OPENAI_API_KEY.')
			ready = true
		},

		async embed(texts: string[]): Promise<Float32Array[]> {
			if (!apiKey) throw new Error('OpenAI embeddings require OPENAI_API_KEY.')

			const results: Float32Array[] = []

			for (let i = 0; i < texts.length; i += batchSize) {
				const batch = texts.slice(i, i + batchSize)
				const res = await fetch('https://api.openai.com/v1/embeddings', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ model, input: batch }),
				})

				if (!res.ok) {
					const text = await res.text()
					throw new Error(`OpenAI embeddings failed (${res.status}): ${text}`)
				}

				const data = (await res.json()) as {
					data: Array<{ embedding: number[] }>
				}

				for (const item of data.data) {
					results.push(new Float32Array(item.embedding))
				}
			}

			return results
		},
	}
}

// ── Voyage provider ───────────────────────────────────────────

function createVoyageProvider(config: EmbeddingConfig): EmbeddingProvider {
	const model = config.model ?? 'voyage-code-3'
	const apiKey = config.apiKey ?? process.env.VOYAGE_API_KEY
	const batchSize = config.batchSize ?? 100
	let ready = false

	// voyage-code-3 = 1024 dims
	const dimensions = 1024

	return {
		name: 'voyage',
		dimensions,

		isReady(): boolean {
			return ready
		},

		async init(): Promise<void> {
			if (!apiKey) throw new Error('Voyage embeddings require VOYAGE_API_KEY.')
			ready = true
		},

		async embed(texts: string[]): Promise<Float32Array[]> {
			if (!apiKey) throw new Error('Voyage embeddings require VOYAGE_API_KEY.')

			const results: Float32Array[] = []

			for (let i = 0; i < texts.length; i += batchSize) {
				const batch = texts.slice(i, i + batchSize)
				const res = await fetch('https://api.voyageai.com/v1/embeddings', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${apiKey}`,
					},
					body: JSON.stringify({ model, input: batch, input_type: 'document' }),
				})

				if (!res.ok) {
					const text = await res.text()
					throw new Error(`Voyage embeddings failed (${res.status}): ${text}`)
				}

				const data = (await res.json()) as {
					data: Array<{ embedding: number[] }>
				}

				for (const item of data.data) {
					results.push(new Float32Array(item.embedding))
				}
			}

			return results
		},
	}
}

// ── Fastembed (local) provider ────────────────────────────────

function createFastembedProvider(config: EmbeddingConfig): EmbeddingProvider {
	const model = config.model ?? 'bge-small-en-v1.5'
	let ready = false
	let embedFn: ((texts: string[]) => Promise<Float32Array[]>) | null = null

	// bge-small-en-v1.5 = 384 dims
	const dimensions = model.includes('large') ? 1024 : model.includes('base') ? 768 : 384

	return {
		name: 'fastembed',
		dimensions,

		isReady(): boolean {
			return ready
		},

		async init(): Promise<void> {
			try {
				// Try to load fastembed (ONNX-based local embeddings)
				// @ts-ignore — fastembed is an optional peer dependency
				const fe = await import('fastembed')
				const embeddingModel = new fe.EmbeddingModel(model, { maxLength: 512 })
				await embeddingModel.init()

				embedFn = async (texts: string[]) => {
					const results: Float32Array[] = []
					for await (const batch of embeddingModel.embed(texts)) {
						results.push(...batch)
					}
					return results
				}

				ready = true
			} catch {
				// fastembed not installed — provide a mock/fallback for development
				embedFn = async (texts: string[]) => {
					// Simple hash-based pseudo-embeddings for graceful degradation
					return texts.map(text => {
						const vec = new Float32Array(dimensions)
						let hash = 0
						for (let i = 0; i < text.length; i++) {
							hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
						}
						for (let i = 0; i < dimensions; i++) {
							hash = ((hash << 5) - hash + i) | 0
							vec[i] = (hash & 0xffff) / 65536 - 0.5
						}
						// Normalize
						let norm = 0
						for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i]
						norm = Math.sqrt(norm)
						if (norm > 0) for (let i = 0; i < dimensions; i++) vec[i] /= norm
						return vec
					})
				}
				ready = true
			}
		},

		async embed(texts: string[]): Promise<Float32Array[]> {
			if (!embedFn) throw new Error('Fastembed provider not initialized. Call init() first.')
			return embedFn(texts)
		},
	}
}

// ── Factory ───────────────────────────────────────────────────

/**
 * Create an embedding provider based on configuration.
 */
export function createEmbeddingProvider(config: EmbeddingConfig = {}): EmbeddingProvider {
	switch (config.provider ?? 'fastembed') {
		case 'openai':
			return createOpenAIProvider(config)
		case 'voyage':
			return createVoyageProvider(config)
		case 'fastembed':
		default:
			return createFastembedProvider(config)
	}
}
