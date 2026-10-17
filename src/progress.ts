/**
 * The live panel readout: pure builders that turn partial `SingleResult`s into
 * the state a TUI widget (or a collapsed tool row) renders while the panel
 * runs. No component code lives here — the widget maps these structures to
 * themed lines; keeping the assembly pure is what makes it testable.
 */

import type { Message } from "@earendil-works/pi-ai";
import type { SingleResult, UsageStats } from "./runner.ts";

export type MemberState =
  | "pending"
  | "waiting"
  | "running"
  | "retrying"
  | "cached"
  | "proceed"
  | "block"
  | "incomplete"
  | "failed"
  | "moderated";

export interface MemberProgress {
  name: string;
  state: MemberState;
  /** One-line summary: verdict counts or the retry note; composed for live members. */
  detail: string;
  /** Latest tool calls / text, most recent first. */
  lastLines: string[];
  model?: string | undefined;
  usage?: UsageStats | undefined;
  /** Date.now() when this member's dispatch began, for its elapsed clock. */
  startedAt?: number | undefined;
}

export interface PanelProgress {
  phase: "running";
  members: MemberProgress[];
  /** Date.now() when the run started; the widget ticks elapsed against it. */
  startedAt: number;
}

export function stateForResult(result: Pick<SingleResult, "status" | "retryNotes">): MemberState {
  if (result.status === "running") return "running";
  if (result.status === "queued") return result.retryNotes.length > 0 ? "retrying" : "waiting";
  // A settled result is displayed as running until the panel records its
  // verdict, which happens in the same tick that produced it.
  return "running";
}

/** The last `count` tool calls and text lines, most recent first. */
export function lastActivityLines(messages: readonly Message[], count: number): string[] {
  const lines: string[] = [];
  for (let i = messages.length - 1; i >= 0 && lines.length < count; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (let j = message.content.length - 1; j >= 0 && lines.length < count; j -= 1) {
      const part = message.content[j];
      if (part.type === "toolCall") {
        lines.push(`→ ${part.name}(${truncate(JSON.stringify(part.arguments), 60)})`);
      } else if (part.type === "text") {
        const firstLine = part.text.trim().split("\n", 1)[0] ?? "";
        if (firstLine !== "") lines.push(truncate(firstLine, 100));
      }
    }
  }
  return lines;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Activity lines per running member: header and settled rows take their fixed
 * share of the budget first, the rest splits across what is alive.
 */
export function activityBudget(total: number, running: number, budget = 24): number {
  const fixed = 2 + Math.max(0, total - running);
  const remaining = Math.max(0, budget - fixed);
  return Math.min(4, Math.max(1, Math.floor(remaining / Math.max(1, running)) - 1));
}

/** `↑in ↓out R cacheRead W cacheWrite`, zero components omitted. */
export function usageLine(usage: UsageStats): string {
  return [
    usage.input > 0 ? `↑${formatTokens(usage.input)}` : "",
    usage.output > 0 ? `↓${formatTokens(usage.output)}` : "",
    usage.cacheRead > 0 ? `R${formatTokens(usage.cacheRead)}` : "",
    usage.cacheWrite > 0 ? `W${formatTokens(usage.cacheWrite)}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

const STATE_ICONS: Record<MemberState, string> = {
  pending: "·",
  waiting: "⏸",
  running: "⏳",
  retrying: "↻",
  cached: "✓",
  proceed: "✓",
  block: "✗",
  incomplete: "⚠",
  failed: "✗",
  moderated: "✓",
};

const STATE_ROLES = {
  pending: "muted",
  waiting: "muted",
  running: "active",
  retrying: "warning",
  cached: "muted",
  proceed: "ok",
  block: "error",
  incomplete: "warning",
  failed: "error",
  moderated: "ok",
} as const;

export type LineRole = (typeof STATE_ROLES)[MemberState] | "header" | "detail";

export interface ProgressLine {
  text: string;
  role: LineRole;
}

/**
 * The full widget body. Settled and cached members collapse to one line; the
 * activity budget goes to what is alive. `now` is injected so the caller's
 * local clock tick drives the elapsed display.
 */
export function renderProgress(progress: PanelProgress, now: number, collapsed: boolean): ProgressLine[] {
  const running = progress.members.filter((m) => m.state === "running").length;
  const done = progress.members.filter(
    (m) => m.state !== "pending" && m.state !== "waiting" && m.state !== "running" && m.state !== "retrying",
  ).length;
  const lines: ProgressLine[] = [];
  const elapsed = formatElapsed(now - progress.startedAt);
  const cost = progress.members.reduce((sum, m) => sum + (m.usage?.cost ?? 0), 0);
  lines.push({
    text: `panel · ${done}/${progress.members.length} done · ${running} running · ${elapsed}${cost > 0 ? ` · $${cost.toFixed(4)}` : ""}`,
    role: "header",
  });

  const budget = collapsed ? 0 : activityBudget(progress.members.length, running);
  for (const member of progress.members) {
    const icon = STATE_ICONS[member.state];
    const role = STATE_ROLES[member.state] as LineRole;
    const detail =
      member.detail !== ""
        ? member.detail
        : member.state === "running" || member.state === "retrying"
          ? liveDetail(member, now)
          : "";
    lines.push({ text: `${icon} ${member.name}${detail === "" ? "" : `  ${detail}`}`, role });
    const alive = member.state === "running" || member.state === "retrying";
    if (alive && !collapsed) {
      const shown = member.lastLines.slice(0, budget);
      for (const line of shown) lines.push({ text: `   ${line}`, role: "detail" });
    }
  }
  return lines;
}

function liveDetail(member: MemberProgress, now: number): string {
  const model = member.model === undefined ? "" : truncate(member.model, 28);
  const elapsed = member.startedAt === undefined ? "" : formatElapsed(now - member.startedAt);
  const usage = member.usage === undefined ? "" : usageLine(member.usage);
  return [model, elapsed, usage].filter(Boolean).join(" · ");
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}
