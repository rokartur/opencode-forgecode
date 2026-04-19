/**
 * MCP Token Store — secure storage for OAuth tokens.
 *
 * Storage strategy:
 *   1. OS keychain via optional `keytar` (if available)
 *   2. Fallback: AES-256-GCM encrypted JSON file in data directory
 *
 * Each server's tokens are stored under a unique key derived from the server URL.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { TokenSet } from './oauth'

const SERVICE_NAME = 'opencode-forge-mcp'
const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32
const IV_LENGTH = 16
const SALT_LENGTH = 32

export interface TokenStore {
	/** Get stored tokens for a server. Returns null if not found. */
	get(serverUrl: string): Promise<TokenSet | null>
	/** Store tokens for a server. */
	set(serverUrl: string, tokens: TokenSet): Promise<void>
	/** Remove tokens for a server. */
	remove(serverUrl: string): Promise<void>
	/** List all server URLs with stored tokens. */
	list(): Promise<string[]>
	/** Backend name for logging. */
	readonly backend: string
}

// ── Keytar backend ────────────────────────────────────────────

// @ts-ignore — keytar is an optional peer dependency
function tryLoadKeytar(): typeof import('keytar') | null {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('keytar')
	} catch {
		return null
	}
}

function createKeytarStore(): TokenStore | null {
	const keytar = tryLoadKeytar()
	if (!keytar) return null

	const makeKey = (url: string) => `mcp:${url}`

	return {
		backend: 'keytar',

		async get(serverUrl: string): Promise<TokenSet | null> {
			try {
				const raw = await keytar.getPassword(SERVICE_NAME, makeKey(serverUrl))
				if (!raw) return null
				return JSON.parse(raw) as TokenSet
			} catch {
				return null
			}
		},

		async set(serverUrl: string, tokens: TokenSet): Promise<void> {
			await keytar.setPassword(SERVICE_NAME, makeKey(serverUrl), JSON.stringify(tokens))
		},

		async remove(serverUrl: string): Promise<void> {
			await keytar.deletePassword(SERVICE_NAME, makeKey(serverUrl))
		},

		async list(): Promise<string[]> {
			try {
				const creds = await keytar.findCredentials(SERVICE_NAME)
				return creds
					.map((c: { account: string }) => c.account)
					.filter((a: string) => a.startsWith('mcp:'))
					.map((a: string) => a.slice(4))
			} catch {
				return []
			}
		},
	}
}

// ── Encrypted file backend ────────────────────────────────────

interface EncryptedFileData {
	salt: string // hex
	iv: string // hex
	tag: string // hex
	ciphertext: string // hex
}

interface TokenFileContents {
	version: 1
	tokens: Record<string, TokenSet>
}

function deriveKey(password: string, salt: Buffer): Buffer {
	return scryptSync(password, salt, KEY_LENGTH)
}

/**
 * Derive a machine-specific encryption password.
 * Uses a combination of hostname and user info for deterministic derivation.
 */
function getMachinePassword(): string {
	const os = require('os') as typeof import('os')
	return `forge:${os.hostname()}:${os.userInfo().username}:${os.homedir()}`
}

function encrypt(data: string, password: string): EncryptedFileData {
	const salt = randomBytes(SALT_LENGTH)
	const key = deriveKey(password, salt)
	const iv = randomBytes(IV_LENGTH)

	const cipher = createCipheriv(ALGORITHM, key, iv)
	let ciphertext = cipher.update(data, 'utf8', 'hex')
	ciphertext += cipher.final('hex')
	const tag = cipher.getAuthTag()

	return {
		salt: salt.toString('hex'),
		iv: iv.toString('hex'),
		tag: tag.toString('hex'),
		ciphertext,
	}
}

function decrypt(encrypted: EncryptedFileData, password: string): string {
	const salt = Buffer.from(encrypted.salt, 'hex')
	const key = deriveKey(password, salt)
	const iv = Buffer.from(encrypted.iv, 'hex')
	const tag = Buffer.from(encrypted.tag, 'hex')

	const decipher = createDecipheriv(ALGORITHM, key, iv)
	decipher.setAuthTag(tag)

	let decrypted = decipher.update(encrypted.ciphertext, 'hex', 'utf8')
	decrypted += decipher.final('utf8')
	return decrypted
}

function createEncryptedFileStore(dataDir: string): TokenStore {
	const dir = join(dataDir, 'mcp')
	const filePath = join(dir, 'tokens.enc.json')
	const password = getMachinePassword()

	function readStore(): TokenFileContents {
		if (!existsSync(filePath)) return { version: 1, tokens: {} }
		try {
			const raw = readFileSync(filePath, 'utf-8')
			const encrypted: EncryptedFileData = JSON.parse(raw)
			const decrypted = decrypt(encrypted, password)
			return JSON.parse(decrypted) as TokenFileContents
		} catch {
			// Corrupted or wrong key — start fresh
			return { version: 1, tokens: {} }
		}
	}

	function writeStore(contents: TokenFileContents): void {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
		const json = JSON.stringify(contents)
		const encrypted = encrypt(json, password)
		writeFileSync(filePath, JSON.stringify(encrypted), 'utf-8')
	}

	return {
		backend: 'encrypted-file',

		async get(serverUrl: string): Promise<TokenSet | null> {
			const store = readStore()
			return store.tokens[serverUrl] ?? null
		},

		async set(serverUrl: string, tokens: TokenSet): Promise<void> {
			const store = readStore()
			store.tokens[serverUrl] = tokens
			writeStore(store)
		},

		async remove(serverUrl: string): Promise<void> {
			const store = readStore()
			delete store.tokens[serverUrl]
			writeStore(store)
		},

		async list(): Promise<string[]> {
			return Object.keys(readStore().tokens)
		},
	}
}

// ── Factory ───────────────────────────────────────────────────

/**
 * Create a TokenStore with the best available backend.
 * Prefers OS keychain (keytar), falls back to encrypted file.
 */
export function createTokenStore(dataDir: string): TokenStore {
	const keytarStore = createKeytarStore()
	if (keytarStore) return keytarStore
	return createEncryptedFileStore(dataDir)
}
