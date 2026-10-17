/**
 * Panel member process runner.
 *
 * Spawns one child `pi` per reviewer or moderator run and streams its JSON
 * events into a `SingleResult`. Adapted from pi's MIT-licensed subagent example
 * (`examples/extensions/subagent`).
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message, StopReason, Usage } from "@earendil-works/pi-ai";
import { type ExtensionContext, getPackageDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { Semaphore } from "./semaphore.ts";
import type { AgentConfig, AgentDiscoveryResult } from "./specs.ts";
import { describeError, isRecord, safeName } from "./util.ts";

export const PER_TASK_OUTPUT_CAP = 50 * 1024;

/** Set in every panel member's environment; see gate.ts for why it matters. */
export const CHILD_ENV = "PI_REVIEW_GATE_CHILD";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export type TaskStatus = "queued" | "running" | "done";

export interface SingleResult {
  agent: string;
  agentSource: AgentConfig["source"] | "unknown";
  task: string;
  status: TaskStatus;
  exitCode: number | null;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  /**
   * Stream events that arrived but could not be used — unparseable, wrong shape,
   * or thrown out of the handler. They are a hole in the result, not a cosmetic
   * loss: the child can still exit 0 with a clean stop reason afterwards, so
   * nothing else would notice, and the success path prints only the final text
   * while the detail sits in stderr. Counted so the result cannot read as clean.
   */
  droppedEvents: number;
  model?: string | undefined;
  /**
   * The `provider/id` the child reports it ran on, taken from its assistant
   * messages. Kept apart from `model` — the requested string — because pi
   * resolves `--model` with exact-or-fuzzy matching, so a near-miss id runs a
   * different model silently; comparing this against the request is what
   * surfaces the substitution.
   */
  reportedModel?: string | undefined;
  /**
   * One line per rate-limit retry this run spent. Kept off stderr — which the
   * report drops on a successful run — so a verdict earned across retries is
   * auditable; the panel folds these into its report warnings.
   */
  retryNotes: string[];
  /**
   * The child's session on disk, when the caller asked to keep it
   * (`SingleAgentRequest.session`). The caller owns it from here and must remove it.
   */
  session?: { dir: string; id: string } | undefined;
  stopReason?: StopReason | undefined;
  terminationSignal?: string | undefined;
  errorMessage?: string | undefined;
  step?: number | undefined;
}

export type OnUpdateCallback<T> = (partial: AgentToolResult<T>) => void;
export interface Dispatch {
  thinkingLevel?: ThinkingLevel | undefined;
  gate: Semaphore;
  /** The model an unpinned agent runs on; `undefined` lets the child pi pick its own default. */
  model: string | undefined;
}

export function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export function getFinalOutput(messages: Message[]): string {
  for (const msg of messages.slice().reverse()) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

export function isFailedResult(result: SingleResult): boolean {
  if (result.status !== "done") return false;
  return (
    result.exitCode !== 0 ||
    result.terminationSignal !== undefined ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.droppedEvents > 0
  );
}

/** How a finished run failed, as far as the parent can tell from stderr and messages. */
export type FailureKind = "rate-limit" | "other";

const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit/i;
/** Retries per run: the first attempt plus this many rate-limit retries. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_ATTEMPTS = RATE_LIMIT_RETRIES + 1;
/** Retry wait bounds per retry: jittered inside [base/2, base). */
const RATE_LIMIT_BACKOFF_MS = [5_000, 15_000, 45_000];
/** A Retry-After beyond this is treated as unusable rather than waited on. */
const RETRY_AFTER_MAX_MS = 600_000;

export function classifyFailure(result: SingleResult): FailureKind {
  let lastError = "";
  for (let i = result.messages.length - 1; i >= 0; i -= 1) {
    const message = result.messages[i];
    if (message.role === "assistant") {
      if (typeof message.errorMessage === "string") lastError = message.errorMessage;
      break;
    }
  }
  return RATE_LIMIT_PATTERN.test(`${result.stderr}\n${lastError}`) ? "rate-limit" : "other";
}

function retryAfterMs(stderr: string): number | undefined {
  // Bare seconds is the conventional header form; some providers append a unit.
  const matches = [...stderr.matchAll(/retry-after:\s*(\d+(?:\.\d+)?)\s*(?:s\b)?/gi)];
  const last = matches.at(-1);
  if (last === undefined) return undefined;
  const ms = Number(last[1]) * 1000;
  return ms > 0 && ms <= RETRY_AFTER_MAX_MS ? ms : undefined;
}

function jitteredBackoffMs(retry: number): number {
  const base = RATE_LIMIT_BACKOFF_MS[Math.min(retry, RATE_LIMIT_BACKOFF_MS.length - 1)];
  // Floored at half the base: a rate limit that needs a real pause must not
  // be answered with a ~0ms retry that spends the budget in under a minute.
  return Math.floor(base / 2 + Math.random() * (base / 2));
}

export function rateLimitRetryDelay(attempt: number, result: SingleResult): number | undefined {
  if (attempt >= RATE_LIMIT_RETRIES) return undefined;
  if (result.stopReason === "aborted") return undefined;
  if (!isFailedResult(result)) return undefined;
  if (classifyFailure(result) !== "rate-limit") return undefined;
  return retryAfterMs(result.stderr) ?? jitteredBackoffMs(attempt);
}

/** Resolves after ms, immediately on an abort — including one already fired. */
export function sleepFor(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  if (signal === undefined) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = () => finish();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function removeSessionDir(dir: string, result: SingleResult): Promise<void> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true });
  } catch (error) {
    // A cleanup hiccup must not replace a finished run's result with a
    // failure, but it is not invisible either: the leftover session dir would
    // be re-entered by a later --resume, so name it on stderr.
    result.stderr += `could not remove the subagent session dir ${dir} (${describeError(error)}); it was left behind\n`;
  }
}

/** Keeps one task's output inside the tool result without cutting mid-codepoint. */
export function truncateOutput(output: string, cap: number = PER_TASK_OUTPUT_CAP): string {
  const byteLength = Buffer.byteLength(output, "utf8");
  if (byteLength <= cap) return output;

  let truncated = output.slice(0, cap);
  while (Buffer.byteLength(truncated, "utf8") > cap) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

function isUsageShape(value: unknown): value is Usage {
  if (!isRecord(value)) return false;
  if (!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => Number.isFinite(value[key])))
    return false;
  // cost.total is the one nested dereference the accumulator makes, so the
  // predicate has to establish it. Asserting the whole Usage type off four flat
  // numbers leaves the checker silent exactly where the code reaches deeper.
  return isRecord(value.cost) && Number.isFinite(value.cost.total);
}

function isMessageShape(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  const role = value.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "toolResult") return false;
  if (!Array.isArray(value.content)) return false;
  for (const part of value.content) {
    if (!isRecord(part) || typeof part.type !== "string") return false;
    if (part.type === "text" && typeof part.text !== "string") return false;
    if (part.type === "toolCall" && (typeof part.name !== "string" || !isRecord(part.arguments))) return false;
  }
  if (value.usage !== undefined && !isUsageShape(value.usage)) return false;
  // stopReason is what the result is judged on, so an unrecognised value has to
  // fail the shape and surface as a dropped event rather than fall through and
  // read as a clean finish.
  if (value.stopReason !== undefined && !isStopReason(value.stopReason)) return false;
  // An assistant message's model is reported as the run's model and its
  // errorMessage verbatim, so both are established here rather than trusted
  // from the wire where they are next read.
  if (
    role === "assistant" &&
    (typeof value.model !== "string" || (value.errorMessage !== undefined && typeof value.errorMessage !== "string"))
  ) {
    return false;
  }
  return true;
}

const STOP_REASONS: Record<StopReason, true> = {
  pending: true,
  stop: true,
  length: true,
  toolUse: true,
  error: true,
  aborted: true,
  deferred: true,
};

function isStopReason(value: unknown): value is StopReason {
  return typeof value === "string" && Object.hasOwn(STOP_REASONS, value);
}

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const filePath = path.join(tmpDir, `prompt-${safeName(agentName)}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  if (currentScript !== undefined && isPiCliEntry(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

/**
 * argv[1] is the pi CLI only when it lives in the pi package.
 *
 * "The file exists" is not enough: whatever it points at is what gets spawned
 * per subagent, so a host process whose entry is not pi would re-spawn itself
 * once per subagent — and each copy would spawn more.
 */
function isPiCliEntry(script: string): boolean {
  if (script.startsWith("/$bunfs/root/")) return false;
  if (!fs.existsSync(script)) return false;
  const packageDir = getPackageDir();
  const resolved = path.resolve(script);
  return resolved === packageDir || resolved.startsWith(packageDir + path.sep);
}

export interface DispatchHost {
  /** Narrowed to what buildDispatch reads; the full `Model` shape stays at the extension boundary. */
  model: { provider: string; id: string } | undefined;
  thinkingLevel?: ExtensionContext["thinkingLevel"];
}

/**
 * What a dispatching session hands its subagents: its model, its thinking level, and the shared gate.
 * A panel model runs without the session's thinking level, which was chosen for a different model.
 */
export function buildDispatch(host: DispatchHost, gate: Semaphore, panelModel?: string): Dispatch {
  if (panelModel !== undefined) return { thinkingLevel: undefined, gate, model: panelModel };
  return {
    thinkingLevel: host.thinkingLevel,
    gate,
    model: host.model ? `${host.model.provider}/${host.model.id}` : undefined,
  };
}

export interface SingleAgentRequest<T> {
  agentName: string;
  task: string;
  cwd?: string | undefined;
  step?: number | undefined;
  signal?: AbortSignal | undefined;
  onUpdate?: OnUpdateCallback<T> | undefined;
  /**
   * Run as a continuation of a kept session instead of a throwaway one. The
   * seed directory is copied, never written, so a run that ends unusably leaves
   * the caller's copy as it was; the run's own session comes back on the result.
   */
  session?: { seedDir: string | undefined; id: string } | undefined;
}

export async function runSingleAgent<T>(
  defaultCwd: string,
  dispatch: Dispatch,
  discovery: AgentDiscoveryResult,
  makeDetails: (results: SingleResult[]) => T,
  request: SingleAgentRequest<T>,
): Promise<SingleResult> {
  const { agentName, task, cwd, step, signal, onUpdate, session } = request;
  const agent = discovery.agents.find((a) => a.name === agentName);

  if (!agent) {
    const available = discovery.agents.map((a) => `"${a.name}"`).join(", ") || "none";
    const skippedNote =
      discovery.skipped.length > 0
        ? ` Skipped: ${discovery.skipped.map((s) => `${s.filePath} — ${s.reason}`).join("; ")}.`
        : "";
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      status: "done",
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}". Available agents: ${available}.${skippedNote}`,
      usage: emptyUsage(),
      droppedEvents: 0,
      retryNotes: [],
      step,
    };
  }

  const baseArgs: string[] = ["--mode", "json", "-p"];
  const inheritsDispatchConfig = !agent.model;
  if (inheritsDispatchConfig && dispatch.thinkingLevel) {
    baseArgs.push("--thinking", dispatch.thinkingLevel);
  }
  if (agent.tools && agent.tools.length > 0) baseArgs.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  let lastSessionDir: string | null = null;

  const currentResult: SingleResult = {
    agent: agent.name,
    agentSource: agent.source,
    task,
    status: "queued",
    exitCode: null,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    droppedEvents: 0,
    retryNotes: [],
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    if (onUpdate) {
      onUpdate({
        content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
        details: makeDetails([currentResult]),
      });
    }
  };

  const model = agent.model ?? dispatch.model;
  currentResult.model = model;
  const sessionId = session?.id ?? randomUUID();

  if (agent.systemPrompt.trim()) {
    const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
    tmpPromptDir = tmp.dir;
    tmpPromptPath = tmp.filePath;
    baseArgs.push("--append-system-prompt", tmpPromptPath);
  }

  try {
    for (let attempt = 0; ; attempt += 1) {
      let holdsSlot = false;
      let attemptSessionDir: string | null = null;
      let stderrBase = 0;
      try {
        try {
          await dispatch.gate.acquire(signal);
          holdsSlot = true;
        } catch (error) {
          if (!signal?.aborted) throw error;
          return {
            ...currentResult,
            status: "done",
            exitCode: 1,
            stopReason: "aborted",
            errorMessage: `Subagent "${agentName}" was aborted before it could start`,
          };
        }
        if (attempt > 0) {
          // A retry starts from the seed again: the failed attempt never
          // produced a usable verdict, and mixing its partial conversation
          // into the fresh attempt would make the result unattributable.
          // stderr is not reset: it is append-only audit, and the retry
          // decision below classifies against this attempt's slice only.
          currentResult.messages = [];
          currentResult.usage = emptyUsage();
          currentResult.droppedEvents = 0;
          currentResult.exitCode = null;
          currentResult.stopReason = undefined;
          currentResult.errorMessage = undefined;
          currentResult.terminationSignal = undefined;
          currentResult.reportedModel = undefined;
        }
        stderrBase = currentResult.stderr.length;
        currentResult.status = "running";

        // The child keeps its session in a temp dir rather than the user's
        // session store; a caller that asked for it gets it back to resume later.
        attemptSessionDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-session-"));
        lastSessionDir = attemptSessionDir;
        if (session?.seedDir !== undefined)
          await fs.promises.cp(session.seedDir, attemptSessionDir, { recursive: true });
        emitUpdate();

        let wasAborted = false;
        const args = [
          ...baseArgs,
          "--session-dir",
          attemptSessionDir,
          "--session-id",
          sessionId,
          ...(model ? ["--model", model] : []),
          `Task: ${task}`,
        ];
        const outcome = await runProcess(args, cwd ?? defaultCwd, signal, currentResult, emitUpdate, () => {
          wasAborted = true;
        });

        currentResult.status = "done";
        currentResult.exitCode = outcome.code;
        if (outcome.signal) currentResult.terminationSignal = outcome.signal;
        if (wasAborted) {
          currentResult.stopReason = "aborted";
          currentResult.errorMessage = `Subagent "${agentName}" was aborted`;
        } else if (outcome.code === 0 && currentResult.messages.length === 0) {
          currentResult.stopReason = "error";
          currentResult.errorMessage =
            currentResult.stderr.trim() || `Subagent "${agentName}" produced no stream events`;
        }
      } finally {
        if (holdsSlot) dispatch.gate.release();
      }

      // Classify and parse against only this attempt's output: stderr is
      // append-only across attempts, so a genuine 429 in attempt 1 must not
      // make attempt 2's unrelated crash read as a rate limit.
      const attemptStderr = currentResult.stderr.slice(stderrBase);
      const waitMs = rateLimitRetryDelay(attempt, { ...currentResult, stderr: attemptStderr });
      if (waitMs === undefined) break;
      if (attemptSessionDir !== null) {
        await removeSessionDir(attemptSessionDir, currentResult);
        lastSessionDir = null;
      }
      const waitSeconds = Math.max(1, Math.round(waitMs / 1000));
      const note = `rate-limited by the provider; retrying (attempt ${attempt + 2} of ${RATE_LIMIT_ATTEMPTS}) after ${waitSeconds}s`;
      currentResult.retryNotes.push(note);
      currentResult.status = "queued";
      emitUpdate();
      await sleepFor(waitMs, signal);
      if (signal?.aborted) {
        currentResult.status = "done";
        currentResult.stopReason = "aborted";
        currentResult.errorMessage = `Subagent "${agentName}" was aborted while waiting to retry a rate-limited run`;
        break;
      }
    }

    if (session !== undefined && lastSessionDir !== null) {
      currentResult.session = { dir: lastSessionDir, id: sessionId };
    }
    return currentResult;
  } finally {
    // The handback is recorded on the result; anything still here was not
    // handed back and would be re-entered by a later --resume if left behind.
    if (lastSessionDir !== null && currentResult.session === undefined) {
      try {
        fs.rmSync(lastSessionDir, { recursive: true, force: true });
      } catch (error) {
        currentResult.stderr += `could not remove the subagent session dir ${lastSessionDir} (${describeError(error)}); it was left behind\n`;
      }
    }
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}

async function runProcess(
  args: string[],
  cwd: string,
  signal: AbortSignal | undefined,
  currentResult: SingleResult,
  emitUpdate: () => void,
  markAborted: () => void,
): Promise<{ code: number; signal: NodeJS.Signals | undefined }> {
  // Every drop site records why in stderr and bumps the counter. The counter is
  // what turns the run into a failure: stderr never reaches a successful
  // result's output, so a recorded-but-ignored hole would read as a clean run.
  const dropEvent = (detail: string) => {
    currentResult.stderr += `${detail}\n`;
    currentResult.droppedEvents += 1;
  };

  return new Promise((resolve) => {
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // Marks the child as a subagent. Extensions read this to refuse work that
      // would recurse into another panel; see the review gate.
      env: { ...process.env, [CHILD_ENV]: "1" },
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const terminate = () => {
      proc.kill("SIGTERM");
      killTimer = setTimeout(() => {
        // proc.killed is true the moment kill() is called, whether or not the
        // child died, so it cannot tell you whether SIGTERM was honored. A child
        // stuck with a blocked event loop never runs its handler, and without
        // this escalation the run never settles and its slot is never released.
        if (!settled) proc.kill("SIGKILL");
      }, 5000);
      killTimer.unref();
    };

    const killProc = () => {
      if (settled) return;
      markAborted();
      terminate();
    };

    const settle = (code: number, termSignal?: NodeJS.Signals) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", killProc);
      resolve({ code, signal: termSignal });
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        dropEvent(`Unparseable stream line: ${line}`);
        return;
      }
      if (!isRecord(event) || typeof event.type !== "string") {
        dropEvent(`Unexpected stream event: ${line}`);
        return;
      }
      if (event.type === "message_end") {
        const msg = event.message;
        // The child's own system prompt, emitted with string content; not part
        // of the conversation.
        if (isRecord(msg) && msg.role === "system") return;
        if (!isMessageShape(msg)) {
          dropEvent(`Stream event without a message: ${line}`);
          return;
        }
        currentResult.messages.push(msg);

        if (msg.role === "assistant") {
          currentResult.usage.turns++;
          if (isUsageShape(msg.usage)) {
            currentResult.usage.input += msg.usage.input;
            currentResult.usage.output += msg.usage.output;
            currentResult.usage.cacheRead += msg.usage.cacheRead;
            currentResult.usage.cacheWrite += msg.usage.cacheWrite;
            currentResult.usage.cost += msg.usage.cost.total;
            currentResult.usage.contextTokens = msg.usage.totalTokens;
          } else {
            dropEvent(`Assistant message without usage: ${line}`);
          }
          if (typeof msg.provider === "string" && typeof msg.model === "string") {
            currentResult.reportedModel = `${msg.provider}/${msg.model}`;
          }
          if (!currentResult.model && msg.model) currentResult.model = msg.model;
          if (msg.stopReason) currentResult.stopReason = msg.stopReason;
          if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
        }
        emitUpdate();
      }
    };

    // A throw here is a bug in stream handling, and
    // it lands inside an EventEmitter callback: uncaught, it takes the parent pi
    // process down with the child. Fail the subagent instead.
    const safeProcessLine = (line: string) => {
      try {
        processLine(line);
      } catch (error) {
        dropEvent(`Unhandled stream line error: ${String(error)}`);
      }
    };

    proc.stdout.on("data", (data) => {
      buffer += decoder.write(data);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) safeProcessLine(line);
    });

    proc.stderr.on("data", (data) => {
      currentResult.stderr += data.toString();
    });

    proc.on("spawn", () => {
      if (signal?.aborted) killProc();
    });

    proc.on("close", (code, termSignal) => {
      if (buffer.trim()) safeProcessLine(buffer);
      settle(code ?? 0, termSignal ?? undefined);
    });

    proc.on("error", (error) => {
      currentResult.stderr += `Spawn failed: ${error.message}\n`;
      settle(1, undefined);
    });

    if (signal) {
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }
  });
}
