import { describe, expect, it } from "vitest";
import { buildDispatch, type DispatchHost } from "../src/runner.ts";
import { Semaphore } from "../src/semaphore.ts";

const host: DispatchHost = {
  model: { provider: "session-provider", id: "session-model" },
  thinkingLevel: "high",
};

describe("buildDispatch", () => {
  it("hands subagents the session's model and thinking level", () => {
    const dispatch = buildDispatch(host, new Semaphore(1));
    expect(dispatch.model).toBe("session-provider/session-model");
    expect(dispatch.thinkingLevel).toBe("high");
  });

  it("replaces the session's model with a panel model, dropping its thinking level", () => {
    const dispatch = buildDispatch(host, new Semaphore(1), "other-provider/other/model");
    expect(dispatch.model).toBe("other-provider/other/model");
    expect(dispatch.thinkingLevel).toBeUndefined();
  });
});
