import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  activityBudget,
  lastActivityLines,
  type MemberProgress,
  type PanelProgress,
  renderProgress,
  stateForResult,
  usageLine,
} from "../src/progress.ts";

const assistant = (parts: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content: parts,
  api: "openai-completions",
  provider: "test",
  model: "m",
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: 0,
});

describe("stateForResult", () => {
  it("maps running and queued states, retrying from the notes", () => {
    expect(stateForResult({ status: "running", retryNotes: [] })).toBe("running");
    expect(stateForResult({ status: "queued", retryNotes: [] })).toBe("waiting");
    expect(stateForResult({ status: "queued", retryNotes: ["retrying (attempt 2 of 4) after 15s"] })).toBe("retrying");
  });
});

describe("lastActivityLines", () => {
  const toolCall = { type: "toolCall" as const, id: "1", name: "read", arguments: { path: "src/gate.ts" } };
  const text = { type: "text" as const, text: "Checking the spec hash\nsecond line ignored" };

  it("collects tool calls and text, most recent first", () => {
    const messages = [assistant([toolCall]), assistant([text]), assistant([{ ...toolCall, id: "2", name: "bash" }])];
    expect(lastActivityLines(messages, 3)).toEqual([
      '→ bash({"path":"src/gate.ts"})',
      "Checking the spec hash",
      '→ read({"path":"src/gate.ts"})',
    ]);
  });

  it("caps at the requested count", () => {
    const messages = [assistant([toolCall]), assistant([{ ...toolCall, id: "2" }])];
    expect(lastActivityLines(messages, 1)).toHaveLength(1);
  });

  it("skips empty text", () => {
    expect(lastActivityLines([assistant([{ type: "text", text: "  " }])], 2)).toEqual([]);
  });
});

describe("activityBudget", () => {
  it("gives the remainder to running members, clamped 1..4", () => {
    expect(activityBudget(5, 1)).toBe(4);
    const forThree = activityBudget(5, 3);
    expect(forThree).toBeLessThanOrEqual(4);
    expect(forThree).toBeGreaterThanOrEqual(1);
  });
});

describe("usageLine", () => {
  const usage = (over: Partial<Parameters<typeof usageLine>[0]>) => ({
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
    ...over,
  });

  it("formats directional components and omits zeros", () => {
    expect(usageLine(usage({ input: 264_000, output: 59_000, cacheRead: 5_400_000 }))).toBe("↑264k ↓59k R5.4M");
    expect(usageLine(usage({}))).toBe("");
    expect(usageLine(usage({ cacheWrite: 1_500 }))).toBe("W1.5k");
  });
});

const member = (over: Partial<MemberProgress> & { name: string }): MemberProgress => ({
  state: "pending",
  detail: "",
  lastLines: [],
  ...over,
});

const progress = (members: MemberProgress[]): PanelProgress => ({
  phase: "running",
  members,
  startedAt: 1_000_000,
});

describe("renderProgress", () => {
  const now = 1_060_000;

  it("shows the header with done/running counts and elapsed", () => {
    const lines = renderProgress(
      progress([
        member({ name: "a", state: "proceed", detail: "PROCEED · 0 finding(s) · 2 cleared" }),
        member({ name: "b", state: "running", model: "prov/model", usage: usage({}) }),
        member({ name: "mod", state: "pending" }),
      ]),
      now,
      false,
    );
    expect(lines[0].text).toContain("panel · 1/3 done · 1 running · 1m00s");
    expect(lines[0].role).toBe("header");
  });

  it("collapses terminal members to one line and expands running ones", () => {
    const lines = renderProgress(
      progress([
        member({ name: "a", state: "cached", detail: "cached" }),
        member({
          name: "b",
          state: "running",
          model: "prov/model",
          startedAt: 1_030_000,
          usage: usage({}),
          lastLines: ["→ read(src/gate.ts)", "→ bash(rg specHash)"],
        }),
      ]),
      now,
      false,
    );
    const bLine = lines.find((l) => l.text.startsWith("⏳ b"));
    expect(bLine).toBeDefined();
    expect(bLine?.text).toContain("30s");
    expect(lines.filter((l) => l.role === "detail").map((l) => l.text.trimStart())).toEqual([
      "→ read(src/gate.ts)",
      "→ bash(rg specHash)",
    ]);
  });

  it("shows the retry note on a retrying member", () => {
    const lines = renderProgress(
      progress([
        member({
          name: "a",
          state: "retrying",
          detail: "rate-limited by the provider; retrying (attempt 2 of 4) after 15s",
        }),
      ]),
      now,
      false,
    );
    expect(lines[1].text).toContain("↻ a");
    expect(lines[1].text).toContain("attempt 2 of 4");
    expect(lines[1].role).toBe("warning");
  });

  it("drops activity lines in collapsed mode", () => {
    const lines = renderProgress(
      progress([member({ name: "b", state: "running", lastLines: ["→ read(x)"] })]),
      now,
      true,
    );
    expect(lines.filter((l) => l.role === "detail")).toHaveLength(0);
  });
});

function usage(over: Partial<Parameters<typeof usageLine>[0]>): Parameters<typeof usageLine>[0] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0, ...over };
}
