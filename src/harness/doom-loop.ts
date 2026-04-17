/**
 * Doom-loop detector — TS port of `forge_app::hooks::doom_loop::DoomLoopDetector`.
 *
 * Tracks tool call signatures per opencode session and triggers a reminder
 * when a repeating pattern dominates the tail of the sequence.
 *
 * Detects two shapes of loop (both in `checkRepeatingPattern`):
 *   - [A,A,A,A]          → pattern length 1 repeated threshold times
 *   - [A,B,C,A,B,C,A,B,C]→ pattern length 3 repeated threshold times
 */

import { render } from "./templates";

const DEFAULT_THRESHOLD = 3;

export interface ToolSignature {
  name: string;
  argsHash: string;
}

export class DoomLoopDetector {
  private readonly perSession = new Map<string, ToolSignature[]>();
  private readonly alreadyWarned = new Set<string>();

  constructor(private readonly threshold: number = DEFAULT_THRESHOLD) {}

  record(sessionId: string, signature: ToolSignature): void {
    const list = this.perSession.get(sessionId) ?? [];
    list.push(signature);
    // keep last 64 entries to cap memory
    if (list.length > 64) list.shift();
    this.perSession.set(sessionId, list);
  }

  reset(sessionId: string): void {
    this.perSession.delete(sessionId);
    this.alreadyWarned.delete(sessionId);
  }

  /**
   * Returns the number of consecutive pattern repetitions at the tail when a
   * loop is detected, otherwise null. Matches the forgecode Rust algorithm.
   */
  detect(sessionId: string): number | null {
    const seq = this.perSession.get(sessionId);
    if (!seq || seq.length < this.threshold) return null;
    for (let patternLen = 1; patternLen < seq.length; patternLen++) {
      const reps = this.countRecentRepetitions(seq, patternLen);
      if (reps >= this.threshold) return reps;
    }
    return null;
  }

  private countRecentRepetitions(seq: ToolSignature[], patternLen: number): number {
    if (patternLen === 0 || seq.length < patternLen * 2) return 0;
    const tailStart = seq.length - patternLen;
    const pattern = seq.slice(tailStart);
    let reps = 1;
    let cursor = tailStart - patternLen;
    while (cursor >= 0) {
      const candidate = seq.slice(cursor, cursor + patternLen);
      if (!sigEq(candidate, pattern)) break;
      reps++;
      cursor -= patternLen;
    }
    return reps;
  }

  async reminder(count: number): Promise<string> {
    return render("doom-loop-reminder", { consecutive_calls: count });
  }

  hasWarned(sessionId: string): boolean {
    return this.alreadyWarned.has(sessionId);
  }

  markWarned(sessionId: string): void {
    this.alreadyWarned.add(sessionId);
  }
}

function sigEq(a: ToolSignature[], b: ToolSignature[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].name !== b[i].name || a[i].argsHash !== b[i].argsHash) return false;
  }
  return true;
}

export function signatureOf(name: string, args: unknown): ToolSignature {
  let argsHash: string;
  try {
    argsHash = JSON.stringify(args ?? {});
  } catch {
    argsHash = "<unserialisable>";
  }
  return { name, argsHash };
}
