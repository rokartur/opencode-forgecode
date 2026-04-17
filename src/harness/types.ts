/**
 * Shared types for the forge harness.
 *
 * These mirror the relevant fragments of forgecode's `forge_domain` without
 * depending on it — just enough to run the compactor, transformers and the
 * summary-frame template against opencode message payloads.
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ForgeMessageContent {
  text?: string;
  tool_call?: ForgeToolCall;
  tool_result?: ForgeToolResult;
}

export interface ForgeToolCall {
  id?: string;
  name: string;
  /**
   * Variant-style payload used by the summary-frame template.
   * Exactly one of the keys below is populated per tool call.
   */
  tool: {
    file_read?: { path: string };
    file_update?: { path: string };
    file_remove?: { path: string };
    search?: { pattern: string };
    skill?: { name: string };
    sem_search?: { queries: Array<{ use_case: string }> };
    shell?: { command: string };
    mcp?: { name: string };
    todo_write?: { changes: Array<ForgeTodoChange> };
  };
}

export interface ForgeToolResult {
  id?: string;
  name: string;
  output: string;
  is_error?: boolean;
}

export interface ForgeTodoChange {
  kind: "added" | "updated" | "removed";
  todo: { content: string; status: "pending" | "in_progress" | "completed" };
}

export interface ForgeMessage {
  role: Role;
  contents: ForgeMessageContent[];
  /** Set to true for messages that may be evicted during compaction. */
  droppable?: boolean;
  /** Extended thinking / reasoning details from the provider. */
  reasoning_details?: unknown;
}

export interface ForgeEnv {
  os: string;
  cwd: string;
  shell: string;
  home: string;
}

export interface ForgeSkill {
  name: string;
  description: string;
}

export interface ForgePendingTodo {
  status: "pending" | "in_progress" | "completed";
  content: string;
}
