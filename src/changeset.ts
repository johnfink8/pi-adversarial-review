/**
 * The changeset under review, and the hash every verdict is recorded against.
 *
 * The unit of review is the working tree against HEAD: every tracked change
 * plus every untracked, non-ignored file. The index is ignored — what is staged
 * has no bearing on what the panel reads or on the hash, so staging alone never
 * forces a re-review. A commit is held to the reviewed worktree bytes
 * afterwards (`committedDrift`), which is what catches a stale or partial stage.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { repoDir, reviewsRoot } from "./record.ts";
import { describeError, isRecord } from "./util.ts";

/** Above this the patch is not reviewable in one pass; splitting the change is the fix. */
export const MAX_PATCH_BYTES = 512 * 1024;

/**
 * git C-quotes non-ASCII paths in diff output by default (`"caf\303\251.txt"`).
 * Those headers are parsed back into filesystem paths, so a quoted name would be
 * looked up on disk, read as absent, and compare equal to itself forever — the
 * drift and committed-bytes checks would pass without checking anything.
 */
const QUOTE_PREFIX = ["-c", "core.quotePath=false"];
const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "--find-renames"];

export class ChangesetError extends Error {}

export class ChangesetTooLargeError extends ChangesetError {}

/**
 * No repository means no changeset and nothing to gate: `git commit` fails on
 * its own here, so a caller must not read this as a review that failed to
 * complete.
 */
export class NotARepositoryError extends ChangesetError {}

export interface Changeset {
  repoRoot: string;
  /** HEAD at capture, or "" on an unborn branch. What a commit here would be parented on. */
  head: string;
  /** sha256 over HEAD, the worktree diff against it, and each untracked file's content. */
  hash: string;
  /**
   * The reviewed worktree as a git tree object, so two reviews can be diffed
   * exactly. The object sits unreferenced in the repository's store; gc may
   * reclaim it, which `treeExists` reports.
   */
  tree: string;
  patchPath: string;
  files: string[];
  untracked: string[];
  patchBytes: number;
  patchLines: number;
  isEmpty: boolean;
  /** Working-tree digests of `files`, so a verdict can be re-checked after the command runs. */
  snapshot: TreeSnapshot;
}

/**
 * Environment pointing git at a scratch index, or undefined for the real one.
 * Every read that defines the changeset goes through `withHeadIndex`.
 */
type GitEnv = NodeJS.ProcessEnv | undefined;

function git(cwd: string, args: string[], env?: GitEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", (error) => reject(new ChangesetError(`Cannot run git: ${error.message}`)));
    proc.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function gitOrThrow(cwd: string, args: string[], what: string, env?: GitEnv): Promise<string> {
  const result = await git(cwd, args, env);
  if (result.code !== 0) {
    throw new ChangesetError(
      `git ${args.join(" ")} failed while capturing ${what}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return result.stdout;
}

interface UntrackedFile {
  file: string;
  mode: string;
  digest: string;
  /** Text content for the patch, or undefined when the bytes are not text. */
  text: string | undefined;
  bytes: number;
}

/**
 * Reads one untracked file for hashing.
 *
 * Size is checked before the read, not after: the patch cap is only meaningful
 * if a multi-gigabyte untracked file cannot be pulled into memory on the way to
 * it, which would take the whole pi process down on every commit attempt.
 */
function readUntracked(repoRoot: string, file: string, budgetLeft: number): UntrackedFile {
  const full = path.join(repoRoot, file);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(full);
  } catch (error) {
    throw new ChangesetError(`Untracked file ${file} disappeared while hashing the changeset: ${String(error)}`);
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new ChangesetError(`Untracked path ${file} is neither a file nor a symlink; refusing to review it unseen.`);
  }

  // A symlink is stored by git as its target path, so that string is what gets
  // hashed and shown. Following the link would hash content the commit does not
  // contain, and a link to a directory would raise EISDIR.
  if (stat.isSymbolicLink()) {
    let target: string;
    try {
      target = fs.readlinkSync(full);
    } catch (error) {
      throw new ChangesetError(`Cannot read untracked symlink ${file}: ${String(error)}`);
    }
    if (Buffer.byteLength(target, "utf-8") > budgetLeft) {
      throw new ChangesetTooLargeError(
        `Untracked symlink ${file} is over the ${MAX_PATCH_BYTES / 1024} KiB review budget.`,
      );
    }
    return {
      file,
      mode: "120000",
      digest: createHash("sha256").update(target).digest("hex"),
      text: target,
      bytes: Buffer.byteLength(target, "utf-8"),
    };
  }

  if (stat.size > budgetLeft) {
    throw new ChangesetTooLargeError(
      `Untracked file ${file} is ${Math.round(stat.size / 1024)} KiB, over the ${MAX_PATCH_BYTES / 1024} KiB review budget. ` +
        `Ignore it (.gitignore) or commit it separately — the panel cannot read a file that large.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(full);
  } catch (error) {
    throw new ChangesetError(`Cannot read untracked file ${file} to hash the changeset: ${String(error)}`);
  }

  const mode = stat.mode & 0o111 ? "100755" : "100644";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const isText = !bytes.includes(0) && isUtf8(bytes);
  return { file, mode, digest, text: isText ? bytes.toString("utf-8") : undefined, bytes: bytes.length };
}

function isUnder(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  // Escaping means `..` alone or a path that starts with a `..` component — a
  // name that merely begins with two dots (`..foo`) sits inside the root.
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/**
 * The paths a diff touches, asked of git rather than read off the patch.
 *
 * Parsing `diff --git` headers would give C-quoted names for paths containing a
 * quote or a backslash — quoting git applies regardless of core.quotePath — and
 * a quoted name looked up on disk is a different file, which silently reads as
 * absent. `-z` is the only output form that never quotes.
 */
async function diffPaths(repoRoot: string, args: string[], env: GitEnv): Promise<string[]> {
  const out = await gitOrThrow(
    repoRoot,
    [...QUOTE_PREFIX, "diff", "--name-only", "-z", ...args],
    "the changed paths",
    env,
  );
  return out.split("\0").filter(Boolean);
}

/**
 * Runs `fn` against a scratch index holding exactly `base`'s tree.
 *
 * The real index decides which paths `git diff <commit>` treats as tracked and
 * which `ls-files --others` calls untracked: a new file reads as an untracked
 * file before `git add` and as a tracked addition after, and `git rm --cached`
 * flips the other way. Reading through an index built from HEAD makes "tracked"
 * mean "in HEAD", so the changeset is the working tree against HEAD and nothing
 * the user stages can change it.
 */
async function withHeadIndex<T>(
  repoRoot: string,
  base: string,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "review-index-"));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(dir, "index") };
    await gitOrThrow(repoRoot, ["read-tree", base], "a scratch index of HEAD", env);
    return await fn(env);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Stages `files` from the worktree into the scratch index and writes it out as
 * a tree. Literal pathspecs from a NUL-separated file: names are data here, and
 * a name holding `*` or `:(` must not be read as a pattern.
 */
async function writeWorktreeTree(repoRoot: string, files: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const indexFile = env.GIT_INDEX_FILE;
  if (indexFile === undefined) throw new ChangesetError("writeWorktreeTree needs the scratch index");
  if (files.length > 0) {
    const listFile = path.join(path.dirname(indexFile), "paths");
    await fs.promises.writeFile(listFile, files.join("\0"));
    await gitOrThrow(
      repoRoot,
      ["add", "-A", `--pathspec-from-file=${listFile}`, "--pathspec-file-nul"],
      "the reviewed worktree",
      { ...env, GIT_LITERAL_PATHSPECS: "1" },
    );
  }
  return (await gitOrThrow(repoRoot, ["write-tree"], "the reviewed tree", env)).trim();
}

/** Whether `tree` is still in the object store; an unreferenced tree can be gc'd. */
export async function treeExists(repoRoot: string, tree: string): Promise<boolean> {
  const result = await git(repoRoot, ["cat-file", "-e", `${tree}^{tree}`]);
  return result.code === 0;
}

/** Whether `ancestor` is reachable from `commit`. */
export async function isAncestor(repoRoot: string, ancestor: string, commit: string): Promise<boolean> {
  const result = await git(repoRoot, ["merge-base", "--is-ancestor", ancestor, commit]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  throw new ChangesetError(
    `git merge-base --is-ancestor ${ancestor} ${commit} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
  );
}

export interface Interdiff {
  path: string;
  lines: number;
  files: string[];
}

/**
 * What changed between two reviewed trees, written beside the current patch.
 * Exact by construction: both sides are the trees the reviews actually read.
 */
export async function writeInterdiff(changeset: Changeset, fromTree: string): Promise<Interdiff> {
  const { repoRoot, tree } = changeset;
  const files = (
    await gitOrThrow(
      repoRoot,
      [...QUOTE_PREFIX, "diff", "--name-only", "-z", ...DIFF_FLAGS, fromTree, tree],
      "the changed paths since the last review",
    )
  )
    .split("\0")
    .filter(Boolean);
  const diff = await gitOrThrow(
    repoRoot,
    [...QUOTE_PREFIX, "diff", ...DIFF_FLAGS, fromTree, tree],
    "the changes since the last review",
  );
  const body = [
    `Changes since the last review: tree ${fromTree} -> tree ${tree}`,
    `Changeset ${changeset.hash}`,
    "",
    diff === "" ? "(none — the tree is identical to the one last reviewed)" : diff,
  ].join("\n");
  const out = path.join(path.dirname(changeset.patchPath), `since-${fromTree}.patch`);
  if (!fs.existsSync(out)) {
    const tmp = `${out}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, body, "utf-8");
    await fs.promises.rename(tmp, out);
  }
  return { path: out, lines: countLines(body), files };
}

/** HEAD, or "" on an unborn branch; throws when HEAD fails to resolve for any other reason. */
async function resolveHead(repoRoot: string): Promise<string> {
  // `--quiet` is deliberately absent: it suppresses stdout on every failure, so
  // "HEAD will not resolve" and "no commits yet" would look identical and a
  // broken repository would be reviewed as a whole new tree.
  const headResult = await git(repoRoot, ["rev-parse", "--verify", "HEAD"]);
  if (headResult.code === 0) return headResult.stdout.trim();
  // The only benign reason for no HEAD is a branch with no commits yet — an
  // unborn or --orphan branch. Anything else is a repository that cannot tell
  // us what it contains, and must not be quietly diffed against nothing.
  const unborn = await isUnbornBranch(repoRoot);
  if (!unborn.ok) {
    throw new ChangesetError(
      `git rev-parse HEAD failed in ${repoRoot} and the repository is not unborn: ${unborn.why}\n` +
        `HEAD: ${headResult.stderr.trim() || `exit ${headResult.code}`}`,
    );
  }
  return "";
}

/** The tree a diff is taken against: HEAD, or the empty tree on an unborn branch. */
async function diffBase(repoRoot: string, head: string): Promise<string> {
  if (head !== "") return head;
  return (await gitOrThrow(repoRoot, ["hash-object", "-t", "tree", "/dev/null"], "the empty tree")).trim();
}

/**
 * True when HEAD names a branch that has no commits, so diffing against the
 * empty tree is what the repository is actually asking for.
 *
 * `rev-list --all` is the wrong probe: an `--orphan` branch coexists with
 * committed branches, and a corrupt ref file fails `symbolic-ref` where an
 * unborn branch does not — which is the distinction being drawn here.
 */
async function isUnbornBranch(repoRoot: string): Promise<{ ok: true } | { ok: false; why: string }> {
  const sym = await git(repoRoot, ["symbolic-ref", "--quiet", "HEAD"]);
  const ref = sym.stdout.trim();
  if (sym.code !== 0 || ref === "") {
    return { ok: false, why: `HEAD is not a branch ref (${sym.stderr.trim() || `exit ${sym.code}`})` };
  }
  const exists = await git(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
  if (exists.code === 0) return { ok: false, why: `branch ${ref} exists but HEAD would not resolve it` };
  if (exists.code !== 1)
    return { ok: false, why: `git show-ref ${ref} failed: ${exists.stderr.trim() || `exit ${exists.code}`}` };
  return { ok: true };
}

/** Non-ignored files outside the index `env` names, minus the review store that describes them. */
async function listUntracked(repoRoot: string, env: GitEnv): Promise<string[]> {
  const out = await gitOrThrow(
    repoRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "the untracked files",
    env,
  );
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => !isUnder(path.join(repoRoot, file), reviewsRoot()))
    .sort();
}

/**
 * Working-tree content for the paths the panel read, plus the untracked names.
 *
 * A verdict is recorded against a hash captured before the gated command runs.
 * Anything that mutates the tree inside that same command — a heredoc adding a
 * file, a codegen step, a pre-commit hook that restages — would otherwise be
 * committed under a report claiming these exact bits were cleared.
 */
export interface TreeSnapshot {
  /** path to the git blob hash of the working content, or a marker when absent or unreadable. */
  contents: Record<string, Digest>;
  untracked: string[];
}

/**
 * What a path holds at review time. Three outcomes, typed as three: a missing
 * file and an unreadable one both fail to produce a digest, and collapsing them
 * makes an OS error read as a content edit — the drift report then blames the
 * wrong thing, and a re-run cannot clear it.
 */
export type Digest = { kind: "hash"; hash: string } | { kind: "absent" } | { kind: "unreadable"; reason: string };

/** The digest's hash, when it has one. */
function digestHash(digest: Digest | undefined): string | undefined {
  return digest !== undefined && digest.kind === "hash" ? digest.hash : undefined;
}

/** Why a path produced no digest, when that is the reason. */
function digestFailure(digest: Digest | undefined): string | undefined {
  return digest !== undefined && digest.kind === "unreadable" ? digest.reason : undefined;
}

/** How many lines a patch runs — the reviewer's read budget is counted in lines. */
function countLines(text: string): number {
  if (text === "") return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** Whether `bytes` decodes as UTF-8. Bytes that do not would reach the patch as U+FFFD. */
function isUtf8(bytes: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * git's own content hash.
 *
 * Using sha1-of-`blob <len>` rather than a private digest makes a reviewed file
 * directly comparable to `git rev-parse <commit>:<path>` — which is the only way
 * to ask what a commit actually shipped without piping its bytes back in.
 */
function gitBlobHash(bytes: Buffer): string {
  return createHash("sha1").update(`blob ${bytes.length}\u0000`).update(bytes).digest("hex");
}

function digestPath(repoRoot: string, file: string): Digest {
  const full = path.join(repoRoot, file);
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return { kind: "hash", hash: gitBlobHash(Buffer.from(fs.readlinkSync(full), "utf-8")) };
    return { kind: "hash", hash: gitBlobHash(fs.readFileSync(full)) };
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: describeError(error) };
  }
}

export async function snapshotTree(repoRoot: string, files: string[]): Promise<TreeSnapshot> {
  const base = await diffBase(repoRoot, await resolveHead(repoRoot));
  const untracked = await withHeadIndex(repoRoot, base, (env) => listUntracked(repoRoot, env));
  return snapshotFrom(repoRoot, files, untracked);
}

function snapshotFrom(repoRoot: string, files: string[], untracked: string[]): TreeSnapshot {
  const contents: Record<string, Digest> = {};
  for (const file of files) contents[file] = digestPath(repoRoot, file);
  return { contents, untracked };
}

/**
 * What changed between the reviewed tree and the tree now.
 *
 * Only *new* untracked files count as drift. A commit turns untracked files into
 * tracked ones, so entries leaving that list is the expected shape of success.
 */
export function snapshotDrift(reviewed: TreeSnapshot, now: TreeSnapshot): string[] {
  const drift: string[] = [];
  const known = new Set(reviewed.untracked);
  for (const [file, reviewedDigest] of Object.entries(reviewed.contents)) {
    const current: Digest = now.contents[file] ?? { kind: "absent" };
    const why = digestFailure(reviewedDigest) ?? digestFailure(current);
    if (why !== undefined) {
      drift.push(`${file} could not be hashed on one side of the check (${why}) — its content was never compared`);
      continue;
    }
    if (digestHash(reviewedDigest) !== digestHash(current)) {
      drift.push(
        current.kind === "absent"
          ? `${file} was removed after the panel read it`
          : `${file} changed after the panel read it`,
      );
    }
  }
  for (const file of now.untracked) {
    if (!known.has(file)) drift.push(`${file} appeared after the panel read the tree`);
  }
  return drift;
}

/**
 * What a commit shipped, against what the panel read.
 *
 * A commit moves HEAD and leaves the worktree alone, so working-tree digests
 * cannot answer "did the committed bytes get reviewed?" — a stale or partial
 * stage commits content other than the worktree the panel read, and a
 * format-and-stage command can commit paths that were never in the changeset.
 * Only the reviewed worktree bytes count as reviewed.
 * Returns empty when no commit happened, because then nothing shipped.
 */
export async function committedDrift(repoRoot: string, headBefore: string, reviewed: TreeSnapshot): Promise<string[]> {
  const headAfter = (await gitOrThrow(repoRoot, ["rev-parse", "--verify", "HEAD"], "the outgoing HEAD")).trim();
  if (headAfter === "" || headAfter === headBefore) return [];

  const parent =
    headBefore === ""
      ? (await gitOrThrow(repoRoot, ["hash-object", "-t", "tree", "/dev/null"], "the empty tree")).trim()
      : headBefore;
  const changed = (
    await gitOrThrow(
      repoRoot,
      [...QUOTE_PREFIX, "diff", "--name-only", "-z", ...DIFF_FLAGS, parent, headAfter],
      "the committed paths",
    )
  )
    .split("\0")
    .filter(Boolean);

  const drift: string[] = [];
  for (const file of changed) {
    const committed = await committedBlob(repoRoot, headAfter, file);
    if (committed === undefined) {
      // The commit removed it. No new bytes ship, but a removal the panel was
      // never shown is still a change nobody reviewed.
      if (reviewed.contents[file] === undefined) {
        drift.push(`${file} was deleted by the commit and the panel was never shown it`);
      }
      continue;
    }
    const seen = reviewed.contents[file];
    if (seen !== undefined && seen.kind === "unreadable") {
      drift.push(
        `${file} could not be hashed when the panel read it (${seen.reason}) — the committed bytes were never compared`,
      );
      continue;
    }
    const reviewedHash = digestHash(seen);
    if (reviewedHash === undefined) {
      drift.push(`${file} was committed but the panel never read it`);
    } else if (reviewedHash !== committed) {
      drift.push(
        `${file} was committed with content other than the worktree bytes the panel read (a stale or partial stage? \`git add -A\` before committing)`,
      );
    }
  }
  return drift;
}

/**
 * The blob a commit holds for `file`, or undefined when it does not hold one.
 *
 * `ls-tree … -- <path>` rather than `rev-parse <commit>:<path>`: the revision
 * parser splits on the first `:`, so a path that contains one resolves to the
 * wrong blob — and this decides whether a commit counts as reviewed.
 */
async function committedBlob(repoRoot: string, commit: string, file: string): Promise<string | undefined> {
  const out = (
    await gitOrThrow(
      repoRoot,
      [...QUOTE_PREFIX, "ls-tree", "-z", commit, "--", file],
      `the committed content of ${file}`,
    )
  ).trim();
  if (out === "") return undefined;
  const sha = out.split("	")[0]?.split(" ")?.[2];
  return sha;
}

/** A numstat cell's line count; git's `-` for a binary file counts as none. */
function countCell(cell: string | undefined): number {
  const value = Number(cell ?? "0");
  return Number.isFinite(value) ? value : 0;
}

/**
 * Refuse a diff too large to buffer, before it is captured.
 *
 * Lines, not bytes: `--numstat` never materialises the diff in this process,
 * and at the patch's own budget a plausible 64 bytes per line is the point where
 * buffering stops fitting. Deliberately coarse — the byte-exact check runs on the
 * assembled patch afterwards and remains the authority.
 */
async function refuseOversizedDiff(repoRoot: string, base: string, env: GitEnv): Promise<void> {
  const numstat = await gitOrThrow(
    repoRoot,
    [...QUOTE_PREFIX, "diff", "--numstat", ...DIFF_FLAGS.filter((flag) => flag !== "--find-renames"), base, "--"],
    "the diff's size",
    env,
  );
  let lines = 0;
  for (const row of numstat.split("\n")) {
    if (row === "") continue;
    const [added, deleted] = row.split("\t");
    // git prints `-` for a binary file's counts. They bound nothing here, so
    // they read as zero lines: the guard bounds the text portion of the diff,
    // and the byte-exact check after assembly remains the authority over all of
    // it, binaries included.
    lines += countCell(added) + countCell(deleted);
  }
  if (lines > MAX_PATCH_BYTES / 64) {
    throw new ChangesetTooLargeError(
      `The tracked changes span more than ${MAX_PATCH_BYTES / 64} diff lines, over the ${MAX_PATCH_BYTES / 1024} KiB review limit. ` +
        "Split the change into smaller commits.",
    );
  }
}

/** The repository `cwd` resolves to, or a NotARepositoryError naming what git said. */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  const rootOut = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (rootOut.code !== 0) {
    throw new NotARepositoryError(
      `Not a git repository (searched up from ${cwd}): ${rootOut.stderr.trim() || "git rev-parse failed"}`,
    );
  }
  return rootOut.stdout.trim();
}

/**
 * Captures the outgoing changeset into `<reviewsRoot>/<repo>/<hash>/changeset.patch`.
 *
 * The patch is content-addressed: re-reviewing the same bits reuses the file,
 * and a reviewer handed a path can still open it after the session moves on.
 *
 * The store sits under the agent dir — see `reviewsRoot` in record.ts for where
 * that actually lands and why it can be inside a repository. Counting the record
 * files in the changeset they describe would let every review invalidate itself
 * by writing its own verdict down.
 */
export async function captureChangeset(cwd: string): Promise<Changeset> {
  const repoRoot = await resolveRepoRoot(cwd);
  const head = await resolveHead(repoRoot);
  const base = await diffBase(repoRoot, head);
  return withHeadIndex(repoRoot, base, (env) => captureAgainst(repoRoot, head, base, env));
}

async function captureAgainst(
  repoRoot: string,
  head: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Promise<Changeset> {
  // The full diffs are buffered several times over (raw, hash material, the
  // assembled patch), so a huge tracked diff would reach memory before the
  // budget check and OOM the session instead of naming the fix. Line counts
  // stream inside git, so they bound the capture cheaply and early. The exact
  // byte check still runs after assembly; this one only has to fire first.
  await refuseOversizedDiff(repoRoot, base, env);

  const diff = await gitOrThrow(
    repoRoot,
    [...QUOTE_PREFIX, "diff", ...DIFF_FLAGS, base, "--"],
    "the tracked changes",
    env,
  );

  const untrackedNames = await listUntracked(repoRoot, env);
  const untrackedFiles: UntrackedFile[] = [];
  // The budget is spent as files are read, so the sum of what is held in memory
  // stays bounded by the review limit rather than only the rendered patch.
  let budgetLeft = MAX_PATCH_BYTES;
  for (const file of untrackedNames) {
    const entry = readUntracked(repoRoot, file, budgetLeft);
    budgetLeft -= entry.bytes;
    untrackedFiles.push(entry);
  }

  const hashMaterial = [
    `HEAD ${head === "" ? "(unborn)" : head}`,
    diff,
    ...untrackedFiles.map((u) => `UNTRACKED ${u.mode}\t${u.file}\t${u.digest}`),
  ].join("\n");
  const hash = createHash("sha256").update(hashMaterial).digest("hex");

  const patch = [
    `Changeset ${hash}`,
    `Repository ${repoRoot}`,
    `Base ${head === "" ? "(no commits yet)" : head}`,
    "",
    "===== TRACKED DIFF (working tree vs HEAD) =====",
    diff === "" ? "(none)" : diff,
    "===== UNTRACKED FILES =====",
    ...(untrackedFiles.length === 0
      ? ["(none)"]
      : untrackedFiles.flatMap((u) => [
          `--- new file: ${u.file} (${u.mode}, ${u.bytes} bytes, sha256 ${u.digest}) ---`,
          u.text ?? `[binary or non-UTF-8 content, ${u.bytes} bytes — read it with a tool if it matters]`,
        ])),
  ].join("\n");

  if (Buffer.byteLength(patch) > MAX_PATCH_BYTES) {
    throw new ChangesetTooLargeError(
      `Changeset is ${Math.round(Buffer.byteLength(patch) / 1024)} KiB, over the ${MAX_PATCH_BYTES / 1024} KiB review limit. Split it into smaller commits.`,
    );
  }

  const patchPath = path.join(repoDir(repoRoot), hash, "changeset.patch");
  if (!fs.existsSync(patchPath)) {
    await fs.promises.mkdir(path.dirname(patchPath), { recursive: true });
    const tmp = `${patchPath}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, patch, "utf-8");
    await fs.promises.rename(tmp, patchPath);
  }

  const worktreePaths = await diffPaths(repoRoot, [...DIFF_FLAGS, base, "--"], env);
  const files = [...new Set([...worktreePaths, ...untrackedNames])].sort();
  const tree = await writeWorktreeTree(repoRoot, files, env);

  return {
    repoRoot,
    head,
    hash,
    tree,
    patchPath,
    files,
    untracked: untrackedNames,
    patchBytes: Buffer.byteLength(patch),
    patchLines: countLines(patch),
    isEmpty: diff.trim() === "" && untrackedNames.length === 0,
    snapshot: snapshotFrom(repoRoot, files, untrackedNames),
  };
}
