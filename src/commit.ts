/**
 * Detecting a `git commit` in a bash command, so the review gate can stand in
 * front of it.
 *
 * `git` must sit at the command position of a segment — start of the segment,
 * or after `env`/`sudo`/`time`-style wrappers and `NAME=value` assignments —
 * and `commit` must be its *subcommand*, the first non-option token after it.
 *
 * The subcommand anchor is what keeps a false positive cheap. A gated command
 * fans the whole panel out, and a panel costs minutes and real tokens, so every
 * word after `git` that merely happens to be `commit` (`git log --grep commit`,
 * `git revert commit`, a search for the string) would tax unrelated work. A
 * false positive that then fails to evaluate is a hard block on that work.
 *
 * What this deliberately misses: a commit built by another program (`make
 * commit`), one reached under an alias (`git ci`), and one nested more than one
 * shell deep (`bash -c 'bash -c "git commit"'`). One level of `-c` payload IS
 * followed, because a commit inside `bash -c "…"` is still a commit at a command
 * position and missing it would let the gate stamp bytes it never read. Deeper
 * nesting means parsing quoting properly, which this does not. Those misses are
 * rarer than the mentions this excludes, and the model is told to call
 * `adversarial_review` itself rather than rely on the hook.
 * A `commit` inside a heredoc body still reads as a command position and gates;
 * that errs toward reviewing too much, never toward clearing unreviewed bits.
 */

/** Shell control operators that end one command and start another. */
const SEGMENT_SPLIT = /\|\||&&|[;\n|&()]/;

/** Wrappers that run another command and so do not occupy the command position. */
const WRAPPERS = new Set(["env", "sudo", "command", "time", "nice", "nohup", "stdbuf", "timeout", "watch"]);

/**
 * git's global options that consume the next token, so the subcommand is not
 * what follows them. Without this, `git --work-tree /other commit` reads `/other`
 * as the subcommand and the commit goes ungated.
 */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix"]);

export function looksLikeGitCommit(command: string): boolean {
  return expandSegments(command, 1).some((segment) => findCommit(segment.tokens) !== undefined);
}

/**
 * A way a gated commit could land outside the repository the panel read.
 *
 * Not multi-repository support: the gate still reviews only the session's
 * repository. It exists so the hook can refuse a commit it cannot clear instead
 * of stamping it "every reviewer cleared these exact bits" — a commit elsewhere
 * would otherwise collect an all-clear the panel never earned, and the
 * post-commit re-check would inspect the session repository, see HEAD unmoved,
 * and report no drift.
 *
 * Refusing is the whole feature. The alternative — reviewing the other
 * repository — is what the user ruled out as too rare to build, and it is also
 * the wrong shape: a panel cannot read two trees at once and say one verdict.
 */
export interface CommitEscape {
  /** What moved, for the refusal message. */
  how: string;
  /** Path whose repository has to be compared against the session's. */
  path: string;
}

/** git's own repository selectors, whether attached with `=` or space-separated. */
const REPOSITORY_OPTIONS = new Set(["-C", "--git-dir", "--work-tree"]);

/** Environment that relocates a repository without naming it on the command line. */
const REPOSITORY_ENV = new Set(["GIT_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]);

/** Shell builtins that change the directory a later segment runs in. */
const DIRECTORY_COMMANDS = new Set(["cd", "pushd", "dir"]);

/** Shells whose `-c` payload is a command line of its own. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

interface Segment {
  raw: string[];
  tokens: string[];
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Raw `NAME=value`, unquoted. A quoted one is prose, not an assignment. */
const RAW_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=([^"'].*)$/;

/**
 * Every way this command could commit somewhere other than where it started,
 * in the order they appear. Callers resolve each against the session repository
 * and refuse on the first one that does not match.
 *
 * Deliberately over-inclusive: an unresolvable `cd` counts, because the claim
 * being protected is "these exact bits" and a directory the hook cannot follow
 * is a directory it cannot vouch for.
 */
export function commitEscapes(command: string): CommitEscape[] {
  const segments = expandSegments(command, 1);
  const escapes: CommitEscape[] = [];
  for (const [index, segment] of segments.entries()) {
    const commit = findCommit(segment.tokens);
    if (commit === undefined) continue;
    // Every earlier segment runs before this commit, so a `cd` in any of them
    // moves the directory this commit operates on.
    for (const earlier of segments.slice(0, index)) {
      for (const escape of segmentEscapes(earlier.raw)) {
        // Several commits in one command each see the same earlier move; the
        // refusal reports it once.
        if (!escapes.some((seen) => seen.how === escape.how)) escapes.push(escape);
      }
    }
    for (const escape of repositoryOptions(segment.tokens.slice(commit.gitIndex + 1, commit.subcommandIndex))) {
      escapes.push(escape);
    }
    for (const token of segment.raw.slice(0, commit.gitIndex)) {
      const match = RAW_ASSIGNMENT.exec(token);
      const name = match?.[1] ?? "";
      const value = match?.[2] ?? "";
      if (REPOSITORY_ENV.has(name) && value !== "") {
        escapes.push({ how: `${name}=${value}`, path: value });
      }
    }
  }
  return escapes;
}

/**
 * The command line split into segments, with one level of shell `-c` payloads
 * expanded into segments of their own.
 *
 * A commit inside `bash -c "…"` is still a commit at a command position, so
 * refusing it costs nothing and missing it would let the gate stamp bytes it
 * never read. Nesting is not followed beyond one level: a payload that itself
 * shells out is rarer still, and chasing it means parsing quoting properly.
 */
function expandSegments(command: string, depth: number): Segment[] {
  const out: Segment[] = [];
  for (const piece of command.split(SEGMENT_SPLIT)) {
    const raw = piece.split(/\s+/).filter(Boolean);
    const tokens = raw.map(stripQuotes).filter(Boolean);
    out.push({ raw, tokens });
    if (depth <= 0) continue;
    const payload = shellPayloadTokens(tokens);
    if (payload !== undefined) out.push(...expandSegments(payload.join(" "), depth - 1));
  }
  return out;
}

/** The command line a shell would run, when this segment starts one. */
function shellPayloadTokens(tokens: string[]): string[] | undefined {
  let index = 0;
  while (tokens[index] !== undefined && (ASSIGNMENT.test(tokens[index] ?? "") || WRAPPERS.has(tokens[index] ?? ""))) {
    index += 1;
  }
  const shell = tokens[index];
  if (shell === undefined || !SHELLS.has(shell)) return undefined;
  for (let at = index + 1; at < tokens.length; at += 1) {
    const token = tokens[at];
    if (token === undefined || token.startsWith("-")) continue;
    // The first bare word after the shell's flags is its `-c` payload.
    if (tokens[at - 1] === "-c") return tokens.slice(at);
  }
  return undefined;
}

/**
 * Everything a segment does that could move a later commit: a `cd`/`pushd`, and
 * any repository env it sets.
 *
 * The env scan reads raw tokens, so a quoted `"GIT_DIR=/x"` inside a message or
 * a grep pattern is not mistaken for an assignment. A bare `cd` with no target
 * goes to $HOME, which is outside the tree unless the repository is $HOME.
 */
function segmentEscapes(raw: string[]): CommitEscape[] {
  const escapes: CommitEscape[] = [];
  for (const token of raw) {
    const match = RAW_ASSIGNMENT.exec(token);
    const name = match?.[1] ?? "";
    const value = match?.[2] ?? "";
    if (REPOSITORY_ENV.has(name) && value !== "") {
      escapes.push({ how: `${name}=${value}`, path: value });
    }
  }
  const tokens = raw.map(stripQuotes).filter(Boolean);
  let index = 0;
  while (tokens[index] !== undefined && (ASSIGNMENT.test(tokens[index] ?? "") || WRAPPERS.has(tokens[index] ?? ""))) {
    index += 1;
  }
  const command = tokens[index];
  if (command === undefined || !DIRECTORY_COMMANDS.has(command)) return escapes;
  const target = tokens.slice(index + 1).find((token) => !token.startsWith("-"));
  const home = process.env.HOME ?? "";
  if (target === undefined) {
    // `cd` and `pushd` with no argument land in $HOME; `dir` has no such default.
    if (home !== "" && (command === "cd" || command === "pushd")) {
      escapes.push({ how: `${command} (to $HOME)`, path: home });
    }
    return escapes;
  }
  escapes.push({ how: `${command} ${target}`, path: target });
  return escapes;
}

function repositoryOptions(tokens: string[]): CommitEscape[] {
  const escapes: CommitEscape[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (token.startsWith("--") && token.includes("=")) {
      const [flag, ...rest] = token.split("=");
      const value = rest.join("=");
      if (REPOSITORY_OPTIONS.has(flag ?? "") && value !== "") escapes.push({ how: token, path: value });
      continue;
    }
    // git's short options attach to the flag: `-C.` is `-C .`.
    if (token.startsWith("-C") && token.length > 2) {
      escapes.push({ how: token, path: token.slice(2) });
      continue;
    }
    if (REPOSITORY_OPTIONS.has(token)) {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("-")) escapes.push({ how: `${token} ${value}`, path: value });
    }
  }
  return escapes;
}

interface CommitPosition {
  /** Index of the `git` token itself. */
  gitIndex: number;
  /** Index of the `commit` subcommand token. */
  subcommandIndex: number;
}

function findCommit(tokens: string[]): CommitPosition | undefined {
  const gitIndex = commandPosition(tokens);
  if (gitIndex === undefined) return undefined;
  const subcommand = gitSubcommand(tokens, gitIndex + 1);
  return subcommand?.token === "commit" ? { gitIndex, subcommandIndex: subcommand.index } : undefined;
}

/** Index of the leading `git`, past assignments and wrappers; undefined if the segment does not start with one. */
function commandPosition(tokens: string[]): number | undefined {
  let index = 0;
  // Wrappers differ in how many options they accept, but the value they gate on
  // (a duration, a priority, a user) is the first bare word after them, and
  // `sudo git commit` has no such word at all. Stopping short of consuming `git`
  // is what keeps the bare forms working while `timeout 300 git commit` and
  // `sudo -u bob git commit` still reach the subcommand.
  let awaitingWrapperArg = false;
  for (const token of tokens) {
    if (ASSIGNMENT.test(token)) {
      index += 1;
      continue;
    }
    if (WRAPPERS.has(token)) {
      awaitingWrapperArg = true;
      index += 1;
      continue;
    }
    if (awaitingWrapperArg) {
      awaitingWrapperArg = false;
      if (token.startsWith("-")) {
        awaitingWrapperArg = true;
        index += 1;
        continue;
      }
      if (!(token === "git" || token.endsWith("/git"))) {
        index += 1;
        continue;
      }
    }
    break;
  }

  const git = tokens[index];
  return git !== undefined && (git === "git" || git.endsWith("/git")) ? index : undefined;
}

/** The subcommand at or after `start`, skipping git's own global options. */
function gitSubcommand(tokens: string[], start: number): { index: number; token: string } | undefined {
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) continue;
    if (GIT_OPTIONS_WITH_VALUE.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith("-")) continue;
    return { index, token };
  }
  return undefined;
}

/** `git commit -m "msg"` arrives with quotes glued to the words that matter. */
function stripQuotes(token: string): string {
  return token.replace(/^["'`]+|["'`]+$/g, "");
}
