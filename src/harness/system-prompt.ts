/**
 * Helpers to build forge-style system-prompt fragments.
 *
 * opencode's agent-markdown mechanism already delivers the primary system
 * prompt to the LLM, so the plugin does not need to replace it wholesale.
 * What we do provide is a renderer for the **partial** templates that forge
 * agents historically embedded (`forge-partial-system-info.md`,
 * `forge-partial-skill-instructions.md`, `forge-partial-tool-use-example.md`,
 * `forge-partial-tool-error-reflection.md`). Agent markdown files under
 * `agents/` use the same Handlebars syntax and can import these partials by
 * name at install time if the user wants the full forge harness parity.
 */

import { platform, homedir } from "node:os";
import { render } from "./templates";
import type { ForgeEnv, ForgeSkill } from "./types";

export function currentEnv(cwd: string): ForgeEnv {
  return {
    os: platform(),
    cwd,
    shell: process.env.SHELL ?? "/bin/sh",
    home: homedir(),
  };
}

export async function systemInfo(cwd: string): Promise<string> {
  return render("system-info", { env: currentEnv(cwd) });
}

export async function skillInstructions(skills: ForgeSkill[]): Promise<string> {
  return render("skill-instructions", { skills });
}

export async function toolErrorReflection(): Promise<string> {
  return render("tool-error-reflection", {});
}
