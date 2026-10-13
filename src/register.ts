/**
 * The adversarial review gate, as a tool, a commit hook, and a section of the
 * system prompt.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  committedDrift,
  NotARepositoryError,
  resolveRepoRoot,
  snapshotDrift,
  snapshotTree,
  type TreeSnapshot,
} from "./changeset.ts";
import { type CommitEscape, commitEscapes, looksLikeGitCommit } from "./commit.ts";
import { type ReviewDeps, type ReviewOutcome, runReview } from "./gate.ts";
import { CHILD_ENV } from "./runner.ts";
import { describeError } from "./util.ts";

const STATUS_KEY = "adversarial-review";
const MAX_INTENT_CHARS = 1200;
/**
 * Live clearances are removed when their tool result lands, so this only bounds
 * entries whose command never reported. Generous, and eviction is announced: a
 * dropped entry means the check that would have withdrawn an unearned clearance
 * is not going to run, which has to be said out loud rather than skipped quietly.
 */
const MAX_PENDING_REPORTS = 256;
/** Per-session bookkeeping is keyed by session id, which only ever grows. */
const MAX_TRACKED_SESSIONS = 64;
/**
 * Floor for a commit the panel just cleared. The bash timeout counts from the
 * tool call, and the panel spent its minutes before the command was let through:
 * a commit with a slow pre-commit hook would otherwise have its process group
 * killed mid-hook on the default, after the expensive part is already paid.
 *
 * Clamped to `PI_BASH_MAX_TIMEOUT` when it is set, the ceiling a bash-timeout
 * extension may enforce, so the gate cannot raise a timeout past a limit the
 * user configured — both read one value instead of racing on handler order.
 */
const COMMIT_TIMEOUT_FLOOR_SECONDS = 1800;
const BASH_MAX_TIMEOUT_ENV = "PI_BASH_MAX_TIMEOUT";
const UNKNOWN_INTENT = "(unstated — judge the diff against itself and the repository's own conventions)";

/** The configured bash timeout ceiling, or Infinity when none is set. */
function bashMaxTimeout(): number {
  const raw = process.env[BASH_MAX_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return Infinity;
  const value = Number(raw);
  // The extension that enforces the ceiling is the loud place for a bad value.
  // Here it only has to stop the gate inventing a ceiling of its own.
  if (!Number.isFinite(value) || value <= 0) return Infinity;
  return value;
}

/**
 * The rules the author works under, written once in `prompts/rules.md` and read
 * at load, so a missing file fails when the extension loads.
 *
 * Not injected into panel members: the panel is hard-disabled there (see the
 * recursion cut in gate.ts), so advertising it would tell a reviewer to call
 * something that can only fail. The tool stays registered so one that reaches
 * for it anyway gets the redirect rather than "unknown tool".
 */
const SYSTEM_SECTION = fs
  .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "rules.md"), "utf-8")
  .trim();

/** Latest user prompt per session, used as the intent the reviewers judge against. */
const intents = new Map<string, string>();

/** One-shot commit authorizations, armed only by the user through /review-skip. */
const skips = new Map<string, string>();

/** Gate reports waiting to be appended to the commit's own tool result, by call id. */
const pendingReports = new Map<string, PendingReport>();

interface PendingReport {
  report: string;
  /** The tree the panel read; absent when no review ran (a user-armed skip). */
  reviewed: TreeSnapshot | undefined;
  repoRoot: string;
  /** HEAD before the command ran, so a commit that did happen can be inspected. */
  headBefore: string;
}

const ReviewParams = Type.Object({
  context: Type.Optional(
    Type.String({
      description:
        "A note for the moderator, read only if the panel blocks: what you know that the diff cannot show " +
        "(e.g. where deferred work is planned, why two findings conflict). Reviewers never see it, and the " +
        "moderator treats it as your claim, not evidence.",
    }),
  ),
});

export function registerReview(pi: ExtensionAPI, deps: ReviewDeps): void {
  pi.on("before_agent_start", (event, ctx) => {
    if (process.env[CHILD_ENV] !== "1") {
      event.systemPromptOptions.sections.adversarial_review = SYSTEM_SECTION;
    }
    // A run started by an extension's custom message (pi >= 1.2) carries no
    // user prompt, and the intent stays the last thing the user asked for.
    if (!("prompt" in event)) return;
    const prompt = event.prompt.trim();
    if (prompt !== "") remember(intents, ctx.sessionManager.getSessionId(), prompt, MAX_TRACKED_SESSIONS);
  });

  pi.registerTool<typeof ReviewParams, ReviewOutcome>({
    name: "adversarial_review",
    label: "Adversarial review",
    description: [
      "Run the adversarial reviewer panel against the current changeset and return the panel verdict.",
      "It derives the changeset itself (everything differing from HEAD, plus untracked files)",
      "and the intent from the latest user prompt; the optional `context` is a note for the moderator only.",
      "Reviewers that already returned PROCEED for these exact bits are not re-run; any change to the tree",
      "invalidates them and they run again. If the panel blocks, a moderator reads every report and either",
      "upholds the block or overturns it, which clears these exact bits for commit.",
      "The result carries every finding, the moderator's ruling, and the path of each complete report on disk.",
      "Returns isError unless the bits are cleared.",
      "What the verdict means for `git commit`, and who may waive it, is in the review gate section of the system prompt.",
    ].join(" "),
    promptSnippet: "Run the adversarial review panel on the current changeset; clears `git commit`.",
    parameters: ReviewParams,
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await withStatus(ctx, () =>
        runReview(deps, {
          cwd: ctx.cwd,
          host: ctx,
          intent: intentFor(ctx.sessionManager.getSessionId()),
          context: params.context?.trim() ?? "",
          trigger: "manual",
          signal,
        }),
      );
      return {
        content: [{ type: "text", text: outcome.report }],
        details: outcome,
        isError: !outcome.cleared,
      };
    },

    renderCall(_args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("adversarial_review")) + theme.fg("muted", " panel on the current changeset"),
        0,
        0,
      );
    },

    renderResult(result, _options, theme) {
      const outcome = result.details;
      const text = result.content.find((part) => part.type === "text");
      const body = text?.type === "text" ? text.text : "(no output)";
      if (outcome === undefined) return new Text(body, 0, 0);

      const passed = outcome.cleared;
      const ran = outcome.reviewers.filter((r) => r.ran).length;
      const moderated =
        outcome.moderation === undefined
          ? ""
          : outcome.moderation.overturn === true
            ? " · overturned"
            : outcome.moderation.overturn === false
              ? " · upheld"
              : " · moderator failed";
      const header =
        theme.fg(passed ? "success" : "error", `${passed ? "✓" : "✗"} ${outcome.verdict}${moderated}`) +
        theme.fg("muted", ` ${outcome.changesetHash.slice(0, 12)} · ${outcome.files.length} files`) +
        theme.fg("dim", ` · ${ran} reviewed now, ${outcome.reviewers.length - ran} cached`) +
        theme.fg("muted", ` · ${outcome.findings.length} finding(s)`);
      const lines = outcome.reviewers.map((r) => {
        const color = r.verdict === "PROCEED" ? "success" : r.verdict === "BLOCK" ? "warning" : "error";
        return (
          `  ${theme.fg(color, r.verdict.padEnd(10))}${theme.fg("accent", r.agent)}` +
          theme.fg(
            "dim",
            ` ${r.ran ? "ran" : "cached"} · ${r.findings.length} finding(s) · ${r.cleared.length} cleared`,
          )
        );
      });
      return new Text(`${header}\n${lines.join("\n")}`, 0, 0);
    },
  });

  pi.registerCommand("review", {
    description: "Run the adversarial review panel on the current changeset",
    handler: async (_args, ctx) => {
      try {
        const outcome = await withStatus(ctx, () =>
          runReview(deps, {
            cwd: ctx.cwd,
            host: ctx,
            intent: intentFor(ctx.sessionManager.getSessionId()),
            context: "",
            trigger: "manual",
            signal: ctx.signal,
          }),
        );
        ctx.ui.notify(
          `${outcome.verdict}${outcome.moderation?.overturn === true ? " (overturned — cleared)" : ""} — ` +
            `${outcome.findings.length} finding(s) across ${outcome.reviewers.length} reviewers. Full report: ${outcome.reportsDir}`,
          outcome.cleared ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(`Adversarial review could not run: ${describeError(error)}`, "error");
      }
    },
  });

  pi.registerCommand("review-skip", {
    description: "Authorize one commit to go through without a PROCEED",
    handler: async (args, ctx) => {
      const reason = args.trim();
      if (reason === "") {
        ctx.ui.notify("Usage: /review-skip <why this commit goes through unreviewed>", "warning");
        return;
      }
      remember(skips, ctx.sessionManager.getSessionId(), reason, MAX_TRACKED_SESSIONS);
      ctx.ui.notify("One commit authorized without review. The model will be told it was your call.", "warning");
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!isToolCallEventType("bash", event)) return;
    if (!looksLikeGitCommit(event.input.command)) return;

    const session = ctx.sessionManager.getSessionId();
    const skip = skips.get(session);
    if (skip !== undefined) {
      skips.delete(session);
      rememberReport(ctx, event.toolCallId, {
        report: skipReport(skip),
        reviewed: undefined,
        repoRoot: ctx.cwd,
        headBefore: "",
      });
      ctx.ui.notify(`Commit allowed without review by user authorization: ${skip}`, "warning");
      return;
    }

    // A commit aimed at another repository is detected, but the panel can only
    // read this one. Refuse rather than let it collect a PROCEED computed over
    // someone else's bits.
    const escapes = commitEscapes(event.input.command);
    if (escapes.length > 0) {
      const reason = await foreignRepositoryReason(escapes, ctx.cwd);
      if (reason !== undefined) {
        return {
          block: true,
          reason:
            `This commit could move outside the repository this session reviews, so the gate cannot clear it: ${reason}\n` +
            "Open a session in the target repository and run adversarial_review there, or ask the user to " +
            "waive this with /review-skip <reason>.",
        };
      }
    }

    let outcome: ReviewOutcome;
    try {
      outcome = await withStatus(ctx, () =>
        runReview(deps, {
          cwd: ctx.cwd,
          host: ctx,
          intent: intentFor(session),
          context: "",
          trigger: "commit",
          signal: ctx.signal,
        }),
      );
    } catch (error) {
      if (error instanceof NotARepositoryError) {
        // Nothing to gate: `git commit` fails by itself outside a repository,
        // and blocking here would wedge sessions that only mention commits.
        ctx.ui.notify(`${describeError(error)} — the commit gate has nothing to review here.`, "warning");
        return;
      }
      return {
        block: true,
        reason:
          `Adversarial review could not be evaluated, so this commit is not cleared: ${describeError(error)}\n` +
          "Fix the harness (reviewer specs, git repository) and try again. " +
          "Only the user can waive the gate, with /review-skip <reason>.",
      };
    }

    if (!outcome.cleared) {
      return {
        block: true,
        reason:
          `Commit blocked by the adversarial review gate.\n\n${outcome.report}\n\n` +
          `The commit did not run. Fix what must be fixed and commit again. Do not narrow or re-path the change ` +
          `to dodge a reviewer. If you know something the moderator should weigh, run adversarial_review with ` +
          `\`context\` before committing. Only the user can authorize /review-skip <reason>.`,
      };
    }

    rememberReport(ctx, event.toolCallId, {
      report: outcome.report,
      reviewed: outcome.snapshot,
      repoRoot: outcome.repoRoot,
      headBefore: outcome.head,
    });
    event.input.timeout = Math.max(event.input.timeout ?? 0, Math.min(COMMIT_TIMEOUT_FLOOR_SECONDS, bashMaxTimeout()));
    ctx.ui.notify(
      outcome.verdict === "BLOCK"
        ? `Adversarial review BLOCK overturned by the moderator for these bits (${outcome.changesetHash.slice(0, 12)}).`
        : outcome.reviewers.some((r) => r.ran)
          ? `Adversarial review PROCEED (${outcome.reviewers.filter((r) => r.ran).length} reviewer(s) ran).`
          : `Adversarial review already PROCEED for these bits (${outcome.changesetHash.slice(0, 12)}).`,
      "info",
    );
  });

  // The commit's own tool result is where the panel's findings belong: the
  // model reads them next to the commit it just made, with no separate channel
  // that can be missed.
  //
  // The verdict was computed before the command ran, so it is re-checked here:
  // a command that writes files and commits in one breath (a heredoc, a codegen
  // step, a hook that restages) would otherwise be signed off by a panel that
  // never saw those bytes. The commit cannot be recalled at this point, so the
  // clearance is withdrawn in the text instead.
  pi.on("tool_result", async (event) => {
    if (!isBashToolResult(event)) return;
    const pending = pendingReports.get(event.toolCallId);
    if (pending === undefined) return;
    pendingReports.delete(event.toolCallId);
    return { content: [...event.content, { type: "text" as const, text: await verifyCleared(pending) }] };
  });
}

async function verifyCleared(pending: PendingReport): Promise<string> {
  if (pending.reviewed === undefined) return pending.report;

  let shipped: string[];
  let moved: string[];
  try {
    // Two different questions. Did the commit ship bytes the panel never read
    // (a stale or partial stage, or a command that stages more than it was
    // asked to review)? And did the tree move under the
    // verdict at all, commit or no commit?
    shipped = await committedDrift(pending.repoRoot, pending.headBefore, pending.reviewed);
    moved = snapshotDrift(
      pending.reviewed,
      await snapshotTree(pending.repoRoot, Object.keys(pending.reviewed.contents)),
    );
  } catch (error) {
    return (
      `${pending.report}\n\n` +
      `Could not re-check the tree against this verdict (${describeError(error)}). ` +
      "Treat the committed bits as unverified and run adversarial_review again."
    );
  }

  const problems = [...shipped, ...moved];
  if (problems.length === 0) return pending.report;
  return (
    `${pending.report}\n\n` +
    `This verdict does not cover what this command produced:\n` +
    `${problems.map((p) => `- ${p}`).join("\n")}\n` +
    "Run adversarial_review again, and say in your summary that this commit went through on a verdict that did not cover these bytes."
  );
}

function rememberReport(ctx: ExtensionContext, toolCallId: string, pending: PendingReport): void {
  if (pendingReports.size >= MAX_PENDING_REPORTS) {
    const oldest = pendingReports.keys().next();
    if (!oldest.done) {
      pendingReports.delete(oldest.value);
      ctx.ui.notify(
        "A gated commit left the pending-clearance queue before its result arrived, so it was not re-verified.",
        "warning",
      );
    }
  }
  pendingReports.set(toolCallId, pending);
}

/** First escape that does not resolve to the session's repository; undefined if all of them do. */
async function foreignRepositoryReason(escapes: CommitEscape[], cwd: string): Promise<string | undefined> {
  let sessionRoot: string;
  try {
    sessionRoot = await resolveRepoRoot(cwd);
  } catch (error) {
    return `this session's directory is not a repository: ${describeError(error)}`;
  }
  for (const found of escapes) {
    const resolved = path.resolve(cwd, found.path);
    try {
      const root = await resolveRepoRoot(resolved);
      if (root !== sessionRoot) return `${found.how} resolves to ${root}, and this session reviews ${sessionRoot}`;
    } catch (error) {
      return `${found.how} resolves to ${resolved}, whose repository the gate cannot read: ${describeError(error)}`;
    }
  }
  return undefined;
}

/** FIFO-capped insert: these maps live for the life of the pi process. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  if (map.size >= cap) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
  map.set(key, value);
}

function skipReport(reason: string): string {
  return [
    "Adversarial review — SKIPPED by user authorization.",
    `The user waived the panel for this commit with the reason: "${reason}".`,
    "It was not reviewed. Say so in your summary of this commit.",
  ].join("\n");
}

async function withStatus<T>(ctx: ExtensionContext, fn: () => Promise<T>): Promise<T> {
  ctx.ui.setStatus(STATUS_KEY, "adversarial review running");
  try {
    return await fn();
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}

function intentFor(session: string): string {
  const intent = intents.get(session);
  if (intent === undefined || intent === "") return UNKNOWN_INTENT;
  return intent.length > MAX_INTENT_CHARS ? `${intent.slice(0, MAX_INTENT_CHARS)}…` : intent;
}
