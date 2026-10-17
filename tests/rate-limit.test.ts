import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { classifyFailure, rateLimitRetryDelay, type SingleResult, sleepFor } from "../src/runner.ts";

const result = (overrides: Partial<SingleResult>): SingleResult => ({
  agent: "a",
  agentSource: "bundled",
  task: "t",
  status: "done",
  exitCode: 1,
  messages: [],
  stderr: "",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
  droppedEvents: 0,
  retryNotes: [],
  ...overrides,
});

const assistantError = (errorMessage: string): AssistantMessage => ({
  role: "assistant",
  content: [],
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
  stopReason: "error",
  errorMessage,
  timestamp: 0,
});

describe("classifyFailure", () => {
  it("sees a 429 in the child's stderr", () => {
    expect(classifyFailure(result({ stderr: `429: {"code":429,"message":"rate-limited upstream"}` }))).toBe(
      "rate-limit",
    );
  });

  it("sees a rate limit reported in the last assistant message", () => {
    expect(
      classifyFailure(result({ messages: [assistantError("Provider returned error: upstream rate limit exceeded")] })),
    ).toBe("rate-limit");
  });

  it("reads the last assistant message, not an earlier one", () => {
    expect(
      classifyFailure(
        result({ messages: [assistantError("rate limited"), assistantError("unparseable model output")] }),
      ),
    ).toBe("other");
  });

  it("leaves ordinary failures unclassified", () => {
    expect(classifyFailure(result({ stderr: "panic: something else" }))).toBe("other");
    expect(classifyFailure(result({ exitCode: 0 }))).toBe("other");
  });
});

describe("rateLimitRetryDelay", () => {
  const rateLimited = result({ stderr: "429: rate-limited upstream" });

  it("waits on a failed rate-limited run, inside the first window", () => {
    const delay = rateLimitRetryDelay(0, rateLimited);
    expect(delay).toBeGreaterThanOrEqual(2500);
    expect(delay).toBeLessThan(5000);
  });

  it("escalates the window with each attempt", () => {
    const d1 = rateLimitRetryDelay(1, rateLimited);
    const d2 = rateLimitRetryDelay(2, rateLimited);
    expect(d1).toBeGreaterThanOrEqual(7500);
    expect(d1).toBeLessThan(15000);
    expect(d2).toBeGreaterThanOrEqual(22500);
    expect(d2).toBeLessThan(45000);
  });

  it("stops after the last retry", () => {
    expect(rateLimitRetryDelay(3, rateLimited)).toBeUndefined();
  });

  it("honors Retry-After with the conventional bare-seconds form", () => {
    expect(rateLimitRetryDelay(0, result({ stderr: "429: rate-limited. Retry-After: 30" }))).toBe(30000);
    expect(rateLimitRetryDelay(0, result({ stderr: "429: rate-limited. Retry-After: 30s" }))).toBe(30000);
  });

  it("takes the last Retry-After when several appear", () => {
    expect(
      rateLimitRetryDelay(0, result({ stderr: "Retry-After: 10\n429: rate-limited upstream. Retry-After: 40" })),
    ).toBe(40000);
  });

  it("falls back to the schedule when Retry-After is unusable", () => {
    const delay = rateLimitRetryDelay(0, result({ stderr: "429: rate-limited. Retry-After: 3600s" }));
    expect(delay).toBeGreaterThanOrEqual(2500);
    expect(delay).toBeLessThan(5000);
  });

  it("never retries an aborted run", () => {
    expect(rateLimitRetryDelay(0, { ...rateLimited, stopReason: "aborted" })).toBeUndefined();
  });

  it("never retries a run that did not fail", () => {
    expect(rateLimitRetryDelay(0, { ...rateLimited, exitCode: 0 })).toBeUndefined();
  });

  it("never retries a failure that is not a rate limit", () => {
    expect(rateLimitRetryDelay(0, result({ stderr: "panic: something else" }))).toBeUndefined();
  });

  it("does not let an earlier attempt's 429 retry a later unrelated crash", () => {
    // The loop classifies against currentResult.stderr.slice(base); a result
    // whose full stderr carries attempt 1's 429 must not retry attempt 2's crash.
    const accumulated = result({ stderr: "429: rate-limited upstream\npanic: auth failure" });
    const scoped = { ...accumulated, stderr: accumulated.stderr.slice("429: rate-limited upstream\n".length) };
    expect(classifyFailure(scoped)).toBe("other");
    expect(rateLimitRetryDelay(1, scoped)).toBeUndefined();
  });
});

describe("sleepFor", () => {
  it("resolves immediately on an already-fired abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleepFor(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("resolves early on an abort that lands mid-sleep", async () => {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 30);
    await sleepFor(60_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("waits out the delay when nothing aborts", async () => {
    const started = Date.now();
    await sleepFor(40, undefined);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });
});
