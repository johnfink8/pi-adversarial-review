/**
 * `<agentDir>/review-gate.json`:
 *
 *     { "maxConcurrency": 1 }
 *
 * `maxConcurrency` is how many panel members run at once, per pi process. Use 1
 * for an endpoint that caches one conversation at a time: concurrent reviewers
 * evict each other's prefix cache, so every one pays a full prefill.
 *
 * Invalid values throw at extension load rather than falling back to the
 * default. The file is read once, when the extension loads.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { describeError, isRecord } from "./util.ts";

export const DEFAULT_MAX_CONCURRENCY = 4;
const MAX_CONCURRENCY_LIMIT = 8;

export interface GateConfig {
  maxConcurrency: number;
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

  const unknownKeys = Object.keys(raw).filter((key) => key !== "maxConcurrency");
  if (unknownKeys.length > 0) throw new Error(`Unknown key(s) in ${configPath}: ${unknownKeys.join(", ")}`);

  const value = raw.maxConcurrency;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY_LIMIT) {
    throw new Error(`${configPath} maxConcurrency must be an integer from 1 to ${MAX_CONCURRENCY_LIMIT}, got ${JSON.stringify(value)}`);
  }
  return { maxConcurrency: value };
}
