/**
 * CLI: `oc-forgecode mcp` — manage MCP server authentication.
 *
 * Subcommands:
 *   auth <server-url>  — Initiate OAuth flow for an MCP server
 *   list               — List servers with stored credentials
 *   remove <server-url> — Remove stored credentials for a server
 */

import { resolveDataDir } from '../../storage'
import { createTokenStore } from '../../runtime/mcp/token-store'
import { createOAuthClient } from '../../runtime/mcp/oauth'
import { registerClient, type DcrClientMetadata } from '../../runtime/mcp/dcr'

interface McpCliOptions {
	dir?: string
}

const REDIRECT_URI = 'http://localhost:19876/callback'

export async function cli(args: string[], globalOpts: McpCliOptions = {}): Promise<void> {
	const subcommand = args[0]

	switch (subcommand) {
		case 'auth':
			return authFlow(args.slice(1), globalOpts)
		case 'list':
			return listServers(globalOpts)
		case 'remove':
			return removeServer(args.slice(1), globalOpts)
		default:
			help()
	}
}

function help(): void {
	console.log(`Usage: oc-forgecode mcp <command>

Commands:
  auth <server-url>     Authenticate with an MCP server (OAuth 2.0 + PKCE)
  list                  List servers with stored credentials
  remove <server-url>   Remove stored credentials for a server

Options:
  --dir <path>          Custom data directory

Examples:
  oc-forgecode mcp auth https://mcp.example.com
  oc-forgecode mcp list
  oc-forgecode mcp remove https://mcp.example.com
`)
}

async function authFlow(args: string[], opts: McpCliOptions): Promise<void> {
	const serverUrl = args[0]
	if (!serverUrl) {
		console.error('Error: server URL is required. Usage: oc-forgecode mcp auth <server-url>')
		process.exit(1)
	}

	const dataDir = opts.dir ?? resolveDataDir()
	const store = createTokenStore(dataDir)

	// Check for existing tokens
	const existing = await store.get(serverUrl)
	if (existing) {
		console.log(`Already authenticated with ${serverUrl}`)
		console.log('Use `oc-forgecode mcp remove` to clear credentials first.')
		return
	}

	console.log(`Discovering OAuth endpoints for ${serverUrl}...`)

	// Try to discover OAuth configuration from well-known endpoint
	const oauthConfig = await discoverOAuthConfig(serverUrl)
	if (!oauthConfig) {
		console.error(`Could not discover OAuth configuration for ${serverUrl}.`)
		console.error('The server may not support OAuth, or the well-known endpoint is not available.')
		process.exit(1)
	}

	// Try Dynamic Client Registration
	let clientId = oauthConfig.clientId
	let clientSecret = oauthConfig.clientSecret

	if (!clientId && oauthConfig.registrationEndpoint) {
		console.log('Performing Dynamic Client Registration (RFC 7591)...')
		try {
			const metadata: DcrClientMetadata = {
				clientName: 'opencode-forge',
				redirectUris: [REDIRECT_URI],
				grantTypes: ['authorization_code'],
				responseTypes: ['code'],
				tokenEndpointAuthMethod: 'none',
			}

			const reg = await registerClient(oauthConfig.registrationEndpoint, metadata)
			clientId = reg.clientId
			clientSecret = reg.clientSecret
			console.log(`Registered as client: ${clientId}`)
		} catch (err) {
			console.error(`DCR failed: ${err instanceof Error ? err.message : String(err)}`)
			process.exit(1)
		}
	}

	if (!clientId) {
		console.error('No client_id available. Set one in your MCP server configuration.')
		process.exit(1)
	}

	const oauthClient = createOAuthClient({
		authorizeUrl: oauthConfig.authorizeUrl,
		tokenUrl: oauthConfig.tokenUrl,
		clientId,
		clientSecret,
		redirectUri: REDIRECT_URI,
		scopes: oauthConfig.scopes,
	})

	const { url, codeVerifier, state } = oauthClient.buildAuthorizeUrl()

	console.log('\nOpen this URL in your browser to authenticate:')
	console.log(`\n  ${url}\n`)
	console.log('Waiting for callback...')

	// Start local HTTP server to receive the callback
	try {
		const code = await waitForCallback(state)
		console.log('Authorization code received. Exchanging for tokens...')

		const tokens = await oauthClient.exchangeCode(code, codeVerifier)
		await store.set(serverUrl, tokens)

		console.log(`\n✓ Authenticated with ${serverUrl}`)
		console.log(`  Token type: ${tokens.tokenType}`)
		if (tokens.expiresAt) {
			console.log(`  Expires: ${new Date(tokens.expiresAt).toISOString()}`)
		}
		if (tokens.refreshToken) {
			console.log('  Refresh token: stored')
		}
	} catch (err) {
		console.error(`\nAuthentication failed: ${err instanceof Error ? err.message : String(err)}`)
		process.exit(1)
	}
}

async function listServers(opts: McpCliOptions): Promise<void> {
	const dataDir = opts.dir ?? resolveDataDir()
	const store = createTokenStore(dataDir)

	const servers = await store.list()
	if (servers.length === 0) {
		console.log('No MCP servers configured.')
		return
	}

	console.log('Authenticated MCP servers:')
	console.log(`  Backend: ${store.backend}\n`)
	for (const url of servers) {
		const tokens = await store.get(url)
		const expired = tokens?.expiresAt ? Date.now() > tokens.expiresAt : false
		const status = expired ? ' (expired)' : ''
		console.log(`  ${url}${status}`)
	}
}

async function removeServer(args: string[], opts: McpCliOptions): Promise<void> {
	const serverUrl = args[0]
	if (!serverUrl) {
		console.error('Error: server URL is required. Usage: oc-forgecode mcp remove <server-url>')
		process.exit(1)
	}

	const dataDir = opts.dir ?? resolveDataDir()
	const store = createTokenStore(dataDir)

	const existing = await store.get(serverUrl)
	if (!existing) {
		console.log(`No credentials found for ${serverUrl}`)
		return
	}

	await store.remove(serverUrl)
	console.log(`✓ Removed credentials for ${serverUrl}`)
}

// ── Helpers ───────────────────────────────────────────────────

interface DiscoveredOAuthConfig {
	authorizeUrl: string
	tokenUrl: string
	registrationEndpoint?: string
	clientId?: string
	clientSecret?: string
	scopes?: string[]
}

/**
 * Discover OAuth configuration from the server's well-known endpoint.
 */
async function discoverOAuthConfig(serverUrl: string): Promise<DiscoveredOAuthConfig | null> {
	try {
		const base = serverUrl.replace(/\/$/, '')
		const wellKnownUrl = `${base}/.well-known/oauth-authorization-server`

		const res = await fetch(wellKnownUrl, {
			headers: { Accept: 'application/json' },
		})

		if (!res.ok) return null

		const data = (await res.json()) as Record<string, unknown>

		const authorizeUrl = String(data.authorization_endpoint ?? '')
		const tokenUrl = String(data.token_endpoint ?? '')

		if (!authorizeUrl || !tokenUrl) return null

		return {
			authorizeUrl,
			tokenUrl,
			registrationEndpoint:
				typeof data.registration_endpoint === 'string' ? data.registration_endpoint : undefined,
			scopes: Array.isArray(data.scopes_supported) ? (data.scopes_supported as string[]) : undefined,
		}
	} catch {
		return null
	}
}

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 * Returns the authorization code from the callback.
 */
function waitForCallback(expectedState: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			server.stop()
			reject(new Error('OAuth callback timeout (120s).'))
		}, 120_000)

		const server = Bun.serve({
			port: 19876,
			fetch(req) {
				const url = new URL(req.url)
				if (url.pathname !== '/callback') {
					return new Response('Not found', { status: 404 })
				}

				const code = url.searchParams.get('code')
				const state = url.searchParams.get('state')
				const error = url.searchParams.get('error')

				clearTimeout(timeout)
				server.stop()

				if (error) {
					const desc = url.searchParams.get('error_description') ?? error
					reject(new Error(`OAuth error: ${desc}`))
					return new Response(`<h1>Authentication Failed</h1><p>${desc}</p>`, {
						headers: { 'Content-Type': 'text/html' },
					})
				}

				if (!code) {
					reject(new Error('Missing authorization code in callback.'))
					return new Response('<h1>Missing Code</h1>', {
						headers: { 'Content-Type': 'text/html' },
					})
				}

				if (state !== expectedState) {
					reject(new Error('OAuth state mismatch — possible CSRF.'))
					return new Response('<h1>State Mismatch</h1>', {
						headers: { 'Content-Type': 'text/html' },
					})
				}

				resolve(code)
				return new Response('<h1>Authenticated!</h1><p>You can close this window.</p>', {
					headers: { 'Content-Type': 'text/html' },
				})
			},
		})
	})
}
