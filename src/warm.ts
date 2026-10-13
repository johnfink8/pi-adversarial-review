/**
 * Warm review sessions: each panel member's own pi session, kept between
 * review passes on the same parent commit so a re-review resumes rather than
 * starting cold.
 *
 * Keyed by HEAD. A commit moves HEAD, so the first review after it starts cold
 * and the sessions for the commit it left behind are pruned. Within one HEAD a
 * member's session is kept only from a run that produced a usable result, and
 * records the tree that run read — the next pass is told exactly what changed
 * since then, as a diff between the two reviewed trees.
 *
 * Every way a warm start can be unavailable falls back to a cold one, and each
 * is named in the review's warnings: a cold start costs time, never
 * correctness, but a warm path that silently stopped working would be paid on
 * every round without anyone knowing why.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isAncestor, treeExists } from "./changeset.ts";
import { repoDir } from "./record.ts";
import { describeError, isRecord, safeName } from "./util.ts";

/** Warm sessions for a HEAD nothing has reviewed against in this long are dropped. */
const STALE_MS = 7 * 24 * 60 * 60 * 1000;

interface WarmState {
  agent: string;
  specHash: string;
  sessionId: string;
  /** The reviewed tree this session last produced a usable result for. */
  tree: string;
  changesetHash: string;
  at: string;
}

export interface WarmStart {
  /** The kept session to continue, or undefined for a cold start. */
  seedDir: string | undefined;
  sessionId: string;
  /** What the last usable pass read, when this start is warm. */
  since: { tree: string; changesetHash: string } | undefined;
}

function headKey(head: string): string {
  return head === "" ? "unborn" : head;
}

function warmRoot(repoRoot: string): string {
  return path.join(repoDir(repoRoot), "warm");
}

function memberDir(repoRoot: string, head: string, agent: string): string {
  return path.join(warmRoot(repoRoot), headKey(head), safeName(agent));
}

function cold(): WarmStart {
  return { seedDir: undefined, sessionId: randomUUID(), since: undefined };
}

function parseState(value: unknown): WarmState | undefined {
  if (!isRecord(value)) return undefined;
  const { agent, specHash, sessionId, tree, changesetHash, at } = value;
  if (
    typeof agent !== "string" ||
    typeof specHash !== "string" ||
    typeof sessionId !== "string" ||
    typeof tree !== "string" ||
    typeof changesetHash !== "string" ||
    typeof at !== "string"
  ) {
    return undefined;
  }
  return { agent, specHash, sessionId, tree, changesetHash, at };
}

/** The member's kept session for this HEAD, or a cold start with the reason in `warnings`. */
export async function loadWarm(
  repoRoot: string,
  head: string,
  agent: string,
  specHash: string,
  warnings: string[],
): Promise<WarmStart> {
  const dir = memberDir(repoRoot, head, agent);
  let raw: string;
  try {
    raw = await fs.promises.readFile(path.join(dir, "state.json"), "utf-8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return cold();
    warnings.push(`${agent} started cold: its warm state at ${dir} is unreadable (${describeError(error)})`);
    return cold();
  }

  let state: WarmState | undefined;
  try {
    state = parseState(JSON.parse(raw));
  } catch {
    state = undefined;
  }
  const discard = async (why: string) => {
    warnings.push(`${agent} started cold: ${why}`);
    await fs.promises.rm(dir, { recursive: true, force: true });
    return cold();
  };
  if (state === undefined || state.agent !== agent) return discard(`its warm state at ${dir} is malformed`);
  if (state.specHash !== specHash) return discard("its spec changed since its kept session");
  if (!(await treeExists(repoRoot, state.tree))) {
    return discard(`the tree it last reviewed (${state.tree}) is gone from the object store`);
  }
  const sessionDir = path.join(dir, "session");
  const sessionFiles = fs.existsSync(sessionDir) ? fs.readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")) : [];
  if (sessionFiles.length !== 1) {
    return discard(`its kept session at ${sessionDir} holds ${sessionFiles.length} session files, not 1`);
  }
  return {
    seedDir: sessionDir,
    sessionId: state.sessionId,
    since: { tree: state.tree, changesetHash: state.changesetHash },
  };
}

/**
 * Keeps a finished run's session as the member's warm state. Replaces the
 * previous one by rename, so a crash mid-way leaves either the old state or
 * the new, never a session paired with the wrong tree.
 */
export async function keepWarm(
  repoRoot: string,
  head: string,
  state: Omit<WarmState, "at">,
  sessionDir: string,
): Promise<void> {
  const dir = memberDir(repoRoot, head, state.agent);
  const next = `${dir}.next`;
  const prev = `${dir}.prev`;
  await fs.promises.rm(next, { recursive: true, force: true });
  await fs.promises.mkdir(next, { recursive: true });
  await fs.promises.cp(sessionDir, path.join(next, "session"), { recursive: true });
  await fs.promises.writeFile(
    path.join(next, "state.json"),
    `${JSON.stringify({ ...state, at: new Date().toISOString() }, null, 2)}\n`,
    "utf-8",
  );
  await fs.promises.rm(prev, { recursive: true, force: true });
  if (fs.existsSync(dir)) await fs.promises.rename(dir, prev);
  await fs.promises.rename(next, dir);
  await fs.promises.rm(prev, { recursive: true, force: true });
}

/**
 * Removes warm sessions that can no longer be resumed: those for a commit HEAD
 * has moved past, and those idle past STALE_MS (a branch abandoned elsewhere).
 */
export async function pruneWarm(repoRoot: string, head: string, warnings: string[]): Promise<void> {
  const root = warmRoot(repoRoot);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    warnings.push(`Could not prune warm review sessions at ${root}: ${describeError(error)}`);
    return;
  }
  const current = headKey(head);
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current) continue;
    const full = path.join(root, entry.name);
    try {
      // A name git cannot resolve (a commit since gc'd, or rewritten away) is not
      // known to be behind, so only the idle rule can reclaim it.
      const behind =
        entry.name === "unborn" || (head !== "" && (await isAncestor(repoRoot, entry.name, head).catch(() => false)));
      const stale = Date.now() - (await fs.promises.stat(full)).mtimeMs > STALE_MS;
      if (behind || stale) await fs.promises.rm(full, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`Could not prune warm review sessions at ${full}: ${describeError(error)}`);
    }
  }
}
