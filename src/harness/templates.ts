/**
 * Inline template renderers for the forge harness.
 *
 * Each template is a pure function that builds a string from a typed context.
 * No handlebars, no partials, no filesystem reads — keeps the plugin
 * dependency-free and avoids packaging `.hbs` assets alongside the compiled
 * JavaScript.
 *
 * The public API is `render(name, context)`, mirroring the previous Handlebars
 * implementation so the rest of the harness module is unchanged.
 */

import type { ForgeEnv, ForgeMessage, ForgePendingTodo, ForgeSkill } from "./types";

export type TemplateName =
  | "system-info"
  | "tool-use-example"
  | "tool-error-reflection"
  | "skill-instructions"
  | "summary-frame"
  | "doom-loop-reminder"
  | "pending-todos-reminder"
  | "tool-retry-message"
  | "title-generation"
  | "commit-message";

export interface SystemInfoContext {
  env: ForgeEnv;
}

export interface SkillInstructionsContext {
  skills: ForgeSkill[];
}

export interface SummaryFrameContext {
  messages: ForgeMessage[];
}

export interface DoomLoopReminderContext {
  consecutive_calls: number;
}

export interface PendingTodosReminderContext {
  todos: ForgePendingTodo[];
}

export interface ToolRetryMessageContext {
  attempts_left: number;
}

// ---------------------------------------------------------------------------
// Static templates (no context)
// ---------------------------------------------------------------------------

const TOOL_USE_EXAMPLE = `1. You can only make one tool call per message.
2. Each tool call must be wrapped in \`<forge_tool_call>\` tags.
3. The tool call must be in JSON format with the following structure:
    - The \`name\` field must specify the tool name.
    - The \`arguments\` field must contain the required parameters for the tool.

Here's a correct example structure:

Example 1:
<forge_tool_call>
{"name": "read", "arguments": {"path": "/a/b/c.txt"}}
</forge_tool_call>

Example 2:
<forge_tool_call>
{"name": "write", "arguments": {"path": "/a/b/c.txt", "content": "Hello World!"}}
</forge_tool_call>

Important:
1. ALWAYS use JSON format inside \`forge_tool_call\` tags.
2. Specify the name of tool in the \`name\` field.
3. Specify the tool arguments in the \`arguments\` field.
4. If you need to make multiple tool calls, send them in separate messages.

Before using a tool, ensure all required arguments are available. 
If any required arguments are missing, do not attempt to use the tool.
`;

const TOOL_ERROR_REFLECTION = `You must now deeply reflect on the error above:
1. Pinpoint exactly what was wrong with the tool call — was it the wrong tool, incorrect or missing parameters, or malformed structure?
2. Explain why that mistake happened. Did you misunderstand the tool's schema? Miss a required field? Misread the context?
3. Make the correct tool call as it should have been made.

Do NOT skip this reflection.`;

const TITLE_GENERATION = `You are Title Generator, an expert assistant that analyzes user tasks and generates precise, impactful titles for user prompts.

## Core Requirements:

- **Length**: 3–7 words preferred
- **Format**: Title case (e.g., "Advanced File Processing System") without Markdown Formatting
- **Style**: Technical, clear, and informative
- **Focus**: Capture core functionality without marketing language.
`;

const COMMIT_MESSAGE = `You are a commit message generator that creates concise, conventional commit messages from git diffs.

IMPORTANT: Return ONLY raw Text. No markdown. No code blocks. No \`\`\` markers.

# Commit Message Format
Structure: type(scope): description
- **Type**: feat, fix, refactor, perf, docs, style, test, chore, ci, build, revert
- **Scope**: optional, component/module name (lowercase, no spaces)
- **Description**: imperative mood, lowercase, no period, 10-72 characters
- **Breaking changes**: add ! after type/scope (e.g., refactor!: or feat(api)!:)

# Rules
1. **Single line only** - never use multiple lines or bullet points
2. **Focus on what changed** - describe the primary change, not implementation details
3. **Be specific** - mention the affected component/module when relevant
4. **Exclude issue/PR references** - never include issue or PR numbers like (#1234) in the commit message
5. **Match project style** - analyze recent_commit_messages for patterns (scope usage, verbosity), but ignore any issue/PR references
6. **Imperative mood** - use "add" not "adds" or "added"
7. **Conciseness** - shorter is better; avoid redundant words like "improve", "update", "enhance" unless necessary

# Input Analysis Priority
1. **git_diff** - primary source for understanding the actual changes
2. **additional_context** - user-provided context to help structure the commit message (if provided, use this information to guide the commit message structure and focus)
3. **recent_commit_messages** - reference for project's commit message style and conventions
4. **branch_name** - additional context hint (feature/, fix/, etc.)

# Examples
Good commit messages:
- feat(auth): add OAuth2 login support
- fix(api): handle null response in user endpoint
- refactor(db): simplify query builder interface
- docs(readme): update installation instructions
- perf(parser): optimize token scanning algorithm

Bad commit messages (avoid these):
- refactor: improve the authentication system by adding new OAuth2 support and updating the login flow  (too verbose)
- fix: fix bug  (too vague)
- Add new feature  (not lowercase, missing type)

REMINDER: Output raw text directly. Do NOT use \`\`\`json or \`\`\` or any markdown.
`;

// ---------------------------------------------------------------------------
// Dynamic templates
// ---------------------------------------------------------------------------

function renderSystemInfo(ctx: SystemInfoContext): string {
  const { env } = ctx;
  return (
    `<operating_system>${env.os}</operating_system>\n` +
    `<current_working_directory>${env.cwd}</current_working_directory>\n` +
    `<default_shell>${env.shell}</default_shell>\n` +
    `<home_directory>${env.home}</home_directory>\n`
  );
}

function renderSkillInstructions(ctx: SkillInstructionsContext): string {
  const preamble = `## Skill Instructions:

**CRITICAL**: Before attempting any task, ALWAYS check if a skill exists for it in the available_skills list below. Skills are specialized workflows that must be invoked when their trigger conditions match the user's request.

How skills work:

1. **Invocation**: Use the \`skill\` tool with just the skill name parameter

   - Example: Call skill tool with \`{"name": "mock-calculator"}\`
   - No additional arguments needed

2. **Response**: The tool returns the skill's details wrapped in \`<skill_details>\` containing:

   - \`<command path="..."><![CDATA[...]]></command>\` - The complete SKILL.md file content with the skill's path
   - \`<resource>\` tags - List of additional resource files available in the skill directory
   - Includes usage guidelines, instructions, and any domain-specific knowledge

3. **Action**: Read and follow the instructions provided in the skill content
   - The skill instructions will tell you exactly what to do and how to use the resources
   - Some skills provide workflows, others provide reference information
   - Apply the skill's guidance to complete the user's task

Examples of skill invocation:

- To invoke calculator skill: use skill tool with name "calculator"
- To invoke weather skill: use skill tool with name "weather"
- For namespaced skills: use skill tool with name "office-suite:pdf"

Important:

- Only invoke skills listed in \`<available_skills>\` below
- Do not invoke a skill that is already active/loaded
- Skills are not CLI commands - use the skill tool to load them
- After loading a skill, follow its specific instructions to help the user

<available_skills>
`;
  const items = ctx.skills
    .map(
      (s) =>
        `<skill>\n<name>${s.name}</name>\n<description>\n${s.description}\n</description>\n</skill>`,
    )
    .join("\n");
  return `${preamble}${items}\n</available_skills>\n`;
}

function renderDoomLoopReminder(ctx: DoomLoopReminderContext): string {
  return (
    `You appear to be stuck in a repetitive loop, having made ${ctx.consecutive_calls} similar calls.\n` +
    `This indicates you are not making progress. Please:\n\n` +
    `1. Reconsider your approach to solving this problem\n` +
    `2. Try a different tool or different arguments\n` +
    `3. If you're stuck, explain what you're trying to accomplish and ask for clarification\n`
  );
}

function renderPendingTodosReminder(ctx: PendingTodosReminderContext): string {
  const lines = ctx.todos.map((t) => `- [${t.status}] ${t.content}`).join("\n");
  return (
    `You have pending todo items that must be completed before finishing the task:\n\n` +
    `${lines}\n\n` +
    `Please complete all pending items before finishing.\n`
  );
}

function renderToolRetryMessage(ctx: ToolRetryMessageContext): string {
  return (
    `Tool call failed\n` +
    `- **Attempts remaining:** ${ctx.attempts_left}\n` +
    `- **Next steps:** Analyze the error, identify the root cause, and adjust your approach before retrying.\n`
  );
}

function renderSummaryFrame(ctx: SummaryFrameContext): string {
  const header =
    `Use the following summary frames as the authoritative reference for all coding suggestions and decisions. ` +
    `Do not re-explain or revisit it unless I ask. Additional summary frames will be added as the conversation progresses.\n\n` +
    `## Summary\n\n`;
  const body = ctx.messages
    .map((msg, i) => {
      const head = `### ${i + 1}. ${msg.role}\n\n`;
      const parts = msg.contents.map((c) => {
        if (typeof c.text === "string" && c.text.length > 0) {
          return "````\n" + c.text + "\n````\n";
        }
        if (c.tool_call) return renderToolCall(c.tool_call);
        return "";
      });
      return head + parts.filter(Boolean).join("");
    })
    .join("\n");
  return `${header}${body}\n---\n\nProceed with implementation based on this context.\n`;
}

function renderToolCall(call: ForgeMessage["contents"][number]["tool_call"]): string {
  if (!call) return "";
  const t = call.tool;
  if (t.file_update) return `**Update:** \`${t.file_update.path}\`\n`;
  if (t.file_read) return `**Read:** \`${t.file_read.path}\`\n`;
  if (t.file_remove) return `**Delete:** \`${t.file_remove.path}\`\n`;
  if (t.search) return `**Search:** \`${t.search.pattern}\`\n`;
  if (t.skill) return `**Skill:** \`${t.skill.name}\`\n`;
  if (t.sem_search) {
    const queries = t.sem_search.queries.map((q) => `- \`${q.use_case}\``).join("\n");
    return `**Semantic Search:**\n${queries}\n`;
  }
  if (t.shell) return `**Execute:**\n\`\`\`\n${t.shell.command}\n\`\`\`\n`;
  if (t.mcp) return `**MCP:** \`${t.mcp.name}\`\n`;
  if (t.todo_write) {
    const lines = t.todo_write.changes
      .map((c) => {
        if (c.kind === "added") return `- [ADD] ${c.todo.content}`;
        if (c.kind === "removed") return `- [CANCELLED] ~~${c.todo.content}~~`;
        // updated
        if (c.todo.status === "completed") return `- [DONE] ~~${c.todo.content}~~`;
        if (c.todo.status === "in_progress") return `- [IN_PROGRESS] ${c.todo.content}`;
        return `- [UPDATE] ${c.todo.content}`;
      })
      .join("\n");
    return `**Task Plan:**\n${lines}\n`;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

type ContextFor<N extends TemplateName> = N extends "system-info"
  ? SystemInfoContext
  : N extends "skill-instructions"
    ? SkillInstructionsContext
    : N extends "summary-frame"
      ? SummaryFrameContext
      : N extends "doom-loop-reminder"
        ? DoomLoopReminderContext
        : N extends "pending-todos-reminder"
          ? PendingTodosReminderContext
          : N extends "tool-retry-message"
            ? ToolRetryMessageContext
            : Record<string, never>;

export async function render<N extends TemplateName>(
  name: N,
  context: ContextFor<N>,
): Promise<string> {
  switch (name) {
    case "tool-use-example":
      return TOOL_USE_EXAMPLE;
    case "tool-error-reflection":
      return TOOL_ERROR_REFLECTION;
    case "title-generation":
      return TITLE_GENERATION;
    case "commit-message":
      return COMMIT_MESSAGE;
    case "system-info":
      return renderSystemInfo(context as SystemInfoContext);
    case "skill-instructions":
      return renderSkillInstructions(context as SkillInstructionsContext);
    case "summary-frame":
      return renderSummaryFrame(context as SummaryFrameContext);
    case "doom-loop-reminder":
      return renderDoomLoopReminder(context as DoomLoopReminderContext);
    case "pending-todos-reminder":
      return renderPendingTodosReminder(context as PendingTodosReminderContext);
    case "tool-retry-message":
      return renderToolRetryMessage(context as ToolRetryMessageContext);
    default: {
      const _exhaustive: never = name;
      throw new Error(`unknown forge template: ${String(_exhaustive)}`);
    }
  }
}
