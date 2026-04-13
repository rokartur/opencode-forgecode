# Contributing to OpenCode Forge

Thank you for your interest in contributing to OpenCode Forge. This document provides guidelines and instructions for developing the plugin.

## Development Setup

### Prerequisites

- Node.js 20+ or Bun
- pnpm package manager

### Installation

```bash
pnpm install
```

### Development Build

```bash
pnpm build
```

Compiles TypeScript to `dist/` using Bun. The build script handles TypeScript compilation and prepares the plugin for development.

## Project Structure

```
src/
├── index.ts          # Main plugin entry point, createForgePlugin factory
├── tui.tsx           # TUI sidebar widget and dialog components
├── types.ts          # Plugin configuration types
├── config.ts         # Configuration loading and handler creation
├── setup.ts          # Initial setup and config file generation
├── version.ts        # Version constant
├── agents/           # Agent definitions (code, architect, auditor)
├── cache/            # Memory cache implementation
├── cli/              # CLI commands (graph, loop, upgrade)
├── command/          # Slash command templates
├── constants/        # Loop constants and permission rules
├── graph/            # Code graph indexing and querying
│   ├── service.ts    # GraphService interface and implementation
│   ├── client.ts     # RPC client for graph worker
│   ├── database.ts   # SQLite database setup
│   ├── worker.ts     # Web worker for tree-sitter indexing
│   └── types.ts      # Graph-specific types
├── hooks/            # OpenCode hook implementations
├── sandbox/          # Docker sandbox integration
├── services/         # Core services (loop, KV)
├── storage/          # Storage utilities
├── tools/            # Tool implementations
│   ├── index.ts      # Tool registration
│   ├── types.ts      # ToolContext interface
│   ├── loop.ts       # Loop control tools
│   ├── graph.ts      # Graph query tools
│   ├── plan-kv.ts    # Plan storage tools
│   ├── review.ts     # Review finding tools
│   └── sandbox-fs.ts # Sandbox filesystem tools
└── utils/            # Utility functions
```

## Testing

### Running Tests

```bash
pnpm test
```

Tests use Bun's built-in test runner. The project has 43 test files covering:

- Loop management and state machine behavior
- Graph indexing and querying
- Review finding persistence
- Plan storage and retrieval
- Sandbox Docker integration
- CLI commands
- TUI components
- Hook lifecycle

### Writing Tests

Place test files in `test/` with `.test.ts` extension. Tests use Bun's `describe`/`test`/`expect` API:

```typescript
import { describe, test, expect } from 'bun:test'

describe('my feature', () => {
  test('should do something', () => {
    expect(true).toBe(true)
  })
})
```

## Build Process

```bash
pnpm build
```

TypeScript compilation is handled by the build script (`scripts/build.ts`) using Bun. Output goes to `dist/`.

## Code Style

The project uses ESLint and Prettier for code style:

```bash
pnpm lint
```

### Key Conventions

- **TypeScript strict mode** is enabled
- **No unused variables** - use `_` prefix for intentionally unused parameters
- **No deprecated APIs** - deprecated usage triggers warnings
- **Solid.js** for TUI components (uses eslint-plugin-solid)
- **ES2022+** target with explicit module type

### TSDoc Style

Public APIs should have TSDoc comments:

```typescript
/**
 * Description of the function.
 * 
 * @param paramName - Description of the parameter.
 * @returns Description of the return value.
 */
export function myFunction(paramName: string): number { ... }
```

## Git Workflow

### Branch Naming

- `feature/` - New features
- `fix/` - Bug fixes
- `docs/` - Documentation
- `refactor/` - Code refactoring
- `test/` - Test additions or updates

### Commit Conventions

- Use clear, descriptive commit messages
- Start with a verb (add, fix, update, remove, refactor)
- No emojis in commit messages
- No "committed by opencode agent" mentions

Examples:
- `add graph query tool for file dependencies`
- `fix stall detection timeout handling`
- `update CONTRIBUTING.md with new test instructions`

### Pull Request Process

1. Ensure all tests pass: `pnpm test`
2. Ensure no lint errors: `pnpm lint`
3. Ensure type checking passes: `pnpm typecheck`
4. Update documentation if needed
5. Request review from maintainers

## API Documentation

Generate API reference documentation:

```bash
pnpm docs:api
```

Output goes to `docs/api/`. Documentation uses Typedoc with markdown output.
