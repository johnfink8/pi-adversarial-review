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

  it.each([
    ["out of range", '{ "maxConcurrency": 0 }', /must be an integer from 1 to 8/],
    ["not an integer", '{ "maxConcurrency": 2.5 }', /must be an integer from 1 to 8/],
    ["missing", "{}", /must be an integer from 1 to 8/],
    ["an unknown key", '{ "maxConcurrency": 2, "lanes": [] }', /Unknown key\(s\).*lanes/],
    ["invalid JSON", "{ nope", /Invalid JSON/],
    ["not an object", "[]", /must contain a JSON object/],
  ])("fails loud on %s", (_label, text, error) => {
    fs.writeFileSync(configPath(), text);
    expect(() => loadConfig()).toThrow(error);
  });
});
