/**
 * Dynamic Client Registration (RFC 7591) for MCP OAuth.
 *
 * When connecting to an MCP server that supports DCR, the client can
 * register itself automatically without manual pre-registration.
 *
 * Flow:
 *   1. POST to registration endpoint with client metadata
 *   2. Receive client_id (and optionally client_secret)
 *   3. Use credentials for subsequent OAuth flows
 */

export interface DcrClientMetadata {
	/** Human-readable client name. */
	clientName: string
	/** Redirect URIs for OAuth callbacks. */
	redirectUris: string[]
	/** Grant types requested (default: ['authorization_code']). */
	grantTypes?: string[]
	/** Response types (default: ['code']). */
	responseTypes?: string[]
	/** Token endpoint auth method (default: 'none' for public clients). */
	tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post'
	/** Scopes the client may request. */
	scope?: string
}

export interface DcrRegistrationResponse {
	/** Assigned client ID. */
	clientId: string
	/** Assigned client secret (for confidential clients). */
	clientSecret?: string
	/** When the credentials expire (ISO date or undefined for non-expiring). */
	clientIdIssuedAt?: number
	clientSecretExpiresAt?: number
	/** Echoed metadata. */
	clientName?: string
	redirectUris?: string[]
	grantTypes?: string[]
}

/**
 * Register a client with an MCP server's DCR endpoint (RFC 7591).
 *
 * @param registrationEndpoint - The DCR endpoint URL.
 * @param metadata - Client metadata to register.
 * @param initialAccessToken - Optional bearer token for protected registration endpoints.
 */
export async function registerClient(
	registrationEndpoint: string,
	metadata: DcrClientMetadata,
	initialAccessToken?: string,
): Promise<DcrRegistrationResponse> {
	const body = {
		client_name: metadata.clientName,
		redirect_uris: metadata.redirectUris,
		grant_types: metadata.grantTypes ?? ['authorization_code'],
		response_types: metadata.responseTypes ?? ['code'],
		token_endpoint_auth_method: metadata.tokenEndpointAuthMethod ?? 'none',
		scope: metadata.scope,
	}

	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
	}

	if (initialAccessToken) {
		headers['Authorization'] = `Bearer ${initialAccessToken}`
	}

	const res = await fetch(registrationEndpoint, {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	})

	if (!res.ok) {
		const text = await res.text()
		throw new Error(`DCR registration failed (${res.status}): ${text}`)
	}

	const data = (await res.json()) as Record<string, unknown>

	if (!data.client_id || typeof data.client_id !== 'string') {
		throw new Error('DCR response missing client_id.')
	}

	return {
		clientId: data.client_id,
		clientSecret: typeof data.client_secret === 'string' ? data.client_secret : undefined,
		clientIdIssuedAt: typeof data.client_id_issued_at === 'number' ? data.client_id_issued_at : undefined,
		clientSecretExpiresAt:
			typeof data.client_secret_expires_at === 'number' ? data.client_secret_expires_at : undefined,
		clientName: typeof data.client_name === 'string' ? data.client_name : undefined,
		redirectUris: Array.isArray(data.redirect_uris) ? data.redirect_uris : undefined,
		grantTypes: Array.isArray(data.grant_types) ? data.grant_types : undefined,
	}
}
