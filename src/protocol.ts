/**
 * The approval protocol appended to every reviewer's own spec, and the parser
 * for the record it produces.
 *
 * The record block is the machine-readable half of a review: the prose report
 * is for the human, the block is what gets stored against the changeset hash
 * and decides whether a commit goes through. Keeping the verdict in prose would
 * mean pattern-matching English to decide whether code ships.
 */

import { isRecord } from "./util.ts";
import {
  asString,
  asVerdict,
  validateCleared,
  validateFinding,
  type ClearedItem,
  type Finding,
  type ReviewerRecord,
  type Verdict,
} from "./record.ts";

export const RECORD_FENCE = "adversarial-review-record";

export interface PanelPeer {
  name: string;
  description: string;
}

export function approvalProtocol(peers: PanelPeer[]): string {
  const roster = peers.map((peer) => `- **${peer.name}** — ${peer.description}`).join("\n");
  return `

## Approval protocol (added by the review gate)

You are one of a fixed panel. Your report is a gate: the session that called you cannot
\`git commit\` until every reviewer returns PROCEED for the exact bits you were handed, or a
moderator who reads every report overturns the panel's BLOCK. Your record is stored against
that changeset's hash — change one byte and the panel runs again.

The project's own context file (AGENTS.md or its equivalent, already in your context) states
what the project is, who uses it, and its trust model. Judge severity and plausibility against
it: a defense against a threat that file rules out is not a finding.

How the gate works, so you can aim correctly:

- You were given a path to a changeset patch. Read it first, in full. It contains the tracked
  diff against HEAD and the full content of every untracked file.
- You cannot fix anything, cannot approve later, and cannot see the conversation that wrote
  this code. There is no "they told me why" — if the reason is not in the diff or the source,
  it does not exist.

## The rest of the panel

These reviewers run beside you on the same bits, each reading the whole changeset:

${roster}

Anything in their lanes will be found by them. Time you spend chasing it is time not spent
on your own lane, and a finding duplicated across lanes costs the author and the moderator
attention twice for one issue. Stay in your lane. If something outside it is too serious to
leave unsaid, give it one line in \`note\`, never a finding.

Verdict rules:

Severity — this, not your own spec's verdict line, decides whether a finding holds the commit:

- **HIGH** — breaks in ordinary use, loses or corrupts data, or opens a hole the trust model
  says must be closed.
- **MEDIUM** — a real defect reachable in plausible use, or a contract the code states and
  does not keep.
- **LOW** — worth saying, but a reasonable author could ship it today: wording, naming,
  comment trims, test tidiness, hardening against inputs the trust model makes implausible.
  LOW findings are reported to the author and do not block.

Verdict rules:

- **PROCEED** — nothing at HIGH or MEDIUM stands. LOW findings may still be listed.
- **BLOCK** — at least one HIGH or MEDIUM finding stands. One is enough.
- **INCOMPLETE** — you could not actually do the review: the patch is missing, unreadable,
  truncated, or you ran out of turns. This is not a pass and not a code complaint; it is a
  harness failure and the caller will re-run you. Never emit PROCEED for work you did not read.

End your reply with exactly one fenced block, as the last thing you write:

\`\`\`${RECORD_FENCE}
{"verdict":"PROCEED","findings":[],"cleared":[],"note":""}
\`\`\`

Every key is required:

- \`verdict\`: "PROCEED" | "BLOCK" | "INCOMPLETE"
- \`findings\`: array (only LOW items when PROCEED). Each item:
  \`{"severity":"HIGH"|"MEDIUM"|"LOW","file":"repo/relative/path","line":"12" or "12-20","problem":"what is wrong and who pays for it","fix":"the concrete leftward fix"}\`
- \`cleared\`: array of \`{"file":"...","line":"...","why":"why the candidate is legitimate"}\` —
  the false positives you considered and rejected. Empty is allowed.
- \`note\`: one trailing line of unrelated observations, or "" when there are none.

The block is authoritative. If your prose disagrees with it, the block wins — so make the
block say what you actually concluded. Emit exactly one, and no other \`\`\`${RECORD_FENCE}\`\`\` block.
`;
}

export type ParseResult = { ok: true; record: ReviewerRecord } | { ok: false; error: string };

/** Pulls the single record block out of a reviewer's final message. */
export function parseRecord(output: string): ParseResult {
  // Tolerant of the fence, strict about the record: models occasionally tack a
  // stray character onto the info string, and losing a complete review to that
  // would be the harness failing, not the reviewer.
  const blocks = fencedBlocks(output, RECORD_FENCE);

  if (blocks.length === 0) {
    return { ok: false, error: `no \`\`\`${RECORD_FENCE}\`\`\` block in the reviewer's final message` };
  }
  if (blocks.length > 1) {
    return { ok: false, error: `${blocks.length} \`\`\`${RECORD_FENCE}\`\`\` blocks; exactly one is required` };
  }

  let parsed: unknown;
  const block = blocks[0];
  if (block === undefined) return { ok: false, error: `no \`\`\`${RECORD_FENCE}\`\`\` block in the reviewer's final message` };
  try {
    parsed = JSON.parse(block);
  } catch (error) {
    return { ok: false, error: `record block is not valid JSON: ${String(error)}` };
  }
  return validateReviewerRecord(parsed);
}

function validateReviewerRecord(value: unknown): ParseResult {
  if (!isRecord(value)) return { ok: false, error: "record must be a JSON object" };

  const verdict = asVerdict(value.verdict);
  if (verdict === undefined) {
    return { ok: false, error: `verdict must be PROCEED, BLOCK or INCOMPLETE, got ${JSON.stringify(value.verdict)}` };
  }
  if (!Array.isArray(value.findings)) return { ok: false, error: "findings must be an array" };
  if (!Array.isArray(value.cleared)) return { ok: false, error: "cleared must be an array" };
  const note = asString(value.note);
  if (note === undefined) return { ok: false, error: "note must be a string (use \"\" when there is nothing to add)" };

  const findings: Finding[] = [];
  for (const entry of value.findings) {
    const parsed = validateFinding(entry);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    findings.push(parsed.value);
  }

  const cleared: ClearedItem[] = [];
  for (const entry of value.cleared) {
    const parsed = validateCleared(entry);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    cleared.push(parsed.value);
  }

  const blocking = findings.filter(isBlocking).length;
  if (verdict === "PROCEED" && blocking > 0) {
    return { ok: false, error: `verdict PROCEED with ${blocking} HIGH/MEDIUM finding(s); BLOCK if any of them stands` };
  }
  if (verdict === "BLOCK" && findings.length === 0) {
    return { ok: false, error: "verdict BLOCK with no findings; name the finding or return PROCEED" };
  }
  // The severity rule is the gate's, not the reviewer's: a BLOCK carrying only
  // LOW findings is exactly the PROCEED the protocol defines, and its findings
  // still reach the author.
  const effective: Verdict = verdict === "BLOCK" && blocking === 0 ? "PROCEED" : verdict;

  return { ok: true, record: { verdict: effective, findings, cleared, note } };
}

export function isBlocking(finding: Finding): boolean {
  return finding.severity !== "LOW";
}

export const MODERATION_FENCE = "review-moderation-record";

/**
 * Appended to the moderator's own spec. The ruling is a boolean the gate acts
 * on; everything the moderator wants the author to know travels as prose.
 */
export function moderationProtocol(): string {
  return `

## Moderation protocol (added by the review gate)

The panel blocked a changeset. You read every reviewer's report and decide whether the BLOCK
stands. You cannot edit anything and you cannot see the conversation that wrote this code.

- **Overturn** clears these exact bits for \`git commit\`. The author is told the panel blocked,
  that you overturned it, and is shown your prose and every reviewer's report.
- **Uphold** keeps the BLOCK. The author fixes what you say must be fixed and the full panel
  runs again on the new bits.

Anything the author attached for you is their claim, not evidence. Verify it against the
source, the project's context file, and the reports before you lean on it.

Write your ruling as prose addressed to the author: which findings must be fixed before this
lands and why, which do not and why. Then end your reply with exactly one fenced block, as
the last thing you write:

\`\`\`${MODERATION_FENCE}
{"overturn":false}
\`\`\`

\`overturn\` is a JSON boolean and the block's only key. Emit exactly one such block.
`;
}

export type RulingResult = { ok: true; overturn: boolean } | { ok: false; error: string };

export function parseRuling(output: string): RulingResult {
  const blocks = fencedBlocks(output, MODERATION_FENCE);
  if (blocks.length !== 1) {
    return { ok: false, error: `expected exactly one \`\`\`${MODERATION_FENCE}\`\`\` block, found ${blocks.length}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0] ?? "");
  } catch (error) {
    return { ok: false, error: `ruling block is not valid JSON: ${String(error)}` };
  }
  if (!isRecord(parsed) || typeof parsed.overturn !== "boolean") {
    return { ok: false, error: `ruling must be {"overturn": true|false}, got ${JSON.stringify(parsed)}` };
  }
  return { ok: true, overturn: parsed.overturn };
}

function fencedBlocks(output: string, fenceName: string): string[] {
  const fence = new RegExp("```\\s*" + fenceName + "[^\\n]*\\n([\\s\\S]*?)```", "g");
  const blocks: string[] = [];
  for (let match = fence.exec(output); match !== null; match = fence.exec(output)) {
    if (match[1] !== undefined) blocks.push(match[1]);
  }
  return blocks;
}
