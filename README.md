# pi-adversarial-review

An adversarial review gate for the [pi coding agent](https://github.com/earendil-works/pi). Before `git commit` runs, a panel of reviewer agents reads every change in the working tree against HEAD, and any HIGH or MEDIUM finding blocks the commit. A blocked panel goes to a moderator, who either upholds the block or overturns it.

It exists for long autonomous runs: a model working toward a goal for hours commits often, and nothing else reads those commits until a human does.

## What you get

- **`adversarial_review`**, a tool the model calls before committing. It returns the panel's verdict, every finding, and the path of each full report.
- **A `git commit` gate.** A commit run through bash is blocked unless the panel has cleared the working tree as it stands. A cleared commit gets the panel's report appended to its own tool result, along with a warning if the commit shipped bytes the panel never read.
- **`/review`** runs the panel by hand. **`/review-model [<provider/id> | clear]`** picks the panel's model for this session only — no argument opens a searchable selector over the registry (type-to-filter, like `/model`), `clear` (or `default`) returns to the config default, and the model must be a `provider/id` string validated against the registry at set time. The report header names it as a session override and scopes it to members without their own model. Resets on a new pi instance; invisible to other sessions. **`/review-skip <reason>`** lets one commit through unreviewed. Only the user can do that, and the model is told it was the user's call.
- **A system-prompt section** (`prompts/rules.md`) telling the model how to work with the gate: call it before committing, LOWs are advisory, an overturn means commit now without edits, never re-path a change to dodge a reviewer.

## The panel

Five reviewers ship in `reviewers/`. Each owns one lane and is told what its neighbours cover, so findings don't duplicate:

| Reviewer | Hunts |
|---|---|
| `assumption-auditor` | Quietly made assumptions: defaults, orderings, unit and locale guesses, "reasonable" magic numbers |
| `fail-loud-reviewer` | Failures displaced downstream: silent fallbacks, swallowed errors, phantom success |
| `requirement-fitter` | Whether this commit is a faithful step toward the stated intent, with no unexplained extras and no status claims the diff doesn't back |
| `type-safety-reviewer` | Type escapes, casts, and types narrower or wider than the data |
| `code-style-reviewer` | Style in Python and TypeScript: comments that earn their place, naming, organization |

`moderator/` holds the single moderator. It reads every report and rules on the block as a whole.

To use your own panel, put specs in `<agentDir>/review-gate/reviewers/` (and optionally `<agentDir>/review-gate/moderator/`). A directory there **replaces** the bundled one; it does not merge with it. A spec is Markdown with `name`, `description`, optional `tools` and optional `model` frontmatter, and the system prompt as the body. The gate appends the approval protocol (`src/protocol.ts`) that makes each reviewer's output machine-readable.

A panel member without `model:` runs on the session's model at the session's thinking level, unless `review-gate.json` sets a `model` (see Configuration).

## Requirements

- **An `AGENTS.md` at the repository root.** The gate refuses to run without one. The panel needs to know what the project is, who uses it, its trust model and its stage, or it cannot tell a prototype's acceptable shortcut from a production bug.
- A git repository. Outside one, the gate steps aside and says so.

## Install

```bash
pi install npm:pi-adversarial-review
```

## Configuration

`<agentDir>/review-gate.json`, optional:

```json
{ "maxConcurrency": 1, "model": "<provider>/<model-id>" }
```

Every key is optional.

`maxConcurrency` is how many panel members run at once, from 1 to 8. The default is 4. Use 1 for a local endpoint that caches one conversation at a time: concurrent reviewers evict each other's prefix cache, so every one pays a full prefill.

`model` is the `provider/id` (as `pi --list-models` shows it) that panel members without their own `model:` run on, instead of the session's model. It applies to the moderator too. The session's thinking level is not passed along, since it was set for a different model, and a trailing `:<thinking>` suffix is rejected rather than quietly pinning one — other colons are ordinary id characters, as in `openrouter/google/gemma-4-26b-a4b-it:free`. Changing it invalidates those members' earlier verdicts, the same as editing their specs.

Resolution is strict, and checked against the session's model registry before the panel runs, in the same order pi's own `--model` resolution follows. An exact `provider/id` entry passes (case-insensitively, resolved to the registry's casing); so does a custom id on a known provider, sent to the provider verbatim — how you reach a model pi's registry has not caught up to. Anything pi would reach by fuzzy match runs a different model than you named and fails instead, with the exact id to configure in the error. The canonical `provider/id` the check returns is what gets dispatched, hashed into verdicts, and compared against each member's own report of the model it ran on when the panel runs, so a registry that drifted between the check and the dispatch fails the run rather than reviewing on the wrong model.

The file is read when the extension loads, and an invalid value fails the load rather than falling back to the default.

If `PI_BASH_MAX_TIMEOUT` is set, the gate never raises a cleared commit's bash timeout above it.

## How it works

**Changeset.** The working tree against HEAD, tracked changes and untracked file content, hashed with sha256 (`src/changeset.ts`). The index plays no part: every read goes through a scratch index built from HEAD, so staging never changes the hash or what the panel reads.

That makes the review a review of the working tree, not of the commit. The two usually match, because the model is told to commit what it had reviewed, and the gate checks afterwards. Committing part of the reviewed tree is fine: the panel read more than shipped. Committing bytes the panel never read, such as a stale stage left over from earlier, is reported in the commit's result. It is reported rather than blocked, because the commit has already happened by the time the hook can compare.

The patch is written to the record store and handed to reviewers as a path. The reviewed worktree is also written as a git tree object, so two reviews can be diffed exactly.

**Reuse.** A reviewer's PROCEED counts only for the exact changeset hash *and* the exact spec that produced it, so editing a reviewer's prompt invalidates its verdicts. Anything else re-runs, including a prior BLOCK.

**Live readout.** While the panel runs, a widget above the editor shows every member: state (pending, waiting for a slot, running, retrying after a 429 with the countdown, verdict), its latest tool calls, directional token usage (`↑in ↓out R cache` — a collapsing `R` while `↑` grows means members are evicting each other's prefix cache), elapsed time, and cost. It takes no keyboard focus and is removed when the run ends. The commit hook and `/review` get the same view; RPC and JSON modes keep a footer status line, and the tool row carries a collapsed per-member view.

**Rate-limit retries.** A panel member that fails on a provider 429 (or a reported rate limit) retries up to three times inside its own run: 5s → 15s → 45s with jitter, or the provider's `Retry-After` when it names one. The member's concurrency slot is free while it waits, so a slow upstream doesn't idle the rest of the panel, and each retry restarts from the member's warm seed rather than resuming a half-finished conversation. Every retry is recorded in the report's warnings. Anything else still fails the member, with the panel's one re-run as the last word.

**Warm re-reviews.** Each panel member's pi session is kept per HEAD under `<agentDir>/reviews/<repo>/warm/<head>/<agent>/` (`src/warm.ts`). A re-review on the same HEAD resumes that session and is told exactly what changed since its last pass: `git diff <its last tree> <current tree>`. It still judges the whole changeset. A commit moves HEAD, so the first review after it starts cold, and sessions for commits HEAD has moved past are pruned. A spec edit, a gc'd tree or a malformed state file falls back to a cold start and says so. One panel runs per repository at a time.

**Records.** `<agentDir>/reviews/<repo>/<hash>.json` holds each reviewer's verdict, findings, cleared list and the spec hash it answered, with full reports beside it. The store sits outside the working tree on purpose: a record written into the repo would dirty the tree the review just cleared. The latest 25 changesets are kept.

**Panel integrity.** A spec that will not parse, or a stray non-spec file in the panel directory, fails the gate outright rather than dropping that reviewer. "Every reviewer PROCEEDed" is a claim about who was in the room.

**The commit hook.** Every bash command is checked for `git` at a command position with `commit` as its subcommand (`src/commit.ts`). Without a PROCEED for the working tree as it stands, the reviewers that owe one run, and a BLOCK blocks the call with the full reports attached. After the command, the tree is re-checked, because the verdict was computed before the command ran: a command that writes files and commits in one go is reported as committed on a stale verdict.

Deliberate limits:

- A commit reached through a program that builds its own command (`make commit`, a git alias, a shell nested more than one `-c` deep) is not detected. Matching `commit` anywhere after `git` would gate `git log --grep commit`, and a false positive costs a full panel run. The system prompt tells the model to call the tool itself.
- The gate reviews only the session's repository. A commit that could land elsewhere (`git -C`, `--git-dir`, `GIT_DIR=`, a `cd` out of the tree) is refused, not cleared.

**Recursion.** Panel members run with `PI_REVIEW_GATE_CHILD=1`, and the gate refuses to run under it, so a reviewer can never start a panel of its own.

## Cost

A cold review runs every reviewer over the whole changeset, which is minutes and real tokens on a large diff. Warm re-reviews read only the delta and are much cheaper. Keep commits small: the panel clears a 5 KiB changeset far more easily than a 200 KiB one.

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test
pi --no-extensions -e ./src/index.ts   # try it in a repository with an AGENTS.md
```

The tests use temporary git repositories and a temporary pi agent directory. They never call a model.

## Releasing

1. Bump `version` in `package.json` and add a matching `## [x.y.z]` entry to `CHANGELOG.md`.
2. Merge to `main`.
3. Publish a GitHub release tagged `vx.y.z`. The `publish` workflow checks the tag against `package.json` and the CHANGELOG, runs the checks, and publishes to npm with provenance.

## License

MIT. `src/runner.ts` is adapted from pi's MIT-licensed subagent example; see `LICENSE`.
