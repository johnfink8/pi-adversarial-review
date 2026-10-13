/**
 * Reviewer and moderator specs: Markdown files with `name`, `description`,
 * optional `tools` and `model` frontmatter, and the system prompt as the body.
 *
 * The package ships a panel in `reviewers/` and a moderator in `moderator/`.
 * `<agentDir>/review-gate/reviewers/` or `<agentDir>/review-gate/moderator/`,
 * when present, replaces the bundled one whole. Replacement, not merging: a
 * PROCEED is a claim about exactly who was in the room, and a merge rule is one
 * more thing that can put someone there the user did not choose.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { describeError } from "./util.ts";

const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export type SpecSource = "bundled" | "user";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[] | undefined;
  model?: string | undefined;
  systemPrompt: string;
  source: SpecSource;
  filePath: string;
}

export interface SkippedAgentFile {
  filePath: string;
  reason: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  skipped: SkippedAgentFile[];
}

/**
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
  name?: unknown;
  description?: unknown;
  tools?: unknown;
  model?: unknown;
};

/**
 * `tools: read, bash` and `tools: [read, bash]` are both valid YAML and both in
 * use. `tools` is an allowlist: a present-but-malformed value is a broken
 * restriction, not "no restriction", so it is reported rather than silently
 * widened to the default toolset. Absent stays absent.
 */
function parseToolList(value: unknown): { tools?: string[]; error?: string } {
  if (value === undefined || value === null) return {};
  let raw: unknown[];
  if (Array.isArray(value)) raw = value;
  else if (typeof value === "string") raw = value.split(",");
  else return { error: `tools must be a comma-separated string or an array, got ${JSON.stringify(value)}` };

  const bad = raw.filter((t) => typeof t !== "string");
  if (bad.length > 0) return { error: `tools entries must be strings, got ${JSON.stringify(bad)}` };

  const tools = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return tools.length > 0 ? { tools } : {};
}

function loadSpecsFromDir(dir: string, source: SpecSource, skipped: SkippedAgentFile[]): AgentConfig[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read spec directory ${dir}: ${describeError(error)}`);
  }

  // Anything that is not a loadable spec is refused rather than ignored: a
  // `reviewers/foo.json` or a subdirectory would thin the panel with nothing
  // printed and the verdict still reading as unanimous.
  const strays = entries
    .filter((entry) => !entry.name.startsWith(".") && !(entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink())))
    .map((entry) => entry.name);
  if (strays.length > 0) {
    throw new Error(
      `${dir} contains entries that are not loadable specs: ${strays.join(", ")}. ` +
        "Only regular *.md files and symlinks are read, so anything else here would be silently absent. Move it out.",
    );
  }

  const specs: AgentConfig[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      skipped.push({ filePath, reason: `unreadable: ${describeError(error)}` });
      continue;
    }

    const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
      skipped.push({ filePath, reason: "frontmatter missing name or description" });
      continue;
    }
    const parsedTools = parseToolList(frontmatter.tools);
    if (parsedTools.error) {
      skipped.push({ filePath, reason: parsedTools.error });
      continue;
    }
    specs.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parsedTools.tools,
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return specs;
}

function specDir(kind: "reviewers" | "moderator"): { dir: string; source: SpecSource } {
  const user = path.join(getAgentDir(), "review-gate", kind);
  if (fs.existsSync(user)) return { dir: user, source: "user" };
  return { dir: path.join(PACKAGE_ROOT, kind), source: "bundled" };
}

export interface ReviewerDiscovery {
  dir: string;
  reviewers: AgentConfig[];
}

/**
 * The panel is atomic: a PROCEED means "every reviewer cleared these bits", so
 * a spec that will not parse fails the gate rather than leaving the room.
 */
export function discoverReviewers(): ReviewerDiscovery {
  const { dir, source } = specDir("reviewers");
  const skipped: SkippedAgentFile[] = [];
  const reviewers = loadSpecsFromDir(dir, source, skipped);
  if (skipped.length > 0) {
    throw new Error(
      `Reviewer directory ${dir} has ${skipped.length} unreadable spec(s): ` +
        `${skipped.map((s) => `${s.filePath} — ${s.reason}`).join("; ")}. ` +
        "Fix or remove them; the gate will not run a partial panel.",
    );
  }
  if (reviewers.length === 0) throw new Error(`Reviewer directory ${dir} has no reviewer specs.`);
  return { dir, reviewers };
}

/** Exactly one: a second would leave the gate choosing which judge to ask. */
export function discoverModerator(): AgentConfig {
  const { dir, source } = specDir("moderator");
  const skipped: SkippedAgentFile[] = [];
  const found = loadSpecsFromDir(dir, source, skipped);
  if (skipped.length > 0) {
    throw new Error(`Moderator directory ${dir} has unreadable spec(s): ${skipped.map((s) => `${s.filePath} — ${s.reason}`).join("; ")}.`);
  }
  const [moderator, ...extra] = found;
  if (moderator === undefined || extra.length > 0) {
    throw new Error(`Moderator directory ${dir} must hold exactly one spec; found ${found.length}.`);
  }
  return moderator;
}
