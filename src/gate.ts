/**
 * The review gate: decide which reviewers owe a verdict for these exact bits,
 * run only those, and record what comes back.
 *
 * A reviewer's verdict is valid only for the changeset hash it was produced
 * against *and* the reviewer spec that produced it — a spec edit invalidates
 * that reviewer's history, because the old pass did not enforce what the new
 * one does.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { type Changeset, captureChangeset, type Interdiff, type TreeSnapshot, writeInterdiff } from "./changeset.ts";
import { loadPrompt } from "./prompts.ts";
import {
  approvalProtocol,
  isBlocking,
  moderationProtocol,
  parseRecord,
  parseRuling,
  RECORD_FENCE,
} from "./protocol.ts";
import {
  type AgentState,
  type ClearedItem,
  type Finding,
  loadRecord,
  type Moderation,
  repoDir,
  type Severity,
  saveRecord,
  specHash,
  type Verdict,
  writeReport,
} from "./record.ts";
import {
  buildDispatch,
  CHILD_ENV,
  type Dispatch,
  type DispatchHost,
  getFinalOutput,
  isFailedResult,
  runSingleAgent,
  type SingleResult,
  truncateOutput,
} from "./runner.ts";
import type { Semaphore } from "./semaphore.ts";
import { type AgentConfig, type AgentDiscoveryResult, discoverModerator, discoverReviewers } from "./specs.ts";
import { describeError, safeName } from "./util.ts";
import { keepWarm, loadWarm, pruneWarm, type WarmStart } from "./warm.ts";

export interface ReviewDeps {
  gate: Semaphore;
}

export interface ReviewRequest {
  cwd: string;
  host: DispatchHost;
  intent: string;
  /** The author's note to the moderator; reviewers never see it. "" when there is none. */
  context: string;
  trigger: "manual" | "commit";
  signal: AbortSignal | undefined;
}

export interface ModerationSummary {
  /** undefined when the moderator could not produce a usable ruling. */
  overturn: boolean | undefined;
  /** This run produced the ruling, as opposed to a standing one for these bits. */
  ran: boolean;
  /** It ruled as a continuation of its own earlier ruling on this HEAD. */
  warm: boolean;
  model: string;
  prose: string;
  failure: string;
  reportPath: string;
}

export interface AggregatedFinding {
  agent: string;
  severity: Severity;
  file: string;
  line: string;
  problem: string;
  fix: string;
}

export interface ReviewerSummary {
  agent: string;
  verdict: Verdict;
  /** This run produced the verdict, as opposed to a cached PROCEED for these bits. */
  ran: boolean;
  /** It ran as a continuation of its own earlier review on this HEAD. */
  warm: boolean;
  model: string;
  findings: Finding[];
  cleared: ClearedItem[];
  note: string;
  failure: string;
  reportPath: string;
  /** The reviewer's own report, verbatim, when it ran now. */
  prose: string;
}

export interface ReviewOutcome {
  /** The panel's own verdict, before any moderation. */
  verdict: Verdict;
  /** These exact bits may be committed: the panel proceeded, or the moderator overturned its BLOCK. */
  cleared: boolean;
  /** Present when the panel blocked and the moderator was consulted. */
  moderation: ModerationSummary | undefined;
  repoRoot: string;
  /** HEAD when the verdict was computed; "" on an unborn branch. */
  head: string;
  changesetHash: string;
  files: string[];
  reviewers: ReviewerSummary[];
  findings: AggregatedFinding[];
  disagreements: string[];
  warnings: string[];
  recordPath: string;
  reportsDir: string;
  report: string;
  /** Digests of the tree the panel actually read, for re-checking at commit time. */
  snapshot: TreeSnapshot;
}

/** Reviews already running, keyed by repo and bits, so a repeated commit fans out once. */
const inFlight = new Map<string, Promise<ReviewOutcome>>();

/**
 * One panel per repository at a time. Two panels on different bits would both
 * resume the same warm sessions, and the second to finish would overwrite the
 * first's kept state with a session that never saw it.
 */
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const previous = repoLocks.get(repoRoot) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  repoLocks.set(repoRoot, tail);
  void tail.then(() => {
    if (repoLocks.get(repoRoot) === tail) repoLocks.delete(repoRoot);
  });
  return next;
}

const SEVERITY_ORDER: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Report budgets. pi truncates any tool result over 50 KiB (DEFAULT_MAX_BYTES)
 * and cuts the tail, which is where a report would otherwise put its verdict and
 * its paths — so the caps sit well under that, the verdict and paths go first,
 * and the verbatim prose goes last because it is already on disk in full.
 */
const TOTAL_REPORT_CAP = 32 * 1024;
const PER_REVIEWER_REPORT_CAP = 6 * 1024;
const MODERATOR_REPORT_CAP = 8 * 1024;

interface PanelMember {
  agent: AgentConfig;
  hash: string;
}

function buildModerator(panel: PanelMember[]): PanelMember {
  const found = discoverModerator();
  const prompt = `${found.systemPrompt.trimEnd()}\n${moderationProtocol()}`;
  const spec = JSON.stringify([found.name, found.tools ?? [], found.model ?? "", prompt]);
  // Its report is written beside the panel's, under the same sanitised naming.
  if (panel.some((member) => safeName(member.agent.name) === safeName(found.name))) {
    throw new Error(`The moderator "${found.name}" shares a report name with a reviewer; rename one of them.`);
  }
  return { agent: { ...found, systemPrompt: prompt }, hash: specHash(spec) };
}

/**
 * The gate refuses to run without a project context file, because the panel
 * has no other way to learn what the project is or whom it must defend against.
 * Read through pi's own loader, so "present" means exactly what reviewers load.
 */
export function requireProjectContext(repoRoot: string): void {
  const root = fs.realpathSync(repoRoot);
  const atRoot = loadProjectContextFiles({ cwd: repoRoot, agentDir: getAgentDir() }).some(
    (file) => fs.realpathSync(path.dirname(file.path)) === root && file.content.trim() !== "",
  );
  if (atRoot) return;
  throw new Error(
    [
      `${repoRoot} has no project context file (AGENTS.md) at its root, so the review panel has nothing to judge severity against and will not run.`,
      "Write one there before asking for review. Every reviewer and the moderator load it. Keep it short and include:",
      "- What the project is and who uses it (one user? a team? the public?).",
      "- The trust model: who and what is trusted, and the threats the code actually has to defend against.",
      "- The stage of development, so reviewers know how hard to harden (prototype, pre-release, production).",
      "- Where the plan of work lives, so a finding that belongs to later work can be recognized as such.",
    ].join("\n"),
  );
}

function buildPanel(): { panel: PanelMember[]; discovery: AgentDiscoveryResult } {
  const found = discoverReviewers();
  const panel = found.reviewers.map((reviewer) => {
    // Each reviewer is told who else is on the panel, from their own spec
    // descriptions, so its sense of "someone else covers that" can't go stale.
    const others = found.reviewers
      .filter((other) => other.name !== reviewer.name)
      .map((other) => ({ name: other.name, description: other.description }));
    const prompt = `${reviewer.systemPrompt.trimEnd()}\n${approvalProtocol(others)}`;
    // The whole spec, not just the body: frontmatter decides what a reviewer may
    // inspect, so editing `tools:` or `model:` has to invalidate the verdicts it
    // earned under the old capability set.
    const spec = JSON.stringify([reviewer.name, reviewer.tools ?? [], reviewer.model ?? "", prompt]);
    return { agent: { ...reviewer, systemPrompt: prompt }, hash: specHash(spec) };
  });

  // Sanitised, not raw: the report file name is safeName of the agent name, and
  // two names that collapse to the same string would write one report over the
  // other while both pointers named that file.
  const names = panel.map((member) => safeName(member.agent.name));
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(`Reviewer names collide once sanitised in ${found.dir}: ${[...new Set(duplicates)].join(", ")}.`);
  }
  return {
    panel,
    // discoverReviewers has already thrown if any spec was unreadable, so a
    // partial panel is not a state this gate can be in.
    discovery: { agents: panel.map((member) => member.agent), skipped: [] },
  };
}

/** Neutral by construction: scope, path, intent. No reading of the diff, no justification. */
function reviewerTask(changeset: Changeset, intent: string): string {
  return [
    `Review the changeset at ${changeset.patchPath} — read that file first, in full, then open any project files you need to judge candidates.`,
    // Says the line count because "in full" has to be checkable: a reviewer that
    // stops at the first page can otherwise emit a PROCEED quantified over
    // bytes nobody read, and nothing downstream notices.
    `The patch runs ${changeset.patchLines} line(s); a single read caps at 2000 lines, so expect at least ${Math.ceil(changeset.patchLines / 2000)} read(s) to cover it.`,
    `Scope: ${changeset.repoRoot}, ${changeset.files.length} file(s) differing from HEAD (${changeset.untracked.length} untracked), ${Math.max(1, Math.round(changeset.patchBytes / 1024))} KiB patch.`,
    `Intent: ${intent}`,
    recordInstruction(),
  ].join("\n");
}

function recordInstruction(): string {
  return `Produce your report exactly per your output contract. Your final message must end with exactly one \`\`\`${RECORD_FENCE}\`\`\` block as the last thing you write — a report without a valid record block is discarded, the review is recorded as INCOMPLETE, and you will be run again.`;
}

const deltaPrompt = loadPrompt("delta");
const deltaNonePrompt = loadPrompt("delta-none");
const rereviewPrompt = loadPrompt("rereview");
const remoderatePrompt = loadPrompt("remoderate");

/** Names what changed since the member's last usable pass, from the two trees the passes read. */
function describeDelta(
  since: NonNullable<WarmStart["since"]>,
  changeset: Changeset,
  delta: Interdiff,
  verb: string,
): string {
  if (delta.files.length === 0) {
    return deltaNonePrompt({ verb, tree: changeset.tree, changeset: changeset.hash.slice(0, 16) });
  }
  return deltaPrompt({
    verb,
    sinceTree: since.tree,
    sinceChangeset: since.changesetHash.slice(0, 16),
    tree: changeset.tree,
    changeset: changeset.hash.slice(0, 16),
    deltaPath: delta.path,
    deltaLines: String(delta.lines),
    deltaFileCount: String(delta.files.length),
    deltaFiles:
      delta.files.slice(0, 40).join(", ") + (delta.files.length > 40 ? `, and ${delta.files.length - 40} more` : ""),
  });
}

/**
 * A re-review in the reviewer's own continued session. The delta is computed,
 * not described by the author, and the verdict still has to cover the whole
 * changeset: a fix can break code the delta does not touch.
 */
function warmReviewerTask(
  changeset: Changeset,
  intent: string,
  since: NonNullable<WarmStart["since"]>,
  delta: Interdiff,
): string {
  return rereviewPrompt({
    delta: describeDelta(since, changeset, delta, "review"),
    patchPath: changeset.patchPath,
    patchLines: String(changeset.patchLines),
    fileCount: String(changeset.files.length),
    intent,
    recordInstruction: recordInstruction(),
  });
}

/** A member's start for this pass, with the delta written when it resumes warm. */
async function startFor(
  changeset: Changeset,
  member: PanelMember,
  warnings: string[],
): Promise<{ warm: WarmStart; delta: Interdiff | undefined }> {
  const warm = await loadWarm(changeset.repoRoot, changeset.head, member.agent.name, member.hash, warnings);
  if (warm.since === undefined) return { warm, delta: undefined };
  return { warm, delta: await writeInterdiff(changeset, warm.since.tree) };
}

/** Keeps a usable run's session warm for the next pass; a failure to keep it costs only warmth. */
async function keepIfUsable(
  changeset: Changeset,
  member: PanelMember,
  result: SingleResult,
  usable: boolean,
  warnings: string[],
): Promise<void> {
  const kept = result.session;
  if (kept === undefined) return;
  try {
    if (!usable) return;
    await keepWarm(
      changeset.repoRoot,
      changeset.head,
      {
        agent: member.agent.name,
        specHash: member.hash,
        sessionId: kept.id,
        tree: changeset.tree,
        changesetHash: changeset.hash,
      },
      kept.dir,
    );
  } catch (error) {
    warnings.push(
      `${member.agent.name}'s session could not be kept warm; its next pass starts cold (${describeError(error)})`,
    );
  } finally {
    await fs.promises.rm(kept.dir, { recursive: true, force: true });
  }
}

export async function runReview(deps: ReviewDeps, request: ReviewRequest): Promise<ReviewOutcome> {
  // Reviewers are subagents. A panel dispatched from inside one would spawn
  // panels that spawn panels, so the recursion is cut here rather than trusted
  // to the caller not to ask.
  if (process.env[CHILD_ENV] === "1") {
    // Names the variable: a user or CI harness that exports it makes every
    // commit refuse, and without the cause in the message there is nothing to
    // find and unset.
    throw new Error(
      `${CHILD_ENV} is set to 1 in this process, so the adversarial review panel refuses — reviewers are subagents, ` +
        "and a panel dispatched from inside one would spawn panels without end. If this is a subagent, return the work to " +
        "the session that owns the change. If this is the host session, unset " +
        `${CHILD_ENV} before starting pi.`,
    );
  }

  const { panel, discovery } = buildPanel();
  const moderator = buildModerator(panel);
  const warnings: string[] = [];
  const changeset = await captureChangeset(request.cwd);
  const reportsDir = path.dirname(changeset.patchPath);
  const recordPath = path.join(repoDir(changeset.repoRoot), `${changeset.hash}.json`);

  if (changeset.isEmpty) {
    const reviewers: ReviewerSummary[] = panel.map(
      (member): ReviewerSummary => ({
        agent: member.agent.name,
        verdict: "PROCEED",
        ran: false,
        warm: false,
        model: "",
        findings: [],
        cleared: [],
        note: "",
        failure: "",
        reportPath: "",
        prose: "",
      }),
    );
    return {
      verdict: "PROCEED",
      cleared: true,
      moderation: undefined,
      repoRoot: changeset.repoRoot,
      head: changeset.head,
      changesetHash: changeset.hash,
      files: [],
      reviewers,
      findings: [],
      disagreements: [],
      warnings,
      recordPath,
      reportsDir,
      snapshot: changeset.snapshot,
      report: `Adversarial review — nothing to review.\n${changeset.repoRoot} has no changes against HEAD and no untracked files, so no reviewer ran.`,
    };
  }

  requireProjectContext(changeset.repoRoot);

  const key = `${changeset.repoRoot}\u0000${changeset.hash}`;
  const running = inFlight.get(key);
  if (running !== undefined) {
    return running.then((outcome) => ({
      ...outcome,
      warnings: [...outcome.warnings, "joined a review already running for these exact bits"],
    }));
  }

  const run = withRepoLock(changeset.repoRoot, () =>
    runPanel(deps, request, { panel, moderator, discovery, changeset, recordPath, reportsDir }, warnings),
  ).finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

/** Everything one panel run needs, captured together because it describes one changeset. */
interface PanelRun {
  panel: PanelMember[];
  moderator: PanelMember;
  discovery: AgentDiscoveryResult;
  changeset: Changeset;
  recordPath: string;
  reportsDir: string;
}

async function runPanel(
  deps: ReviewDeps,
  request: ReviewRequest,
  run: PanelRun,
  warnings: string[],
): Promise<ReviewOutcome> {
  const { panel, moderator, discovery, changeset, recordPath, reportsDir } = run;
  const dispatch: Dispatch = buildDispatch(request.host, deps.gate);

  const loaded = await loadRecord(changeset.repoRoot, changeset.hash);
  if (loaded.warning !== undefined) warnings.push(loaded.warning);
  await pruneWarm(changeset.repoRoot, changeset.head, warnings);

  // Only a PROCEED from this exact spec for these exact bits counts as done.
  // A Map, not a Record: a reviewer being absent is a state the code branches on
  // constantly, and an index type that calls it present leaves every one of
  // those branches unchecked.
  const states = new Map<string, AgentState>();
  for (const [name, state] of Object.entries(loaded.record?.agents ?? {})) {
    const member = panel.find((candidate) => candidate.agent.name === name);
    if (member !== undefined && state.specHash === member.hash) states.set(name, state);
  }
  // An overturn already ruled for these bits, over the very reports still on
  // record, settles them: re-running the blockers would only re-roll the dice
  // on a question the moderator has answered.
  const standing = standingOverturn(loaded.record?.moderation, moderator.hash, panel, states);
  const owed =
    standing === undefined ? panel.filter((member) => states.get(member.agent.name)?.verdict !== "PROCEED") : [];

  // A cached PROCEED was recorded against some intent. If the stated intent has
  // moved on, say so rather than quietly reusing verdicts that judged a
  // different question.
  const recordedIntent = loaded.record?.intent;
  if (owed.length < panel.length && recordedIntent !== undefined && recordedIntent !== request.intent) {
    warnings.push(
      `${panel.length - owed.length} cached verdict(s) were recorded against a different intent: "${recordedIntent.slice(0, 160)}"`,
    );
  }

  const prose = new Map<string, string>();
  const ranWarm = new Set<string>();

  const dispatchPanel = async (members: PanelMember[]): Promise<PanelMember[]> => {
    if (members.length === 0) return [];
    const results = await Promise.all(
      members.map(async (member) => {
        const { warm, delta } = await startFor(changeset, member, warnings);
        const task =
          warm.since === undefined || delta === undefined
            ? reviewerTask(changeset, request.intent)
            : warmReviewerTask(changeset, request.intent, warm.since, delta);
        const result = await runSingleAgent(
          changeset.repoRoot,
          dispatch,
          discovery,
          (partial: SingleResult[]) => ({ results: partial }),
          {
            agentName: member.agent.name,
            task,
            signal: request.signal,
            session: { seedDir: warm.seedDir, id: warm.sessionId },
          },
        );
        return { member, result, delta };
      }),
    );

    for (const { member, result, delta } of results) {
      const name = member.agent.name;
      if (delta === undefined) ranWarm.delete(name);
      else ranWarm.add(name);
      let usable = false;
      try {
        const output = getFinalOutput(result.messages);
        prose.set(name, output);
        const reportPath = await writeReport(changeset.repoRoot, changeset.hash, name, output || result.stderr);
        const base = {
          agent: name,
          specHash: member.hash,
          model: result.model ?? "session default",
          at: new Date().toISOString(),
          reportPath,
        };
        const incomplete = (why: string): AgentState => ({
          ...base,
          verdict: "INCOMPLETE",
          findings: [],
          cleared: [],
          note: "",
          failure: why,
        });

        if (isFailedResult(result)) {
          states.set(
            name,
            incomplete(result.errorMessage || result.stderr.trim() || `reviewer process exited ${result.exitCode}`),
          );
          continue;
        }

        // A reviewer that ran nothing cannot have read the patch. This is the hard
        // floor only: whether it opened the patch itself is reported, not
        // enforced, because a reviewer that inspected the changed files directly
        // did read the change and must not be failed for the way it read it.
        const usedTools = result.messages.some(
          (m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall"),
        );
        if (!usedTools) {
          states.set(
            name,
            incomplete(
              `ended after ${result.usage.turns} assistant turn(s) without running any tool; the patch was never opened`,
            ),
          );
          continue;
        }
        // A warm reviewer is pointed at the delta first, and has read the
        // patch's earlier version in its own session; either read counts.
        const readable = delta === undefined ? [changeset.patchPath] : [changeset.patchPath, delta.path];
        const openedPatch = result.messages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.some(
              (p) => p.type === "toolCall" && readable.some((file) => JSON.stringify(p.arguments).includes(file)),
            ),
        );
        if (!openedPatch) {
          warnings.push(
            `${name} recorded a verdict without opening ${readable.join(" or ")}; it may have judged the changed files rather than the patch`,
          );
        }

        const parsed = parseRecord(output);
        usable = parsed.ok;
        states.set(
          name,
          parsed.ok ? { ...base, ...parsed.record } : incomplete(`output was not a usable record: ${parsed.error}`),
        );
      } finally {
        await keepIfUsable(changeset, member, result, usable, warnings);
      }
    }

    return members;
  };

  const firstPass = await dispatchPanel(owed);

  // A reviewer that produced nothing usable is a harness miss, not a verdict.
  // Re-run exactly those, once, before letting the miss block a commit.
  const flaked = firstPass.filter((member) => states.get(member.agent.name)?.verdict === "INCOMPLETE");
  if (flaked.length > 0 && request.signal?.aborted !== true) {
    warnings.push(`re-ran ${flaked.map((m) => m.agent.name).join(", ")} once after an unusable result`);
    await dispatchPanel(flaked);
  }

  for (const member of panel) {
    if (states.get(member.agent.name) === undefined) {
      warnings.push(`${member.agent.name} owes a verdict for these bits and did not produce one`);
    }
  }

  const panelVerdict: Verdict = panel.some((m) => (states.get(m.agent.name)?.verdict ?? "INCOMPLETE") === "INCOMPLETE")
    ? "INCOMPLETE"
    : panel.some((m) => states.get(m.agent.name)?.verdict === "BLOCK")
      ? "BLOCK"
      : "PROCEED";

  // Only a BLOCK is moderated. INCOMPLETE means the panel never finished, and
  // a moderator ruling over missing reports would be ruling over nothing.
  let ruling: Moderation | undefined = standing;
  let moderation: ModerationSummary | undefined =
    standing === undefined
      ? undefined
      : {
          overturn: true,
          ran: false,
          warm: false,
          model: standing.model,
          prose: "",
          failure: "",
          reportPath: standing.reportPath,
        };
  if (panelVerdict === "BLOCK" && standing === undefined && request.signal?.aborted !== true) {
    const moderated = await moderate(changeset, request, dispatch, moderator, panel, states, warnings);
    ruling = moderated.ruling;
    moderation = moderated.summary;
  }

  warnings.push(
    ...(await saveRecord({
      version: 1,
      repoRoot: changeset.repoRoot,
      changesetHash: changeset.hash,
      intent: request.intent,
      updatedAt: new Date().toISOString(),
      agents: Object.fromEntries(states),
      moderation: ruling,
    })),
  );

  const reviewers: ReviewerSummary[] = panel.map((member) => {
    const name = member.agent.name;
    const state = states.get(name);
    return {
      agent: name,
      verdict: state?.verdict ?? "INCOMPLETE",
      ran: owed.some((candidate) => candidate.agent.name === name),
      warm: ranWarm.has(name),
      model: state?.model ?? "",
      findings: state?.findings ?? [],
      cleared: state?.cleared ?? [],
      note: state?.note ?? "",
      failure: state?.failure ?? (state === undefined ? "no verdict recorded for these bits" : ""),
      reportPath: state?.reportPath ?? "",
      prose: prose.get(name) ?? "",
    };
  });

  const verdict = panelVerdict;
  const cleared = verdict === "PROCEED" || (verdict === "BLOCK" && moderation?.overturn === true);

  const findings: AggregatedFinding[] = panel.flatMap((member) =>
    (states.get(member.agent.name)?.findings ?? []).map((finding) => ({ agent: member.agent.name, ...finding })),
  );
  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file));

  const outcome: ReviewOutcome = {
    verdict,
    cleared,
    moderation,
    repoRoot: changeset.repoRoot,
    head: changeset.head,
    changesetHash: changeset.hash,
    files: changeset.files,
    reviewers,
    findings,
    disagreements: findDisagreements(reviewers),
    warnings,
    recordPath,
    reportsDir,
    snapshot: changeset.snapshot,
    report: "",
  };
  outcome.report = renderReport(outcome, changeset, request);
  return outcome;
}

/** A recorded overturn that still covers the reports on record, or undefined. */
export function standingOverturn(
  ruling: Moderation | undefined,
  moderatorHash: string,
  panel: PanelMember[],
  states: Map<string, AgentState>,
): Moderation | undefined {
  if (ruling === undefined || !ruling.overturn || ruling.specHash !== moderatorHash) return undefined;
  if (Object.keys(ruling.judged).length !== panel.length) return undefined;
  for (const member of panel) {
    const state = states.get(member.agent.name);
    if (state === undefined || ruling.judged[member.agent.name] !== state.at) return undefined;
  }
  return ruling;
}

async function moderate(
  changeset: Changeset,
  request: ReviewRequest,
  dispatch: Dispatch,
  moderator: PanelMember,
  panel: PanelMember[],
  states: Map<string, AgentState>,
  warnings: string[],
): Promise<{ ruling: Moderation | undefined; summary: ModerationSummary }> {
  const name = moderator.agent.name;
  const discovery: AgentDiscoveryResult = { agents: [moderator.agent], skipped: [] };
  const coldTask = moderatorTask(changeset, request, panel, states);
  const judged = Object.fromEntries(
    panel.map((member) => [member.agent.name, states.get(member.agent.name)?.at ?? ""]),
  );

  // Same contract as a reviewer: one re-run after an unusable result, and a
  // failure after that leaves the BLOCK standing rather than reading as a ruling.
  let failure = "";
  let reportPath = "";
  let model = "";
  for (let attempt = 0; attempt < 2 && request.signal?.aborted !== true; attempt += 1) {
    if (attempt > 0) warnings.push(`re-ran the moderator once after an unusable ruling: ${failure}`);
    const { warm, delta } = await startFor(changeset, moderator, warnings);
    const task =
      warm.since === undefined || delta === undefined
        ? coldTask
        : remoderatePrompt({ delta: describeDelta(warm.since, changeset, delta, "ruling"), task: coldTask });
    const result = await runSingleAgent(
      changeset.repoRoot,
      dispatch,
      discovery,
      (partial: SingleResult[]) => ({ results: partial }),
      {
        agentName: name,
        task,
        signal: request.signal,
        session: { seedDir: warm.seedDir, id: warm.sessionId },
      },
    );
    let usable = false;
    try {
      const output = getFinalOutput(result.messages);
      reportPath = await writeReport(changeset.repoRoot, changeset.hash, name, output || result.stderr);
      model = result.model ?? "session default";

      if (isFailedResult(result)) {
        failure = result.errorMessage || result.stderr.trim() || `moderator process exited ${result.exitCode}`;
        continue;
      }
      // A ruling that opened nothing judged the summaries, not the code.
      const usedTools = result.messages.some(
        (m) => m.role === "assistant" && m.content.some((p) => p.type === "toolCall"),
      );
      if (!usedTools) {
        failure = `ruled after ${result.usage.turns} assistant turn(s) without reading any report or source`;
        continue;
      }
      const parsed = parseRuling(output);
      if (!parsed.ok) {
        failure = `output was not a usable ruling: ${parsed.error}`;
        continue;
      }
      usable = true;
      const ruling: Moderation = {
        specHash: moderator.hash,
        model,
        at: new Date().toISOString(),
        reportPath,
        overturn: parsed.overturn,
        judged,
      };
      return {
        ruling,
        summary: {
          overturn: parsed.overturn,
          ran: true,
          warm: delta !== undefined,
          model,
          prose: output,
          failure: "",
          reportPath,
        },
      };
    } finally {
      await keepIfUsable(changeset, moderator, result, usable, warnings);
    }
  }
  return {
    ruling: undefined,
    summary: {
      overturn: undefined,
      ran: true,
      warm: false,
      model,
      prose: "",
      failure: failure || "aborted before ruling",
      reportPath,
    },
  };
}

function moderatorTask(
  changeset: Changeset,
  request: ReviewRequest,
  panel: PanelMember[],
  states: Map<string, AgentState>,
): string {
  const results = panel.map((member) => {
    const state = states.get(member.agent.name);
    const findings = (state?.findings ?? []).map(
      (f) => `    - [${f.severity}] ${f.file}:${f.line} — ${f.problem}\n      Fix asked: ${f.fix}`,
    );
    return [
      `- ${member.agent.name}: ${state?.verdict ?? "INCOMPLETE"} — full report: ${state?.reportPath ?? "(none)"}`,
      ...findings,
    ].join("\n");
  });
  return [
    `The review panel BLOCKED the changeset at ${changeset.patchPath} (${changeset.patchLines} line(s), ` +
      `${changeset.files.length} file(s) in ${changeset.repoRoot}).`,
    `Intent the author was working to: ${request.intent}`,
    "",
    "Panel results. Each reviewer's complete report is on disk at the path given; read the blocking ones in full before you rule.",
    ...results,
    "",
    request.context === ""
      ? "The author attached no note for you."
      : `The author's note to you — their claim, not evidence:\n${request.context}`,
    "",
    "Rule per your moderation protocol.",
  ].join("\n");
}

/** One reviewer flags a file another explicitly cleared — the caller decides, not the gate. */
function findDisagreements(reviewers: ReviewerSummary[]): string[] {
  const byFile = new Map<string, { flagged: string[]; cleared: string[] }>();
  const slot = (file: string) => {
    const existing = byFile.get(file) ?? { flagged: [], cleared: [] };
    byFile.set(file, existing);
    return existing;
  };

  for (const reviewer of reviewers) {
    for (const finding of reviewer.findings) {
      slot(finding.file).flagged.push(`${reviewer.agent} at ${finding.line} [${finding.severity}]`);
    }
    for (const item of reviewer.cleared) {
      slot(item.file).cleared.push(`${reviewer.agent} at ${item.line} — ${item.why}`);
    }
  }
  const out: string[] = [];
  for (const [file, { flagged, cleared }] of byFile) {
    if (flagged.length > 0 && cleared.length > 0) {
      out.push(`${file}: ${flagged.join("; ")} flags it while ${cleared.join("; ")}`);
    }
  }
  return out;
}

function headline(outcome: ReviewOutcome): string {
  if (outcome.verdict !== "BLOCK") return outcome.verdict;
  if (outcome.moderation?.overturn === true) return "BLOCK, overturned by the moderator — cleared to commit";
  if (outcome.moderation?.overturn === false) return "BLOCK, upheld by the moderator";
  return "BLOCK (the moderator could not rule)";
}

function closingInstruction(outcome: ReviewOutcome): string {
  if (outcome.verdict === "PROCEED") {
    return "Verdict PROCEED — no reviewer has a blocking finding on these exact bits. Committing is cleared; any change to the tree invalidates it. Advisory findings are yours to weigh.";
  }
  if (outcome.verdict === "INCOMPLETE") {
    return "Verdict INCOMPLETE — the panel did not complete, so this is not a pass. Treat it as unreviewed and retry.";
  }
  if (outcome.cleared) {
    return (
      "The panel blocked these exact bits and the moderator overturned the block. They are cleared: commit them now, " +
      "without further edits — any change to the tree voids the ruling and the full panel runs again. " +
      "Carry the moderator's prose and the reviewers' findings forward into the work that follows."
    );
  }
  return (
    "Verdict BLOCK — fix what must be fixed (the moderator's ruling, when present, says which) and run again; " +
    "the full panel reviews the new bits. Only the user can waive the gate (/review-skip <reason>)."
  );
}

function renderReport(outcome: ReviewOutcome, changeset: Changeset, request: ReviewRequest): string {
  const ran = outcome.reviewers.filter((r) => r.ran);
  const cached = outcome.reviewers.filter((r) => !r.ran);

  // Paths and verdict lead. If anything has to be cut downstream, it must not
  // be the reader's route to the full reports.
  const sections: string[] = [
    [
      `Adversarial review — ${headline(outcome)}`,
      `Repo ${outcome.repoRoot}`,
      `Changeset ${outcome.changesetHash.slice(0, 16)} — ${outcome.files.length} file(s), ${Math.max(1, Math.round(changeset.patchBytes / 1024))} KiB`,
      `Trigger ${request.trigger}. Intent judged against: ${request.intent}`,
      `Panel ${outcome.reviewers.length}: ${cached.length} already PROCEED for these bits, ${ran.length} reviewed now (${ran.filter((r) => r.warm).length} resumed from their last review on this HEAD).`,
      `Record ${outcome.recordPath}`,
      `Full reports and the patch: ${outcome.reportsDir}`,
    ].join("\n"),
  ];

  const listFindings = (list: AggregatedFinding[]) =>
    list
      .map((f, i) => `${i + 1}. [${f.severity}] ${f.agent} — ${f.file}:${f.line}\n   ${f.problem}\n   Fix: ${f.fix}`)
      .join("\n");
  const blocking = outcome.findings.filter(isBlocking);
  const advisory = outcome.findings.filter((f) => !isBlocking(f));
  sections.push(
    blocking.length > 0 ? `## Findings (${blocking.length})\n${listFindings(blocking)}` : "## Findings\nNone blocking.",
  );
  if (advisory.length > 0) {
    sections.push(`## Advisory (${advisory.length}, LOW — do not block)\n${listFindings(advisory)}`);
  }

  const moderation = outcome.moderation;
  if (moderation !== undefined) {
    const ruling = moderation.overturn === undefined ? "NO RULING" : moderation.overturn ? "OVERTURNED" : "UPHELD";
    const body = moderation.ran
      ? moderation.overturn === undefined
        ? `The moderator could not rule: ${moderation.failure}`
        : truncateOutput(moderation.prose, MODERATOR_REPORT_CAP)
      : "Overturned in an earlier run over these same reports; its ruling stands.";
    sections.push(
      `## Moderator — ${ruling}${moderation.model ? ` (${moderation.model})` : ""}\n(Full ruling: ${moderation.reportPath || "(none)"})\n${body}`,
    );
  }

  const incomplete = outcome.reviewers.filter((r) => r.verdict === "INCOMPLETE");
  if (incomplete.length > 0) {
    sections.push(
      `## Incomplete — the gate could not be evaluated for\n${incomplete.map((r) => `- ${r.agent}: ${r.failure}`).join("\n")}`,
    );
  }
  if (outcome.disagreements.length > 0) {
    sections.push(
      `## Reviewer disagreements (unresolved, caller decides)\n${outcome.disagreements.map((d) => `- ${d}`).join("\n")}`,
    );
  }
  if (outcome.warnings.length > 0) {
    sections.push(`## Warnings\n${outcome.warnings.map((w) => `- ${w}`).join("\n")}`);
  }

  sections.push(closingInstruction(outcome));

  const index = [
    ...outcome.reviewers.map(
      (r) =>
        `- ${r.agent}: ${r.verdict}${r.ran ? (r.warm ? " (warm)" : " (cold)") : " (cached, not re-run)"}, ${r.findings.length} finding(s), ${r.cleared.length} cleared` +
        `${r.note ? ` — note: ${r.note}` : ""}\n  Report: ${r.reportPath}`,
    ),
  ];
  sections.push(`## Reviewer index (${outcome.reviewers.length})\n${index.join("\n")}`);

  // Verbatim prose is the only section that is fully recoverable elsewhere, so
  // it is what gets dropped when the rest does not fit.
  if (ran.length > 0) {
    const core = sections.join("\n\n");
    let remaining = TOTAL_REPORT_CAP - Buffer.byteLength(core, "utf8") - 512;
    const blocks: string[] = [];
    const dropped: string[] = [];
    for (const r of ran) {
      const block = `### ${r.agent} — ${r.verdict}${r.model ? ` (${r.model})` : ""}\n(Full report: ${r.reportPath})\n${truncateOutput(r.prose || r.failure || "(no output)", PER_REVIEWER_REPORT_CAP)}`;
      const cost = Buffer.byteLength(block, "utf8") + 2;
      if (blocks.length > 0 && cost > remaining) {
        dropped.push(`${r.agent} (${r.reportPath})`);
        continue;
      }
      remaining -= cost;
      blocks.push(block);
    }
    const header = `## Reviewer reports (${blocks.length} of ${ran.length} included verbatim, ${dropped.length} omitted for size)`;
    const notice =
      dropped.length > 0
        ? `\n\nOmitted to keep this result inside the tool-output budget — read them at:\n${dropped.map((d) => `- ${d}`).join("\n")}`
        : "";
    sections.push(`${header}\n${blocks.join("\n\n")}${notice}`);
  }

  const report = sections.join("\n\n");
  if (Buffer.byteLength(report, "utf8") <= TOTAL_REPORT_CAP) return report;
  return truncateOutput(report, TOTAL_REPORT_CAP);
}
