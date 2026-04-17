/**
 * Pending-todos reminder — TS port of
 * `forge_app::hooks::pending_todos::PendingTodosHandler`.
 *
 * Tracks the most recent todo snapshot per session (via opencode's
 * `todo.updated` event) and, when the session goes idle while todos are still
 * in `pending` or `in_progress` state, renders a reminder using the
 * `pending-todos-reminder` template so the agent re-engages instead of
 * stopping early.
 *
 * The forgecode implementation de-duplicates reminders by comparing todo-id
 * sets; we mirror that here.
 */

import { render } from "./templates";
import type { ForgePendingTodo } from "./types";

export class PendingTodosTracker {
  private readonly perSession = new Map<string, ForgePendingTodo[]>();
  private readonly lastReminderKey = new Map<string, string>();

  update(sessionId: string, todos: ForgePendingTodo[]): void {
    this.perSession.set(sessionId, todos);
  }

  pending(sessionId: string): ForgePendingTodo[] {
    const list = this.perSession.get(sessionId) ?? [];
    return list.filter((t) => t.status === "pending" || t.status === "in_progress");
  }

  reset(sessionId: string): void {
    this.perSession.delete(sessionId);
    this.lastReminderKey.delete(sessionId);
  }

  /**
   * Returns the rendered reminder, or null when there is nothing new to
   * remind about (same set of pending todos already reminded).
   */
  async buildReminder(sessionId: string): Promise<string | null> {
    const pending = this.pending(sessionId);
    if (pending.length === 0) return null;
    const key = pending
      .map((t) => `${t.status}:${t.content}`)
      .sort()
      .join("\n");
    if (this.lastReminderKey.get(sessionId) === key) return null;
    this.lastReminderKey.set(sessionId, key);
    return render("pending-todos-reminder", { todos: pending });
  }
}
