import type { AgentRole, AgentDefinition } from "./types";
import { forgeAgent } from "./forge";
import { museAgent } from "./muse";
import { sageAgent } from "./sage";

export const agents: Record<AgentRole, AgentDefinition> = {
  forge: forgeAgent,
  muse: museAgent,
  sage: sageAgent,
};

export { type AgentRole, type AgentDefinition, type AgentConfig } from "./types";
