import { describe, test, expect } from "bun:test";
import { museAgent } from "../src/agents/muse";
import { forgeAgent } from "../src/agents/forge";
import { sageAgent } from "../src/agents/sage";

describe("Agent definitions", () => {
  describe("metadata stability", () => {
    test("muse agent has stable metadata", () => {
      expect(museAgent.role).toBe("muse");
      expect(museAgent.id).toBe("opencode-muse");
      expect(museAgent.displayName).toBe("muse");
      expect(museAgent.mode).toBe("primary");
    });

    test("forge agent has stable metadata", () => {
      expect(forgeAgent.role).toBe("forge");
      expect(forgeAgent.id).toBe("opencode-forge");
      expect(forgeAgent.displayName).toBe("forge");
      expect(forgeAgent.mode).toBe("primary");
    });

    test("sage agent has stable metadata", () => {
      expect(sageAgent.role).toBe("sage");
      expect(sageAgent.id).toBe("opencode-sage");
      expect(sageAgent.displayName).toBe("sage");
      expect(sageAgent.mode).toBe("subagent");
      expect(sageAgent.temperature).toBe(0.0);
    });

    test("sage agent has expected tool exclusions", () => {
      expect(sageAgent.tools?.exclude).toBeDefined();
      expect(sageAgent.tools?.exclude).toContain("plan-execute");
      expect(sageAgent.tools?.exclude).toContain("loop");
    });

    test("forge agent has expected tool exclusions", () => {
      expect(forgeAgent.tools?.exclude).toBeDefined();
      expect(forgeAgent.tools?.exclude).toContain("review-delete");
      expect(forgeAgent.tools?.exclude).toContain("plan-execute");
    });
  });

  describe("graph-first policy in system prompts", () => {
    test("muse prompt names graph tools", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("graph-query");
      expect(prompt).toContain("graph-symbols");
      expect(prompt).toContain("graph-analyze");
    });

    test("forge prompt names three graph tools", () => {
      const prompt = forgeAgent.systemPrompt;
      expect(prompt).toContain("graph-query");
      expect(prompt).toContain("graph-symbols");
      expect(prompt).toContain("graph-analyze");
      expect(prompt).not.toContain("graph-status");
    });

    test("sage prompt names graph tools", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toContain("graph-query");
      expect(prompt).toContain("graph-symbols");
      expect(prompt).toContain("graph-analyze");
    });

    test("muse prompt expresses graph-first discovery semantics", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toMatch(/graph.*first|start.*graph|graph.*readiness/i);
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i);
    });

    test("forge prompt expresses graph-first discovery semantics", () => {
      const prompt = forgeAgent.systemPrompt;
      expect(prompt).toMatch(/graph.*first|start.*graph|graph.*readiness/i);
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i);
    });

    test("sage prompt expresses graph-first discovery semantics", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toMatch(/graph.*first|start.*graph|graph.*readiness/i);
      expect(prompt).toMatch(/fallback.*glob.*grep|glob.*grep.*fallback/i);
    });

    test("muse prompt does not restrict graph tools to narrow scenarios", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toMatch(
        /use whichever graph tool|whichever graph tool best fits|as appropriate/i,
      );
    });

    test("forge prompt does not restrict graph tools to narrow scenarios", () => {
      const prompt = forgeAgent.systemPrompt;
      expect(prompt).toMatch(
        /use whichever graph tool|whichever graph tool best fits|as appropriate/i,
      );
    });

    test("sage prompt does not restrict graph tools to narrow scenarios", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toMatch(
        /use whichever graph tool|whichever graph tool best fits|as appropriate/i,
      );
    });

    test("muse prompt mentions blast_radius for impact analysis", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("blast_radius");
    });

    test("forge prompt mentions callers and callees", () => {
      const prompt = forgeAgent.systemPrompt;
      expect(prompt).toContain("callers");
      expect(prompt).toContain("callees");
    });

    test("sage prompt mentions blast_radius and dependency tracing", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toContain("blast_radius");
      expect(prompt).toMatch(/dependency.*relationship|file_deps|file_dependents/i);
    });

    test("muse prompt includes all four canonical approval options", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain('"New session"');
      expect(prompt).toContain('"Execute here"');
      expect(prompt).toContain('"Loop (worktree)"');
      expect(prompt).toContain('"Loop"');
    });

    test("muse prompt includes pre-plan checkpoint instructions", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("Pre-plan checkpoint");
      expect(prompt).toContain("findings/next-steps summary");
      expect(prompt).toContain(
        "Do NOT call `plan-write` until the user has approved writing the plan",
      );
    });

    test("muse prompt requires detailed self-contained plans", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("detailed, self-contained, and implementation-ready");
      expect(prompt).toContain("Concrete file targets");
      expect(prompt).toContain("Intended edits per file");
      expect(prompt).toContain("Specific integration points");
      expect(prompt).toContain("Explicit test targets");
      expect(prompt).toContain("Phase acceptance criteria");
    });

    test("muse prompt includes pre-plan approval section", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("## Pre-plan approval");
      expect(prompt).toContain("present a brief findings/next-steps summary");
      expect(prompt).toContain("Should I write the implementation plan?");
    });
  });

  describe("sage dual-mode research/review", () => {
    test("sage prompt has mode selection branching", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toContain("Mode Selection");
      expect(prompt).toContain("Review mode");
      expect(prompt).toContain("Research mode");
    });

    test("sage prompt contains research workflow structure", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toContain("Research Workflow");
      expect(prompt).toContain("Investigation Methodology");
      expect(prompt).toContain("Research Response Structure");
    });

    test("sage prompt contains code review workflow", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toContain("Code Review Workflow");
      expect(prompt).toContain("review-read");
      expect(prompt).toContain("review-write");
    });
  });

  describe("harness tone from forgecode.dev agents", () => {
    test("forge prompt includes Core Principles", () => {
      const prompt = forgeAgent.systemPrompt;
      expect(prompt).toContain("Core Principles");
      expect(prompt).toContain("Grounded in Reality");
    });

    test("forge prompt includes Implementation Methodology", () => {
      const prompt = forgeAgent.systemPrompt;
      expect(prompt).toContain("Implementation Methodology");
    });

    test("muse prompt includes Core Principles with checkbox formatting", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("Core Principles");
      expect(prompt).toContain("Checkbox Formatting");
    });

    test("muse prompt includes risks and alternative approaches", () => {
      const prompt = museAgent.systemPrompt;
      expect(prompt).toContain("Potential Risks and Mitigations");
      expect(prompt).toContain("Alternative Approaches");
    });

    test("sage prompt includes Core Principles", () => {
      const prompt = sageAgent.systemPrompt;
      expect(prompt).toContain("Core Principles");
      expect(prompt).toContain("Read-Only Investigation");
    });
  });
});
