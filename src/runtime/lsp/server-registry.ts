/**
 * LSP server registry — maps language IDs to server binaries / commands.
 *
 * Each entry describes how to spawn a language server for a given language.
 * The registry uses a static default set augmented by user config
 * (`lsp.servers` in forge-config).
 */

export interface ServerEntry {
	/** Display name, e.g. "typescript-language-server". */
	name: string
	/** Shell command to spawn the server (stdio transport). */
	command: string
	/** Arguments appended to the command. */
	args: string[]
	/** Language IDs this server handles. */
	languages: string[]
}

/** Well-known defaults — users can override via config. */
const DEFAULT_SERVERS: ServerEntry[] = [
	{
		name: 'typescript-language-server',
		command: 'typescript-language-server',
		args: ['--stdio'],
		languages: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
	},
	{
		name: 'pyright',
		command: 'pyright-langserver',
		args: ['--stdio'],
		languages: ['python'],
	},
	{
		name: 'rust-analyzer',
		command: 'rust-analyzer',
		args: [],
		languages: ['rust'],
	},
	{
		name: 'gopls',
		command: 'gopls',
		args: ['serve'],
		languages: ['go'],
	},
]

export class ServerRegistry {
	private entries: ServerEntry[]

	constructor(userOverrides?: Record<string, string>) {
		this.entries = [...DEFAULT_SERVERS]
		if (userOverrides) {
			for (const [langOrName, command] of Object.entries(userOverrides)) {
				// User-supplied entry: "typescript": "my-ts-server --stdio"
				const parts = command.split(/\s+/)
				const cmd = parts[0]
				const args = parts.slice(1)
				// If it matches an existing entry's language, override it
				const existing = this.entries.find(e => e.languages.includes(langOrName) || e.name === langOrName)
				if (existing) {
					existing.command = cmd
					existing.args = args
				} else {
					this.entries.push({
						name: langOrName,
						command: cmd,
						args,
						languages: [langOrName],
					})
				}
			}
		}
	}

	/** Find a server entry that handles the given language ID. */
	forLanguage(lang: string): ServerEntry | null {
		return this.entries.find(e => e.languages.includes(lang)) ?? null
	}

	/** List all registered server entries. */
	all(): readonly ServerEntry[] {
		return this.entries
	}
}
