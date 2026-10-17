import { describe, expect, it } from "vitest";
import { verifyPanelModel } from "../src/gate.ts";
import { assertExactPanelModel, type PanelModelCandidate, PanelModelOverrides } from "../src/panel-model.ts";
import { buildModelOptions, CLEAR_MODEL_VALUE, toReviewModelChoice } from "../src/review-model-picker.ts";

const candidate = (provider: string, id: string, name?: string): PanelModelCandidate => ({
  provider,
  id,
  ...(name !== undefined ? { name } : {}),
});

const registry = [
  candidate("openrouter", "~deepseek/deepseek-flash-latest"),
  candidate("openrouter", "~anthropic/claude-fable-latest", "Claude Fable"),
  candidate("hyperqwen", "qwen3.8"),
];

describe("assertExactPanelModel", () => {
  it("accepts an exact registry entry and returns its canonical casing", () => {
    expect(assertExactPanelModel("openrouter/~deepseek/deepseek-flash-latest", registry)).toBe(
      "openrouter/~deepseek/deepseek-flash-latest",
    );
  });

  it("resolves case-insensitively to the registry's canonical provider/id", () => {
    expect(assertExactPanelModel("OpenRouter/~DeepSeek/DeepSeek-Flash-Latest", registry)).toBe(
      "openrouter/~deepseek/deepseek-flash-latest",
    );
  });

  it("accepts a custom id on a known provider, canonically cased and sent to the provider verbatim", () => {
    expect(assertExactPanelModel("openrouter/deepseek/deepseek-v4.1-flash-1017", registry)).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash-1017",
    );
    expect(assertExactPanelModel("OpenRouter/deepseek/deepseek-v4.1-flash-1017", registry)).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash-1017",
    );
  });

  it("keeps colon-bearing ids, which pi treats as exact ids unless the suffix is a thinking level", () => {
    expect(assertExactPanelModel("openrouter/google/gemma-4-26b-a4b-it:free", registry)).toBe(
      "openrouter/google/gemma-4-26b-a4b-it:free",
    );
  });

  it("rejects a pattern pi would resolve by substring match within the provider", () => {
    expect(() => assertExactPanelModel("openrouter/deepseek-flash", registry)).toThrow(
      /fuzzy match would run "openrouter\/~deepseek\/deepseek-flash-latest"/,
    );
  });

  it("rejects a pattern pi would resolve by name match within the provider", () => {
    expect(() => assertExactPanelModel("openrouter/claude-fable", registry)).toThrow(/fuzzy match would run/);
  });

  it("rejects a pattern whose full string is a substring of another provider's id", () => {
    // pi's second fuzzy pass matches the whole configured string against every
    // registry id, catching ids that begin with a provider name.
    const gateway = [...registry, candidate("gateway", "openrouter/deepseek/deepseek-v4.1-flash")];
    expect(() => assertExactPanelModel("openrouter/deepseek/deepseek-v4.1", gateway)).toThrow(
      /fuzzy match would run "gateway\/openrouter\/deepseek\/deepseek-v4\.1-flash"/,
    );
  });

  it("rejects a configured string that equals some model's bare id", () => {
    const gateway = [...registry, candidate("gateway", "openrouter/qwen3.8")];
    expect(() => assertExactPanelModel("openrouter/qwen3.8", gateway)).toThrow(
      /would run gateway\/openrouter\/qwen3.8/,
    );
  });

  it("rejects a provider the registry has never heard of", () => {
    expect(() => assertExactPanelModel("nosuch/model-id", registry)).toThrow(
      /provider "nosuch" is not in the registry/,
    );
  });

  it("rejects an ambiguous registry entry", () => {
    expect(() => assertExactPanelModel("dup/model", [candidate("dup", "model"), candidate("dup", "model")])).toThrow(
      /ambiguous/,
    );
  });
});

describe("verifyPanelModel", () => {
  it("passes when the child reports the canonical provider/id", () => {
    expect(
      verifyPanelModel("openrouter/deepseek/deepseek-v4.1-flash-1017", {
        model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
        reportedModel: "openrouter/deepseek/deepseek-v4.1-flash-1017",
      }),
    ).toBeUndefined();
  });

  it("fails when the child reports a different model", () => {
    expect(
      verifyPanelModel("openrouter/deepseek/deepseek-v4.1-flash-1017", {
        model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
        reportedModel: "openrouter/~deepseek/deepseek-flash-latest",
      }),
    ).toContain("reports it ran on openrouter/~deepseek/deepseek-flash-latest");
  });

  it("fails when the child never reports a model at all", () => {
    expect(
      verifyPanelModel("openrouter/deepseek/deepseek-v4.1-flash-1017", {
        model: "openrouter/deepseek/deepseek-v4.1-flash-1017",
        reportedModel: undefined,
      }),
    ).toContain("could not be confirmed");
  });

  it("does not apply to a member running on its own or the session's model", () => {
    expect(
      verifyPanelModel("openrouter/deepseek/deepseek-v4.1-flash-1017", {
        model: "other-provider/own-model",
        reportedModel: "other-provider/own-model",
      }),
    ).toBeUndefined();
  });
});

describe("PanelModelOverrides", () => {
  const overrides = () => new PanelModelOverrides(3);

  it("lets the session override win over the configured model", () => {
    const store = overrides();
    expect(store.resolve("s1", "prov/configured")).toBe("prov/configured");
    store.set("s1", "prov/override");
    expect(store.resolve("s1", "prov/configured")).toBe("prov/override");
  });

  it("falls back to the configured model after clearing", () => {
    const store = overrides();
    store.set("s1", "prov/override");
    store.clear("s1");
    expect(store.resolve("s1", "prov/configured")).toBe("prov/configured");
  });

  it("keeps sessions isolated from each other", () => {
    const store = overrides();
    store.set("s1", "prov/one");
    expect(store.resolve("s2", "prov/configured")).toBe("prov/configured");
    expect(store.resolve("s1", "prov/configured")).toBe("prov/one");
  });

  it("evicts the oldest session past the bound", () => {
    const store = overrides();
    store.set("s1", "prov/one");
    store.set("s2", "prov/two");
    store.set("s3", "prov/three");
    store.set("s4", "prov/four");
    expect(store.resolve("s1", undefined)).toBeUndefined();
    expect(store.resolve("s4", undefined)).toBe("prov/four");
  });

  it("re-settling a session refreshes without evicting it", () => {
    const store = overrides();
    store.set("s1", "prov/one");
    store.set("s2", "prov/two");
    store.set("s3", "prov/three");
    store.set("s1", "prov/one-b");
    store.set("s4", "prov/four");
    expect(store.resolve("s1", undefined)).toBe("prov/one-b");
  });
});

describe("review-model picker mapping", () => {
  it("maps the clear entry to a clear choice", () => {
    expect(toReviewModelChoice(CLEAR_MODEL_VALUE)).toEqual({ kind: "clear" });
  });

  it("maps a registry pick to its provider/id", () => {
    expect(toReviewModelChoice("openrouter/deepseek/deepseek-v4.1-flash-1017")).toEqual({
      kind: "model",
      value: "openrouter/deepseek/deepseek-v4.1-flash-1017",
    });
  });

  it("builds canonical options and omits names that repeat the id", () => {
    const options = buildModelOptions([
      { provider: "openrouter", id: "deepseek/deepseek-v4.1-flash-1017" },
      { provider: "hyperqwen", id: "qwen3.8", name: "qwen3.8" },
      { provider: "hyperqwen", id: "qwen3.8-pro", name: "Qwen Pro" },
    ]);
    expect(options).toEqual([
      { value: "openrouter/deepseek/deepseek-v4.1-flash-1017", label: "openrouter/deepseek/deepseek-v4.1-flash-1017" },
      { value: "hyperqwen/qwen3.8", label: "hyperqwen/qwen3.8" },
      { value: "hyperqwen/qwen3.8-pro", label: "hyperqwen/qwen3.8-pro", description: "Qwen Pro" },
    ]);
  });
});
