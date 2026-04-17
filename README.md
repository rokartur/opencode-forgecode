# opencode-forgecode

Forge (loops, plans, sandbox, graph) + the ForgeCode harness (summary-frame compaction, doom-loop, pending-todos, truncation, undo snapshots) for [OpenCode](https://opencode.ai).

`opencode-forgecode` is a single plugin that combines two toolchains:

- **opencode-forge** — iterative development loops, session-scoped plan storage, review-finding persistence, code-structure graph indexing, Docker sandbox, and a TUI sidebar.
- **ForgeCode harness** — a port of [forgecode](https://forgecode.dev)'s runtime: summary-frame compaction, output truncation (shell / search / fetch), doom-loop detection, pending-todo reminders, undo snapshots on mutating tools, and the unified `forge` / `muse` / `sage` agent trinity.

Both sides are wired through the same plugin entrypoint, so you do not need to stack two plugins that would fight over `experimental.session.compacting`, `tool.execute.*`, or `event`.

## Quick Start

```bash
npm add opencode-forgecode
```

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-forgecode@latest"]
}
```

Add to your `~/.config/opencode/tui.json` to enable the sidebar:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-forgecode@latest"]
}
```

On first run the plugin auto-creates `~/.config/opencode/forge-config.jsonc` from the bundled template.

Runtime notes:
- **Server/backend plugin** — packaged `dist/index.js` is built for Node-compatible loading.
- **TUI plugin** — still depends on the OpenTUI/Bun runtime stack (`@opentui/core` / `bun:ffi`), so treat the sidebar as Bun/OpenTUI-bound for now.
- If the backend still fails before the host can reach its local plugin URL, enable logging in `~/.config/opencode/forge-config.jsonc`:

```jsonc
{
  "logging": {
    "enabled": true,
    "debug": true
  }
}
```

## Features

### Forge
- **Iterative Development Loops** — Autonomous coding/auditing loop with optional worktree isolation, session rotation, stall detection, and review-finding persistence.
- **Session Plan Storage** — Session-scoped plan storage with 7-day TTL; plans viewable and editable from the TUI sidebar.
- **Review Finding Persistence** — Store and retrieve audit findings across session rotations.
- **Graph Indexing** — Code-structure graph with file watching, auto-scanning, and symbol tracking.
- **Docker Sandbox** — Run loops inside isolated Docker containers with a bind-mounted project directory.
- **Bundled TS agent trinity** — `forge`, `muse`, `sage` preconfigured for graph-aware workflows (TypeScript `src/agents/*.ts`). Registered automatically when the plugin loads — no separate install step.
- **CLI** — `oc-forgecode loop …`, `oc-forgecode graph …`, `oc-forgecode upgrade`.

### Harness
- **Summary-frame compaction** — Overrides `experimental.session.compacting` with the ported `forge-partial-summary-frame.md`. Falls back to forge's custom compaction prompt when no cached messages are available.
- **Output truncation** — `tool.execute.after` trims `bash`/`shell` output (head+tail with long-line clipping), caps lines for `grep`/`glob`/search tools, and caps characters for `webfetch`.
- **Doom-loop detection** — Per-session tool-signature tracker. On threshold-length repeating patterns (identical or cyclic, defaults to 3), appends a reminder via `tui.appendPrompt` asking the agent to change strategy.
- **Pending-todos reminder** — Tracks `todo.updated` events. When a session goes idle with `pending` or `in_progress` todos, appends a reminder with the outstanding items.
- **Undo snapshots** — Before every `write` / `edit` / `multi_patch` call, the prior file contents are snapshotted under `<dataDir>/snapshots/<session>/<ts>-<tag>.bak`. Restore with the bundled `fs_undo` tool.

## Agents

The plugin ships a unified TS-backed agent trinity. All three are registered automatically when the plugin loads — no `setup` step required, no markdown agents installed into `~/.config/opencode/agents/`.

| Agent | Mode | Description |
|-------|------|-------------|
| **forge** | primary | Primary coding agent with graph-first code discovery and harness tone. Read/edit/bash access. `review-delete`, `plan-execute`, `plan-write`, `plan-edit`, and `loop` are excluded. |
| **muse** | primary | Strategic planning agent. Builds plans incrementally in the KV store, caches them for user approval, and dispatches execution programmatically. All edits denied. Enforces two-step approval (pre-plan checkpoint + execution checkpoint with four canonical options). |
| **sage** | subagent | Dual-mode research + code review agent. Mode is selected from the request: review mode on diffs/commits/PRs/loop iterations, research mode on architectural or cross-file investigation. Read-only. Temperature 0.0. `plan-execute`, `plan-write`, `plan-edit`, and `loop` are excluded. |

The muse agent runs with all edits denied via message-level enforcement in the `experimental.chat.messages.transform` hook.

Example agent model overrides in `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-forgecode@latest"],
  "compaction": {
    "auto": true,
    "prune": true
  },
  "agent": {
    "forge": { "model": "anthropic/claude-opus-4.7" },
    "muse":  {
      "model": "openai/gpt-5.4",
      "reasoningEffort": "high",
      "textVerbosity": "medium",
      "reasoningSummary": "auto"
    },
    "sage":  {
      "model": "openai/gpt-5.4-mini",
      "reasoningEffort": "high",
      "textVerbosity": "low",
      "reasoningSummary": "auto"
    }
  }
}
```

Suggested model split:
- Strong model for `forge` / `muse`.
- Cheaper / faster model for `sage`.
- Keep OpenCode `compaction.auto=true` and `compaction.prune=true`; forgecode's summary-frame compaction builds on top of the native safety net rather than replacing it.

### Recommended OpenCode + DCP setup

For long tool-heavy sessions, `@tarquinen/opencode-dcp` can complement forgecode well **if** forgecode remains the owner of final session compaction and DCP is used only for proactive pruning/compression.

Recommended `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-forgecode@latest",
    "@tarquinen/opencode-dcp@latest"
  ],
  "compaction": {
    "auto": true,
    "prune": true
  },
  "agent": {
    "forge": { "model": "anthropic/claude-opus-4.7" },
    "muse":  {
      "model": "openai/gpt-5.4",
      "reasoningEffort": "high",
      "textVerbosity": "medium",
      "reasoningSummary": "auto"
    },
    "sage":  {
      "model": "openai/gpt-5.4-mini",
      "reasoningEffort": "high",
      "textVerbosity": "low",
      "reasoningSummary": "auto"
    }
  }
}
```

Recommended `~/.config/opencode/dcp.jsonc`:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Opencode-DCP/opencode-dynamic-context-pruning/master/dcp.schema.json",
  "enabled": true,
  "experimental": {
    "allowSubAgents": false
  },
  "compress": {
    "permission": "allow",
    "protectedTools": [
      "graph-query",
      "graph-symbols",
      "graph-analyze",
      "plan-write",
      "plan-read",
      "plan-edit",
      "review-write",
      "review-read",
      "review-delete",
      "apply_patch",
      "multi_patch",
      "sem_search"
    ]
  },
  "strategies": {
    "deduplication": {
      "enabled": true,
      "protectedTools": [
        "graph-query",
        "graph-symbols",
        "graph-analyze",
        "plan-write",
        "plan-read",
        "plan-edit",
        "review-write",
        "review-read",
        "review-delete",
        "apply_patch",
        "multi_patch",
        "sem_search"
      ]
    },
    "purgeErrors": {
      "enabled": true,
      "protectedTools": [
        "graph-query",
        "graph-symbols",
        "graph-analyze",
        "plan-write",
        "plan-read",
        "plan-edit",
        "review-write",
        "review-read",
        "review-delete",
        "apply_patch",
        "multi_patch",
        "sem_search"
      ]
    }
  }
}
```

Use DCP when:
- you keep long-lived sessions open,
- graph/search/bash outputs accumulate heavily,
- you want proactive cleanup before OpenCode hits hard compaction.

Skip DCP when:
- you usually start fresh sessions,
- your model has a very large context window and token cost is not a concern,
- you want the simplest possible setup.

## Tools

### Plan Tools

| Tool | Description |
|------|-------------|
| `plan-write` | Store the entire plan content. Auto-resolves key to `plan:{sessionID}`. |
| `plan-edit` | Edit the plan by finding `old_string` and replacing with `new_string`. |
| `plan-read` | Retrieve the plan. Supports pagination with offset/limit and pattern search. |
| `plan-execute` | Create a new forge session and send an approved plan as the first prompt. |

### Review Tools

| Tool | Description |
|------|-------------|
| `review-write` | Store a review finding with file, line, severity, and description. Auto-injects branch field. |
| `review-read` | Retrieve review findings. Filter by file path or search by regex pattern. |
| `review-delete` | Delete a review finding by file and line. |

### Loop Tools

| Tool | Description |
|------|-------------|
| `loop` | Execute a plan using an iterative development loop. Default runs in current directory. Set `worktree: true` for isolated git worktree. |
| `loop-cancel` | Cancel an active loop by worktree name. |
| `loop-status` | List all active loops or get detailed status by worktree name. Supports `restart` to resume inactive loops. |

### Graph Tools

| Tool | Description |
|------|-------------|
| `graph-status` | Check graph indexing status or trigger re-scan. Actions: `status`, `scan`. |
| `graph-query` | File-level queries: `top_files`, `file_deps`, `file_dependents`, `cochanges`, `blast_radius`, `packages`, `file_symbols`. |
| `graph-symbols` | Symbol-level queries: `find`, `search`, `signature`, `callers`, `callees`. |
| `graph-analyze` | Code-quality analysis: `unused_exports`, `duplication`, `near_duplicates`. |

### Harness Tools

| Tool | Description |
|------|-------------|
| `multi_patch` | Apply multiple text replacements to a single file atomically (tempfile + rename). |
| `fs_undo` | Restore a file from the snapshot history written by the harness on mutating tool calls. |

## Slash Commands

| Command | Description | Agent |
|---------|-------------|-------|
| `/review` | Run a code review on current changes | sage (subtask) |
| `/loop` | Start an iterative development loop in a worktree | forge |
| `/loop-status` | Check status of all active loops | forge |
| `/loop-cancel` | Cancel the active loop | forge |

## CLI

Manage loops and graph using the `oc-forgecode` CLI. The CLI auto-detects the project ID from git.

```bash
oc-forgecode <command> [options]
```

### Commands

#### upgrade

Check for plugin updates and install the latest version.

```bash
oc-forgecode upgrade
```

#### loop

```bash
oc-forgecode loop status
oc-forgecode loop cancel <worktree>
oc-forgecode loop restart <worktree> [--force] [--server http://localhost:5551]
```

#### graph

```bash
oc-forgecode graph status
oc-forgecode graph scan
oc-forgecode graph list
oc-forgecode graph remove <target>
oc-forgecode graph cleanup --days <n> [--yes]
```

Global flags: `--project, -p <name>`, `--dir, -d <path>`, `--db-path <path>`, `--help, -h`.

## Configuration

On first run, the plugin copies the bundled config to `~/.config/opencode/forge-config.jsonc`. The file is JSONC (supports `//` and `/* */` comments).

```jsonc
{
  "dataDir": "",
  "logging": { "enabled": false, "debug": false, "file": "" },
  "compaction": { "customPrompt": true, "maxContextTokens": 0 },
  "messagesTransform": { "enabled": true, "debug": false },
  "executionModel": "",
  "auditorModel": "",
  "loop": {
    "enabled": true,
    "defaultMaxIterations": 15,
    "cleanupWorktree": false,
    "defaultAudit": true,
    "model": "",
    "minAudits": 1,
    "stallTimeoutMs": 60000
  },
  "sandbox": { "mode": "off", "image": "oc-forge-sandbox:latest" },
  "graph": { "enabled": true, "autoScan": true, "watch": true, "debounceMs": 100 },
  "tui":   { "sidebar": true, "showLoops": true, "showVersion": true },
  "defaultKvTtlMs": 604800000,

  // Harness block — ForgeCode runtime behavior
  "harness": {
    "enabled": true,                 // Master switch. false disables all harness hooks.
    "doomLoopThreshold": 3,          // Consecutive tool repetitions before firing a reminder
    "pendingTodosReminder": true,    // Remind about pending todos on session.idle
    "snapshots": true,               // Capture .bak snapshots before write/edit/multi_patch
    "compaction": true,              // Use summary-frame compaction (overrides output.prompt)
    "truncation": { "enabled": true } // Trim long shell/search/fetch outputs
  }
}
```

### Harness Options

- `harness.enabled` — Master switch. Set to `false` to disable every harness hook (doom-loop, pending-todos, snapshots, compaction override, truncation). Default `true`.
- `harness.doomLoopThreshold` — Number of consecutive identical/cyclic tool invocations before the doom-loop reminder fires. Default `3`.
- `harness.pendingTodosReminder` — When `true`, a reminder with outstanding todos is appended to the TUI prompt on `session.idle` or `session.completed`. Default `true`.
- `harness.snapshots` — Capture `<dataDir>/snapshots/<session>/<ts>-<tag>.bak` before every `write` / `edit` / `multi_patch`. Used by `fs_undo`. Default `true`.
- `harness.compaction` — Override `experimental.session.compacting.output.prompt` with the ported summary-frame. When harness does not set a prompt (e.g. session has no cached messages), the plugin falls back to forge's `buildCustomCompactionPrompt`. Default `true`.
- `harness.truncation.enabled` — Trim long tool outputs in `tool.execute.after`. Caps: shell 200 lines head + 200 tail + 2000 chars/line; search 500 lines; fetch 40 000 chars. Default `true`.

### Forge Options

#### Top-level
- `dataDir` — Data dir for plugin storage (graph.db, KV store, logs, harness snapshots). Empty → `~/.local/share/opencode/forge`.
- `defaultKvTtlMs` — Default TTL for KV entries (default `604800000` / 7 days).
- `executionModel` — `provider/model` override for plan-execute sessions.
- `auditorModel` — `provider/model` override for the sage agent (review-mode invocations). Kept as `auditorModel` for backwards compatibility.
- `agents` — Per-agent temperature overrides keyed by display name.

#### Logging
- `logging.enabled`, `logging.debug`, `logging.file`.

#### Compaction
- `compaction.customPrompt` — Use forge's custom compaction prompt. Used as a fallback when `harness.compaction=true` has no cached messages.
- `compaction.maxContextTokens` — Token budget (`0` = unlimited).

#### Messages Transform
- `messagesTransform.enabled`, `messagesTransform.debug`.

#### Loop
- `loop.enabled`, `loop.defaultMaxIterations`, `loop.cleanupWorktree`, `loop.defaultAudit`, `loop.model`, `loop.stallTimeoutMs`, `loop.minAudits`.

#### Sandbox
- `sandbox.mode` (`"off"` | `"docker"`), `sandbox.image`.

#### Graph
- `graph.enabled`, `graph.autoScan`, `graph.watch`, `graph.debounceMs`.

#### TUI
- `tui.sidebar`, `tui.showLoops`, `tui.showVersion`.

## Compatibility

| Plugin | Recommendation | Why |
|---|---|---|
| `opencode-forgecode` | **Use** | This plugin. Owns compaction, doom-loop, pending-todos, loops, plans, graph, sandbox, and the agent set. |
| `@plannotator/opencode` | Usually safe | Planning / todo layer complements the forge plan store. |
| `opencode-forge` (upstream) | **Do not stack** | `opencode-forgecode` already contains everything from `opencode-forge`. Running both doubles loop hooks and graph scans. |
| `@tarquinen/opencode-dcp` | Optional for long sessions | Safe when used as proactive pruning/compression with protected forgecode tools. Keep OpenCode compaction enabled so forgecode still owns the final summary-frame compaction step. |

Main collision points:
- `experimental.session.compacting`
- `tool.execute.before` / `tool.execute.after`
- `experimental.chat.messages.transform`
- `event` handlers touching todos / sessions
- `tui.appendPrompt`

Rule: let `opencode-forgecode` own the **final** compaction prompt (`experimental.session.compacting`). If you also enable DCP, treat it as an upstream pruning layer, not a replacement for forgecode compaction.

## Snapshots and Undo

Harness snapshots live at `<dataDir>/snapshots/<sessionId>/<ts>-<fileTag>.bak`. The file tag is the workspace-relative path with non-alphanumerics replaced by underscores. To restore:

```
fs_undo file="src/foo.ts"            # newest snapshot
fs_undo file="src/foo.ts" steps=3    # 3rd newest
```

Snapshots are never deleted automatically. Clean old data-dir sessions manually if they grow large.

## TUI

See the `tui` config block above. The sidebar shows all loops for the current project, a `📋 Plan` link when a session plan is cached, and a command-palette entry `Memory: Show loops`.

The execution dialog lets you choose a launch mode (**New session**, **Execute here**, **Loop (worktree)**, **Loop**) and pre-fills model selections based on last-used values (30-day TTL per project).

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test --max-concurrency=1
bun run build           # emits dist/
```

The test suite covers 844 cases across forge features and the 52 harness-specific unit and integration tests.

## License

MIT
