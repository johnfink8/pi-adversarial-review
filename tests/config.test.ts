import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MAX_CONCURRENCY, loadConfig } from "../src/config.ts";

const configPath = () => path.join(getAgentDir(), "review-gate.json");

afterEach(() => {
  fs.rmSync(configPath(), { force: true });
});

describe("loadConfig", () => {
  it("defaults when the file is absent", () => {
    expect(loadConfig()).toEqual({ maxConcurrency: DEFAULT_MAX_CONCURRENCY });
  });

  it("reads maxConcurrency", () => {
    fs.writeFileSync(configPath(), '{ "maxConcurrency": 1 }');
    expect(loadConfig()).toEqual({ maxConcurrency: 1 });
  });

  it("reads model, keeping the default concurrency", () => {
    fs.writeFileSync(configPath(), '{ "model": "openrouter/qwen/qwen3.8-27b" }');
    expect(loadConfig()).toEqual({ maxConcurrency: DEFAULT_MAX_CONCURRENCY, model: "openrouter/qwen/qwen3.8-27b" });
  });

  it("reads a colon-bearing model id", () => {
    fs.writeFileSync(configPath(), '{ "model": "openrouter/google/gemma-4-26b-a4b-it:free" }');
    expect(loadConfig()).toEqual({
      maxConcurrency: DEFAULT_MAX_CONCURRENCY,
      model: "openrouter/google/gemma-4-26b-a4b-it:free",
    });
  });

  it("treats an empty object as all defaults", () => {
    fs.writeFileSync(configPath(), "{}");
    expect(loadConfig()).toEqual({ maxConcurrency: DEFAULT_MAX_CONCURRENCY });
  });

  it.each([
    ["out of range", '{ "maxConcurrency": 0 }', /must be an integer from 1 to 8/],
    ["not an integer", '{ "maxConcurrency": 2.5 }', /must be an integer from 1 to 8/],
    ["a null maxConcurrency", '{ "maxConcurrency": null }', /must be an integer from 1 to 8/],
    ["a model without a provider", '{ "model": "qwen3.8-27b" }', /must be a "provider\/id" string/],
    ["an empty model", '{ "model": "" }', /must be a "provider\/id" string/],
    ["a non-string model", '{ "model": 7 }', /must be a "provider\/id" string/],
    [
      "a model ending in a thinking level",
      '{ "model": "openrouter/qwen3.8-27b:high" }',
      /must not end in a thinking level/,
    ],
    ["a model with an empty segment", '{ "model": "openrouter//qwen" }', /must be a "provider\/id" string/],
    ["a model with a trailing slash", '{ "model": "openrouter/qwen/" }', /must be a "provider\/id" string/],
    ["an unknown key", '{ "maxConcurrency": 2, "lanes": [] }', /Unknown key\(s\).*lanes/],
    ["invalid JSON", "{ nope", /Invalid JSON/],
    ["not an object", "[]", /must contain a JSON object/],
  ])("fails loud on %s", (_label, text, error) => {
    fs.writeFileSync(configPath(), text);
    expect(() => loadConfig()).toThrow(error);
  });
});
