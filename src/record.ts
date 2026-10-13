/**
 * The review record: what each reviewer said about each changeset.
 *
 * This is the one place that says where the store lives: `reviewsRoot()` under
 * the pi agent dir, keyed by repository and by the changeset hash. The agent dir
 * may or may not itself be a repository, depending on how it is installed —
 * neither layout may be assumed. Both guards exist for that reason: the store is
 * gitignored, and its files are excluded from the changesets their records
 * describe, so neither depends on which layout is in force. Writing a verdict into the tree under review would
 * dirty the tree the review just cleared and change the hash underneath it.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { describeError, isRecord, safeName } from "./util.ts";

export type Verdict = "PROCEED" | "BLOCK" | "INCOMPLETE";
export type Severity = "HIGH" | "MEDIUM" | "LOW";

export interface Finding {
  severity: Severity;
  file: string;
  line: string;
  problem: string;
  fix: string;
}

export interface ClearedItem {
  file: string;
  line: string;
  why: string;
}

/** What a reviewer is required to emit. */
export interface ReviewerRecord {
  verdict: Verdict;
  findings: Finding[];
  cleared: ClearedItem[];
  note: string;
}

/** A reviewer record plus the provenance that makes it replayable. */
export interface AgentState extends ReviewerRecord {
  agent: string;
  /** sha256 of the reviewer spec plus the approval protocol it answered. */
  specHash: string;
  model: string;
  at: string;
  reportPath: string;
  /** Set when the reviewer ran but produced nothing usable, or never ran. */
  failure?: string | undefined;
}

export interface ChangesetRecord {
  version: 1;
  repoRoot: string;
  changesetHash: string;
  intent: string;
  updatedAt: string;
  agents: Record<string, AgentState>;
  moderation?: Moderation | undefined;
}

/** The moderator's ruling on a blocked panel for one changeset. */
export interface Moderation {
  specHash: string;
  model: string;
  at: string;
  reportPath: string;
  overturn: boolean;
  /**
   * The `at` of every reviewer state the ruling read. A ruling is about those
   * reports, so it stops counting the moment any of them is replaced.
   */
  judged: Record<string, string>;
}

const KEEP_CHANGESETS = 25;

export function reviewsRoot(): string {
  return path.join(getAgentDir(), "reviews");
}

export function repoKey(repoRoot: string): string {
  const digest = createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
  const label = safeName(path.basename(repoRoot)) || "repo";
  return `${label}-${digest}`;
}

export function repoDir(repoRoot: string): string {
  return path.join(reviewsRoot(), repoKey(repoRoot));
}

export function changesetDir(repoRoot: string, changesetHash: string): string {
  return path.join(repoDir(repoRoot), changesetHash);
}

export function specHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

function recordPath(repoRoot: string, changesetHash: string): string {
  return path.join(repoDir(repoRoot), `${changesetHash}.json`);
}

export type LoadResult = { record: ChangesetRecord | null; warning?: string };

/**
 * A record that cannot be read is reported and treated as absent, so the next
 * review re-runs and overwrites it. Silently reading it as "no verdicts"
 * without saying so would hide a broken cache behind a fresh review.
 */
export async function loadRecord(repoRoot: string, changesetHash: string): Promise<LoadResult> {
  const file = recordPath(repoRoot, changesetHash);
  let text: string;
  try {
    if (!fs.existsSync(file)) return { record: null };
    text = await fs.promises.readFile(file, "utf-8");
  } catch (error) {
    return { record: null, warning: `Unreadable review record ${file}: ${String(error)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { record: null, warning: `Corrupt review record ${file}: ${String(error)}` };
  }

  const validated = validateRecord(parsed);
  if (!validated.ok) return { record: null, warning: `Invalid review record ${file}: ${validated.error}` };
  if (validated.record.repoRoot !== repoRoot) {
    return {
      record: null,
      warning: `Review record ${file} names repo ${validated.record.repoRoot}, not ${repoRoot}; ignoring it.`,
    };
  }
  // The filename is the key the verdicts are looked up by, so a record whose own
  // body names a different changeset must not have its verdicts applied to this
  // one. Checking only the repo would enforce "keyed by changeset hash" halfway.
  if (validated.record.changesetHash !== changesetHash) {
    return {
      record: null,
      warning: `Review record ${file} names changeset ${validated.record.changesetHash}, not ${changesetHash}; ignoring it.`,
    };
  }
  return { record: validated.record };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asVerdict(value: unknown): Verdict | undefined {
  return value === "PROCEED" || value === "BLOCK" || value === "INCOMPLETE" ? value : undefined;
}

export function asSeverity(value: unknown): Severity | undefined {
  return value === "HIGH" || value === "MEDIUM" || value === "LOW" ? value : undefined;
}

function validateRecord(value: unknown): { ok: true; record: ChangesetRecord } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "not an object" };
  if (value.version !== 1) return { ok: false, error: `version must be 1, got ${JSON.stringify(value.version)}` };

  const repoRoot = asString(value.repoRoot);
  const changesetHash = asString(value.changesetHash);
  const intent = asString(value.intent);
  const updatedAt = asString(value.updatedAt);
  if (repoRoot === undefined) return { ok: false, error: "repoRoot must be a string" };
  if (changesetHash === undefined) return { ok: false, error: "changesetHash must be a string" };
  if (intent === undefined) return { ok: false, error: "intent must be a string" };
  if (updatedAt === undefined) return { ok: false, error: "updatedAt must be a string" };
  if (!isRecord(value.agents)) return { ok: false, error: "agents must be an object" };

  const agents: Record<string, AgentState> = {};
  for (const [name, state] of Object.entries(value.agents)) {
    const parsed = validateAgentState(name, state);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    agents[name] = parsed.state;
  }

  let moderation: Moderation | undefined;
  if (value.moderation !== undefined) {
    const parsed = validateModeration(value.moderation);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    moderation = parsed.moderation;
  }

  return { ok: true, record: { version: 1, repoRoot, changesetHash, intent, updatedAt, agents, moderation } };
}

function validateModeration(value: unknown): { ok: true; moderation: Moderation } | { ok: false; error: string } {
  const bad = (why: string): { ok: false; error: string } => ({ ok: false, error: `moderation: ${why}` });
  if (!isRecord(value)) return bad("must be an object");
  const specHashValue = asString(value.specHash);
  const model = asString(value.model);
  const at = asString(value.at);
  const reportPath = asString(value.reportPath);
  if (specHashValue === undefined || model === undefined || at === undefined || reportPath === undefined) {
    return bad("specHash, model, at and reportPath must be strings");
  }
  if (typeof value.overturn !== "boolean") return bad("overturn must be a boolean");
  if (!isRecord(value.judged)) return bad("judged must be an object");
  const judged: Record<string, string> = {};
  for (const [agent, stamp] of Object.entries(value.judged)) {
    if (typeof stamp !== "string") return bad(`judged.${agent} must be a string`);
    judged[agent] = stamp;
  }
  return { ok: true, moderation: { specHash: specHashValue, model, at, reportPath, overturn: value.overturn, judged } };
}

function validateAgentState(name: string, value: unknown): { ok: true; state: AgentState } | { ok: false; error: string } {
  const bad = (why: string): { ok: false; error: string } => ({ ok: false, error: `agent "${name}": ${why}` });
  if (!isRecord(value)) return bad("must be an object");

  const verdict = asVerdict(value.verdict);
  if (verdict === undefined) {
    return bad(`verdict must be PROCEED, BLOCK or INCOMPLETE, got ${JSON.stringify(value.verdict)}`);
  }
  const specHashValue = asString(value.specHash);
  const model = asString(value.model);
  const at = asString(value.at);
  const reportPath = asString(value.reportPath);
  const note = asString(value.note);
  const failure = value.failure === undefined ? undefined : asString(value.failure);
  if (specHashValue === undefined) return bad("specHash must be a string");
  if (model === undefined) return bad("model must be a string");
  if (at === undefined) return bad("at must be a string");
  if (reportPath === undefined) return bad("reportPath must be a string");
  if (note === undefined) return bad("note must be a string");
  if (value.failure !== undefined && failure === undefined) return bad("failure must be a string when present");
  if (!Array.isArray(value.findings)) return bad("findings must be an array");
  if (!Array.isArray(value.cleared)) return bad("cleared must be an array");

  const findings: Finding[] = [];
  for (const entry of value.findings) {
    const parsed = validateFinding(entry);
    if (!parsed.ok) return bad(parsed.error);
    findings.push(parsed.value);
  }
  const cleared: ClearedItem[] = [];
  for (const entry of value.cleared) {
    const parsed = validateCleared(entry);
    if (!parsed.ok) return bad(parsed.error);
    cleared.push(parsed.value);
  }

  return {
    ok: true,
    state: {
      agent: name,
      verdict,
      findings,
      cleared,
      note,
      specHash: specHashValue,
      model,
      at,
      reportPath,
      ...(failure === undefined ? {} : { failure }),
    },
  };
}

/** Shared with the write path in protocol.ts: one schema, checked the same way on the way in and the way back. */
export function validateFinding(value: unknown): { ok: true; value: Finding } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "a finding is not an object" };
  const severity = asSeverity(value.severity);
  if (severity === undefined) {
    return { ok: false, error: `a finding severity must be HIGH, MEDIUM or LOW, got ${JSON.stringify(value.severity)}` };
  }
  const file = asString(value.file);
  const line = asString(value.line);
  const problem = asString(value.problem);
  const fix = asString(value.fix);
  if (file === undefined || line === undefined || problem === undefined || fix === undefined) {
    return { ok: false, error: "finding file, line, problem and fix must be strings" };
  }
  return { ok: true, value: { severity, file, line, problem, fix } };
}

export function validateCleared(value: unknown): { ok: true; value: ClearedItem } | { ok: false; error: string } {
  if (!isRecord(value)) return { ok: false, error: "a cleared item is not an object" };
  const file = asString(value.file);
  const line = asString(value.line);
  const why = asString(value.why);
  if (file === undefined || line === undefined || why === undefined) {
    return { ok: false, error: "cleared file, line and why must be strings" };
  }
  return { ok: true, value: { file, line, why } };
}

export async function saveRecord(record: ChangesetRecord): Promise<string[]> {
  const dir = repoDir(record.repoRoot);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = recordPath(record.repoRoot, record.changesetHash);
  await withFileMutationQueue(file, async () => {
    await fs.promises.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  });
  return pruneChangesets(dir);
}

/** Full reviewer output, kept next to the patch it judged. */
export async function writeReport(
  repoRoot: string,
  changesetHash: string,
  agent: string,
  body: string,
): Promise<string> {
  const dir = changesetDir(repoRoot, changesetHash);
  await fs.promises.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeName(agent)}.md`);
  await withFileMutationQueue(file, async () => {
    await fs.promises.writeFile(file, body, "utf-8");
  });
  return file;
}

/** Keeps the cache bounded; the hash directory is what a reviewer was handed. */
function pruneChangesets(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    // The directory was just created, so this is an anomaly rather than a state
    // to tolerate. Reported, because the only consequence is that the store
    // stops being reclaimed and grows without bound.
    return [`Could not prune the review store at ${dir}: ${describeError(error)}`];
  }
  const dirs: { name: string; full: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      dirs.push({ name: entry.name, full, mtime: fs.statSync(full).mtimeMs });
    } catch (error) {
      // One unreadable directory stops its own pruning, not the whole review.
      // A verdict already written stays valid either way.
      console.warn(`Cannot stat review directory ${full}: ${describeError(error)}`);
    }
  }

  // A changeset with a record is exactly as prunable as one without — every
  // reviewed changeset writes one — so the record goes with its directory or
  // nothing is ever reclaimed and the store grows without bound.
  dirs.sort((a, b) => b.mtime - a.mtime);
  for (const entry of dirs.slice(KEEP_CHANGESETS)) {
    fs.rmSync(entry.full, { recursive: true, force: true });
    fs.rmSync(path.join(dir, `${entry.name}.json`), { force: true });
  }
  return [];
}
