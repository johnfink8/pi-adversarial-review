import { describe, expect, it } from "vitest";
import { assertExactPanelModel, type PanelModelCandidate } from "../src/panel-model.ts";

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
