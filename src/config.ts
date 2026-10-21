/**
 * `<agentDir>/review-gate.json`, every key optional:
 *
 *     { "maxConcurrency": 1, "model": "<provider>/<model-id>" }
 *
 * `maxConcurrency` is how many panel members run at once, per pi process. Use 1
 * for an endpoint that caches one conversation at a time: concurrent reviewers
 * evict each other's prefix cache, so every one pays a full prefill.
 *
 * `model` is the `provider/id` a panel member without its own `model:` runs on,
 * in place of the session's model. The session's thinking level is not passed
 * along with it, since it was chosen for a different model, and a trailing
 * `:<thinking>` suffix is rejected rather than quietly pinning one. How the
 * value is resolved against the model registry is panel-model.ts's contract.
 *
 * Invalid values throw at extension load rather than falling back to the
 * default. The file is read once, when the extension loads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describeError, isRecord } from "./util.ts";

export const DEFAULT_MAX_CONCURRENCY = 5;
const MAX_CONCURRENCY_LIMIT = 8;
const KNOWN_KEYS: readonly (keyof GateConfig)[] = ["maxConcurrency", "model"];
/** Mirrors pi's own `--model` suffix rule: a valid level is a level, anything else is part of the id. */
const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

export interface GateConfig {
  maxConcurrency: number;
  model?: string | undefined;
}

export function loadConfig(): GateConfig {
  const configPath = path.join(getAgentDir(), "review-gate.json");

  let text: string;
  try {
    text = fs.readFileSync(configPath, "utf-8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { maxConcurrency: DEFAULT_MAX_CONCURRENCY };
    throw new Error(`Failed to read ${configPath}: ${describeError(error)}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new Error(`Invalid JSON in ${configPath}: ${describeError(error)}`);
  }
  if (!isRecord(raw)) throw new Error(`${configPath} must contain a JSON object`);

  const unknownKeys = Object.keys(raw).filter((key) => !KNOWN_KEYS.some((known) => known === key));
  if (unknownKeys.length > 0) throw new Error(`Unknown key(s) in ${configPath}: ${unknownKeys.join(", ")}`);

  const config: GateConfig = { maxConcurrency: DEFAULT_MAX_CONCURRENCY };

  if ("maxConcurrency" in raw) {
    const value = raw.maxConcurrency;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY_LIMIT) {
      throw new Error(
        `${configPath} maxConcurrency must be an integer from 1 to ${MAX_CONCURRENCY_LIMIT}, got ${JSON.stringify(value)}`,
      );
    }
    config.maxConcurrency = value;
  }

  if ("model" in raw) {
    const value = raw.model;
    if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/.test(value)) {
      throw new Error(`${configPath} model must be a "provider/id" string, got ${JSON.stringify(value)}`);
    }
    if (THINKING_SUFFIX.test(value)) {
      throw new Error(
        `${configPath} model must not end in a thinking level (${JSON.stringify(value)}); the session's thinking level is not passed along`,
      );
    }
    config.model = value;
  }

  return config;
}
