<div align="center">

<img width="216" height="215" alt="super-mega-logo" src="https://github.com/user-attachments/assets/0c87c0fb-ae81-4c33-a5cc-ddc49b799694" />

# opencode-forgecode

**The all-in-one OpenCode plugin for autonomous development workflows.**

Iterative loops · Multi-agent orchestration · Code graph · Sandboxed execution · Smart harness

[![npm](https://img.shields.io/npm/v/opencode-forgecode)](https://www.npmjs.com/package/opencode-forgecode) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Tests](https://img.shields.io/badge/tests-756%20passing-brightgreen)]()

</div>

---

## What is this?

`opencode-forgecode` is a single plugin for [OpenCode](https://opencode.ai) that gives your AI agents the ability to plan, execute, review, and iterate — autonomously. It combines two systems into one cohesive runtime:

|  |  |
| --- | --- |
| **Forge** | Iterative development loops with git worktree isolation, session-scoped plans, code-graph indexing, Docker/Firejail/Bubblewrap sandboxing, background tasks, and a TUI sidebar |
| **Harness** | Summary-frame compaction, output truncation, doom-loop detection, pending-todo reminders, undo snapshots, and the multi-agent system (9 specialized agents) |

Both systems share the same plugin entrypoint — no conflicts over hooks, no duplicate compaction, no fighting for `tool.execute.*`.

---

## Quick Start

### 1. Install

```bash
npm add opencode-forgecode
```

### 2. Configure OpenCode

**`opencode.json`:**

```json
{
	"$schema": "https://opencode.ai/config.json",
	"plugin": ["opencode-forgecode@latest"],
	"compaction": { "auto": true, "prune": true },
	"agent": {
		"forge": { "model": "anthropic/claude-opus-4.7" },
		"muse": { "model": "openai/gpt-5.4" },
		"sage": { "model": "openai/gpt-5.4-mini" }
	}
}
```

### 3. Enable TUI sidebar (optional)

**`~/.config/opencode/tui.json`:**

```json
{
	"$schema": "https://opencode.ai/tui.json",
	"plugin": ["opencode-forgecode@latest"]
}
```

### 4. Done

On first run the plugin auto-creates `~/.config/opencode/forge-config.jsonc` with sensible defaults. Run `oc-forgecode doctor` to verify everything is wired correctly.

---

## Agents

The plugin ships **9 specialized agents**, all registered automatically on load:

### Core Trinity

| Agent | Role | Mode | Description |
| --- | --- | --- | --- |
| **forge** | Coder | primary | Graph-first code discovery, read/write/bash access, harness-aware. The workhorse. |
| **muse** | Planner | primary | Strategic planning with KV-backed plan store. All file edits denied. Two-step approval flow before any execution. |
| **sage** | Reviewer | subagent | Dual-mode: code review on diffs/PRs or deep research on architecture. Read-only, temp 0.0. |

### Extended Agents

| Agent          | Role            | Description                                                             |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| **explore**    | Explorer        | Parallel codebase discovery — optimized for broad, open-ended questions |
| **oracle**     | Q&A             | Short, precise answers to specific codebase questions                   |
| **librarian**  | Researcher      | Information retrieval using read-only tools                             |
| **prometheus** | Generator       | Scaffolding, boilerplate, migrations, templates                         |
| **metis**      | Meta-agent      | Analyzes context and recommends which agent to use next                 |
| **caveman**    | Efficiency mode | Cuts ~75% output tokens while keeping technical substance               |

Agents can call each other via `bg_spawn` (Sisyphus-style delegation) or the `tool_supported` agent-as-tool pattern.

---

## Tools

### 📝 Plan & Review

| Tool            | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `plan-write`    | Store a plan (auto-keyed to `plan:{sessionID}`, 7-day TTL) |
| `plan-edit`     | Find-and-replace within the stored plan                    |
| `plan-read`     | Retrieve plan with pagination and pattern search           |
| `plan-execute`  | Launch plan execution as a new forge session               |
| `review-write`  | Store review findings (file, line, severity, description)  |
| `review-read`   | Query findings by file path or regex                       |
| `review-delete` | Remove a finding by file and line                          |

### 🔁 Loops

| Tool          | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `loop`        | Run an iterative dev loop. `worktree: true` for git worktree isolation |
| `loop-status` | List active loops or get details by name. `restart` to resume          |
| `loop-cancel` | Cancel a running loop                                                  |

### 🕸️ Code Graph

| Tool | Description |
| --- | --- |
| `graph-status` | Check indexing status or trigger a re-scan |
| `graph-query` | File-level: `top_files`, `file_deps`, `file_dependents`, `cochanges`, `blast_radius`, `packages`, `file_symbols` |
| `graph-symbols` | Symbol-level: `find`, `search`, `signature`, `callers`, `callees`, `blast_radius`, `call_cycles` |
| `graph-analyze` | Quality: `unused_exports`, `duplication`, `near_duplicates` |

### 🔧 Editing & Undo

| Tool          | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| `patch`       | Hash-anchored `LINE#HASH` replacements — resilient to concurrent edits |
| `multi_patch` | Atomic multi-replacement on a single file (tempfile + rename)          |
| `fs_undo`     | Restore from automatic pre-edit snapshots                              |

### 🧠 Code Intelligence

| Tool               | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `lsp_diagnostics`  | Fetch diagnostics from language servers                       |
| `lsp_hover`        | Get type info and docs for a symbol                           |
| `lsp_references`   | Find all references to a symbol                               |
| `lsp_definition`   | Jump to definition                                            |
| `lsp_code_actions` | Get available code actions                                    |
| `lsp_rename`       | Rename a symbol across the project                            |
| `ast_search`       | Structural code search via `ast-grep` patterns                |
| `ast_rewrite`      | Structural code rewrites via `ast-grep`                       |
| `sem_search`       | Semantic search with embeddings (OpenAI / fastembed / Voyage) |
| `code-stats`       | Language / LOC summary via `tokei` → `scc` → `rg` fallback    |

### ⚡ Background Tasks

| Tool        | Description                            |
| ----------- | -------------------------------------- |
| `bg_spawn`  | Launch an agent as a background task   |
| `bg_status` | Check status of background tasks       |
| `bg_wait`   | Wait for a background task to complete |
| `bg_cancel` | Cancel a running background task       |

---

## Slash Commands

| Command        | Description                          | Agent |
| -------------- | ------------------------------------ | ----- |
| `/review`      | Run a code review on current changes | sage  |
| `/loop`        | Start an iterative development loop  | forge |
| `/loop-status` | Check status of all active loops     | forge |
| `/loop-cancel` | Cancel the active loop               | forge |

---

## CLI

```bash
oc-forgecode <command> [options]
```

| Command                    | Description                                      |
| -------------------------- | ------------------------------------------------ |
| `doctor`                   | Validate config, DB, sandbox, and runtime health |
| `upgrade`                  | Check for and install plugin updates             |
| `stats`                    | Display session and loop statistics              |
| `status [name]`            | Detailed loop status (iterations, tokens, phase) |
| `cancel <name>`            | Cancel and clean up a worktree loop              |
| `restart <name>`           | Resume a cancelled/failed loop                   |
| `graph status`             | Show graph indexing state                        |
| `graph scan`               | Trigger a full graph re-scan                     |
| `graph list`               | List all cached graph indexes                    |
| `graph remove <target>`    | Remove a specific graph cache                    |
| `graph cleanup --days <n>` | Clean up caches older than N days                |
| `ci`                       | Headless loop execution for CI/CD pipelines      |
| `mcp`                      | MCP server management                            |

**Global flags:** `--project, -p <name>` · `--dir, -d <path>` · `--db-path <path>` · `--help, -h`

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    OpenCode Host                         │
│                                                          │
│  opencode.json ──► plugin: ["opencode-forgecode@latest"] │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────┐
│              opencode-forgecode plugin                    │
│                                                           │
│  ┌──────────────────┐  ┌──────────────────────────────┐   │
│  │  9 Agents        │  │  Hooks Pipeline              │   │
│  │  forge·muse·sage │  │  chat.message                │   │
│  │  explore·oracle  │  │  tool.execute.before/after   │   │
│  │  librarian       │  │  event                       │   │
│  │  prometheus      │  │  permission.ask              │   │
│  │  metis·caveman   │  │  session.compacting          │   │
│  └──────────────────┘  │  messages.transform          │   │
│                        └──────────────────────────────┘   │
│  ┌──────────────────┐  ┌──────────────────────────────┐   │
│  │  Services        │  │  Runtime                     │   │
│  │  KV Store        │  │  Budget Enforcer             │   │
│  │  Loop Service    │  │  Session Recovery            │   │
│  │  Graph Service   │  │  Telemetry Collector         │   │
│  │  Sandbox Manager │  │  Intent Router               │   │
│  │  LSP Pool        │  │  Restricted Shell            │   │
│  │  Background Mgr  │  │  Skill Loader                │   │
│  │  MCP Registry    │  │  Context Injection           │   │
│  │  Host Tools (rg) │  │  Search Renderer             │   │
│  └──────────────────┘  └──────────────────────────────┘   │
│                                                           │
│  ┌────────────────────────────────────────────────────┐   │
│  │  Storage: SQLite (KV + Graph + Telemetry)          │   │
│  │  ~/.local/share/opencode/forge/                    │   │
│  └────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

### Key Design Decisions

- **Leader/Follower graph** — Multiple plugin instances (e.g., across worktrees) coordinate via a lock file + Unix domain socket IPC. Only the leader writes; followers read over RPC.
- **Soft-fail everywhere** — If the DB can't open, the plugin falls back to in-memory KV. If the graph can't initialize, tools gracefully report "unavailable". Nothing crashes the session.
- **Per-agent budgets** — `AgentBudgetEnforcer` tracks turns, tokens, requests, and tool failures per agent with configurable `warn` → `stop` policies.
- **Session recovery** — `SessionRecoveryManager` handles context-overflow, timeouts, and overload errors with automatic retry and model fallback chains.
- **Host-side fast tools** — When `rg` (ripgrep) is available, `grep`/`glob` tool calls are intercepted before reaching the sandbox and served via ripgrep with submatch-windowed, grouped output — reducing token usage and latency.

---

## Configuration

The plugin config lives at `~/.config/opencode/forge-config.jsonc` (JSONC format — comments allowed).

### Essential Settings

```jsonc
{
	// Storage (empty = ~/.local/share/opencode/forge)
	"dataDir": "",

	// Logging
	"logging": { "enabled": false, "debug": false },

	// Graph indexing
	"graph": {
		"enabled": true,
		"autoScan": true, // Scan on startup
		"watch": true, // Watch for file changes
		"debounceMs": 100,
	},

	// Iterative loops
	"loop": {
		"enabled": true,
		"defaultMaxIterations": 15,
		"defaultAudit": true,
		"cleanupWorktree": false,
		"stallTimeoutMs": 60000,
	},

	// Sandbox (off | docker | sandbox-exec | bubblewrap | firejail)
	"sandbox": { "mode": "off", "image": "oc-forge-sandbox:latest" },

	// Harness (doom-loop, truncation, snapshots, compaction)
	"harness": {
		"enabled": true,
		"doomLoopThreshold": 3,
		"pendingTodosReminder": true,
		"snapshots": true,
		"compaction": true,
		"hashAnchoredPatch": true,
		"truncation": { "enabled": true },
	},
}
```

### Advanced Settings

<details>
<summary><b>Per-agent budgets</b></summary>

```jsonc
{
	"agents": {
		"forge": {
			"budget": {
				"maxTurns": 50,
				"maxTokensPerSession": 500000,
				"maxToolFailuresPerTurn": 5,
			},
		},
	},
}
```

</details>

<details>
<summary><b>Fallback models</b></summary>

```jsonc
{
	"agents": {
		"forge": {
			"fallbackModels": [
				{ "provider": "anthropic", "model": "claude-sonnet-4" },
				{ "provider": "openai", "model": "gpt-5.4-mini" },
			],
		},
	},
}
```

</details>

<details>
<summary><b>Restricted shell</b></summary>

```jsonc
{
	"restrictedShell": {
		"enabled": true,
		"dangerousPatterns": ["rm -rf /", ":(){ :|:& };:"],
		"allowlist": ["npm test", "bun test", "make"],
	},
}
```

</details>

<details>
<summary><b>Context injection</b></summary>

```jsonc
{
	"contextInjection": {
		"enabled": true,
		"rules": [
			{
				"pattern": "**/*.test.ts",
				"content": "Follow the testing conventions in TESTING.md",
				"priority": 10,
			},
		],
	},
}
```

</details>

<details>
<summary><b>Skill loader</b></summary>

```jsonc
{
	"skills": {
		"enabled": true,
		"directories": [".opencode/skills", "~/.config/opencode/skills"],
	},
}
```

</details>

<details>
<summary><b>LSP integration</b></summary>

```jsonc
{
	"lsp": {
		"enabled": true,
		"servers": {
			"typescript": { "command": "typescript-language-server", "args": ["--stdio"] },
			"python": { "command": "pylsp" },
		},
	},
}
```

</details>

<details>
<summary><b>Host-side fast tools (ripgrep)</b></summary>

```jsonc
{
	"host": {
		// When true and `rg` is on PATH, intercept grep/glob tool calls
		// and serve them via ripgrep with grouped, submatch-windowed output.
		// Defaults to true.
		"fastGrep": true,
	},
}
```

</details>

<details>
<summary><b>Background tasks</b></summary>

```jsonc
{
	"background": {
		"enabled": true,
		"maxConcurrent": 5,
		"perModelLimit": 2,
		"pollIntervalMs": 3000,
		"idleTimeoutMs": 10000,
	},
}
```

</details>

<details>
<summary><b>Telemetry (local-only, opt-in)</b></summary>

```jsonc
{
	"telemetry": {
		"enabled": true, // SQLite-backed, never leaves your machine
	},
}
```

</details>

<details>
<summary><b>Built-in MCPs</b></summary>

```jsonc
{
	"mcp": {
		"websearch": { "provider": "tavily", "apiKey": "tvly-..." },
		"context7": { "apiKey": "..." },
		"grepApp": { "enabled": true },
	},
}
```

</details>

### All Config Options Reference

| Section | Key | Default | Description |
| --- | --- | --- | --- |
| — | `dataDir` | `~/.local/share/opencode/forge` | Plugin data directory |
| — | `defaultKvTtlMs` | `604800000` (7d) | Default TTL for KV entries |
| `logging` | `enabled` / `debug` / `file` | `false` / `false` / auto | File-based logging |
| `graph` | `enabled` / `autoScan` / `watch` / `debounceMs` | `true` / `true` / `true` / `100` | Code graph indexing |
| `loop` | `enabled` / `defaultMaxIterations` / `defaultAudit` / `cleanupWorktree` / `stallTimeoutMs` / `minAudits` | `true` / `15` / `true` / `false` / `60000` / `1` | Loop execution |
| `sandbox` | `mode` / `image` | `"off"` / `"oc-forge-sandbox:latest"` | Sandboxed execution |
| `harness` | `enabled` / `doomLoopThreshold` / `pendingTodosReminder` / `snapshots` / `compaction` / `hashAnchoredPatch` | `true` / `3` / `true` / `true` / `true` / `true` | Harness runtime |
| `harness.truncation` | `enabled` | `true` | Output truncation (shell 200+200 lines @ 500 chars/line, search 200 lines @ 400 chars/line, fetch 40K chars) |
| `compaction` | `customPrompt` / `maxContextTokens` | `true` / `0` | Summary-frame compaction fallback |
| `messagesTransform` | `enabled` / `debug` | `true` / `false` | Message pipeline |
| `host` | `fastGrep` | `true` | Intercept grep/glob via ripgrep when `rg` is on PATH |

---

## Harness Features

### Doom-Loop Detection

Tracks tool call signatures per session. When it detects 3+ consecutive identical or cyclic patterns, it injects a reminder via `tui.appendPrompt` asking the agent to change strategy.

### Output Truncation

Automatically trims long tool output in `tool.execute.after`:

- **Shell/bash**: 200 lines head + 200 lines tail, 500 chars/line max
- **Search/grep**: 200 lines max, 400 chars/line max (with per-file match distribution banner)
- **Web fetch**: 40,000 chars max

### Summary-Frame Compaction

Overrides `experimental.session.compacting` with an intelligent summary frame that preserves key context, decisions, and in-progress state. Falls back to a custom compaction prompt when no cached messages are available.

### Undo Snapshots

Before every `write` / `edit` / `multi_patch` / `patch`, the harness snapshots the file at:

```
<dataDir>/snapshots/<sessionId>/<timestamp>-<fileTag>.bak
```

Restore with:

```
fs_undo file="src/foo.ts"            # latest snapshot
fs_undo file="src/foo.ts" steps=3    # 3 versions back
```

### Pending-Todos Reminder

Tracks `todo.updated` events. When a session goes idle with pending or in-progress todos, appends a reminder with the outstanding items.

### Host-Side Fast Tools

When `rg` (ripgrep) is on PATH, the plugin intercepts `grep` and `glob` tool calls before they reach the sandbox and serves them via ripgrep. This provides:

- **Submatch-windowed output** — only ±30 chars around each match are returned, dramatically reducing token consumption on large files
- **Grouped results** — matches are grouped by file with a per-file match distribution banner
- **Automatic fallback** — if `rg` isn't available or a sandbox is active, calls pass through to the default implementation

Disable with `"host": { "fastGrep": false }` in `forge-config.jsonc`.

---

## Plugin Compatibility

| Plugin | Status | Notes |
| --- | --- | --- |
| `opencode-forgecode` | ✅ **This plugin** | Owns compaction, hooks, agents, tools |
| `@plannotator/opencode` | ✅ Compatible | Planning layer complements forge plans |
| `opencode-forge` (upstream) | ❌ **Do not stack** | Already included — running both doubles hooks and graph scans |
| `@tarquinen/opencode-dcp` | ⚠️ Optional | Safe as upstream pruning layer. Let forgecode own final compaction |

**Rule of thumb:** `opencode-forgecode` must own the final `experimental.session.compacting` prompt. If using DCP, treat it as proactive pruning only.

---

## GitHub Actions / CI

Use the built-in CI mode for headless loop execution in pipelines:

```yaml
- name: Run forge loop
  run: npx oc-forgecode ci --task "Fix failing tests" --output json
```

Supports `--output json|markdown|text` and automatic PR comment posting.

---

## Development

```bash
bun install
bun run typecheck        # TypeScript type checking
bun run lint             # Linting
bun test                 # 756+ tests
bun run build            # Emit dist/
```

---

## License

MIT
