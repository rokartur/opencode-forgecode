/**
 * MCP OAuth 2.0 + PKCE implementation.
 *
 * Implements the OAuth 2.0 Authorization Code flow with PKCE (RFC 7636)
 * for authenticating with MCP servers that require OAuth.
 *
 * Flow:
 *   1. Generate code_verifier (43-128 chars, URL-safe random)
 *   2. Derive code_challenge = base64url(SHA-256(code_verifier))
 *   3. Build authorize URL with challenge
 *   4. User authenticates in browser → redirect with auth code
 *   5. Exchange code + verifier for tokens
 *   6. Auto-refresh on 401 using refresh_token
 */

import { createHash, randomBytes } from 'crypto'

// ── PKCE helpers ──────────────────────────────────────────────

/**
 * Generate a cryptographically random code_verifier (43-128 characters).
 * Uses URL-safe base64 characters per RFC 7636 §4.1.
 */
export function generateCodeVerifier(length = 64): string {
	if (length < 43 || length > 128) {
		throw new Error('PKCE code_verifier must be 43-128 characters.')
	}
	return randomBytes(length).toString('base64url').slice(0, length)
}

/**
 * Derive code_challenge from code_verifier using S256 method.
 * code_challenge = base64url(SHA-256(code_verifier))
 */
export function deriveCodeChallenge(codeVerifier: string): string {
	return createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
}

// ── Types ─────────────────────────────────────────────────────

export interface OAuthServerConfig {
	/** Authorization endpoint URL. */
	authorizeUrl: string
	/** Token endpoint URL. */
	tokenUrl: string
	/** Client ID (from DCR or pre-registered). */
	clientId: string
	/** Client secret (optional, for confidential clients). */
	clientSecret?: string
	/** Redirect URI for the OAuth callback. */
	redirectUri: string
	/** OAuth scopes to request. */
	scopes?: string[]
}

export interface TokenSet {
	accessToken: string
	refreshToken?: string
	expiresAt?: number // Unix timestamp (ms)
	tokenType: string
	scope?: string
}

export interface OAuthClient {
	/** Build the authorization URL for the user to visit. */
	buildAuthorizeUrl(): { url: string; codeVerifier: string; state: string }
	/** Exchange an authorization code for tokens. */
	exchangeCode(code: string, codeVerifier: string): Promise<TokenSet>
	/** Refresh an expired access token using the refresh token. */
	refreshAccessToken(refreshToken: string): Promise<TokenSet>
	/** Check if a token set is expired (or will expire within bufferMs). */
	isExpired(tokens: TokenSet, bufferMs?: number): boolean
}

// ── OAuth Client ──────────────────────────────────────────────

/**
 * Create an OAuth 2.0 + PKCE client for the given server configuration.
 */
export function createOAuthClient(config: OAuthServerConfig): OAuthClient {
	return {
		buildAuthorizeUrl() {
			const codeVerifier = generateCodeVerifier()
			const codeChallenge = deriveCodeChallenge(codeVerifier)
			const state = randomBytes(16).toString('hex')

			const params = new URLSearchParams({
				response_type: 'code',
				client_id: config.clientId,
				redirect_uri: config.redirectUri,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
				state,
			})

			if (config.scopes?.length) {
				params.set('scope', config.scopes.join(' '))
			}

			return {
				url: `${config.authorizeUrl}?${params.toString()}`,
				codeVerifier,
				state,
			}
		},

		async exchangeCode(code: string, codeVerifier: string): Promise<TokenSet> {
			const body: Record<string, string> = {
				grant_type: 'authorization_code',
				code,
				redirect_uri: config.redirectUri,
				client_id: config.clientId,
				code_verifier: codeVerifier,
			}

			if (config.clientSecret) {
				body.client_secret = config.clientSecret
			}

			const res = await fetch(config.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(body).toString(),
			})

			if (!res.ok) {
				const text = await res.text()
				throw new Error(`Token exchange failed (${res.status}): ${text}`)
			}

			return parseTokenResponse(await res.json())
		},

		async refreshAccessToken(refreshToken: string): Promise<TokenSet> {
			const body: Record<string, string> = {
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: config.clientId,
			}

			if (config.clientSecret) {
				body.client_secret = config.clientSecret
			}

			const res = await fetch(config.tokenUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams(body).toString(),
			})

			if (!res.ok) {
				const text = await res.text()
				throw new Error(`Token refresh failed (${res.status}): ${text}`)
			}

			return parseTokenResponse(await res.json())
		},

		isExpired(tokens: TokenSet, bufferMs = 30_000): boolean {
			if (!tokens.expiresAt) return false
			return Date.now() + bufferMs >= tokens.expiresAt
		},
	}
}

// ── Helpers ───────────────────────────────────────────────────

function parseTokenResponse(data: unknown): TokenSet {
	const obj = data as Record<string, unknown>
	const accessToken = String(obj.access_token ?? '')
	if (!accessToken) throw new Error('Token response missing access_token.')

	const expiresIn = typeof obj.expires_in === 'number' ? obj.expires_in : undefined

	return {
		accessToken,
		refreshToken: typeof obj.refresh_token === 'string' ? obj.refresh_token : undefined,
		expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : undefined,
		tokenType: String(obj.token_type ?? 'Bearer'),
		scope: typeof obj.scope === 'string' ? obj.scope : undefined,
	}
}
