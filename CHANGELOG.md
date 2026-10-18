# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2026-10-18

### Added

- **`/review-model [<provider/id> | clear]`**: pick the review panel's model for this session — no argument opens a type-to-search selector over the registry (the `/model` shape: fuzzy filter, enter to pick, esc to cancel), `clear` (or `default`) returns to the config default. Must be a `provider/id` string, validated at set time; the report header names it as a session override scoped to members without their own model. Resets on a new pi instance and never touches other sessions. Same strict resolution as `review-gate.json`'s `model`.
- **Live panel readout**: while the panel runs, a widget above the editor shows each member — state (pending, waiting for a slot, running, retrying after a 429 with the countdown, verdict), latest tool calls, directional token usage, elapsed time, and cost. TUI only; RPC/JSON modes keep the footer status, and the tool row shows a collapsed one-line-per-member view. All entry paths (tool, `/review`, the commit hook) get it.
- **Rate-limit retries with backoff**: a panel member that fails on a provider 429 retries up to three times (5s → 15s → 45s with jitter, or the provider's `Retry-After` when it names one), releasing its concurrency slot while waiting and restarting from its warm seed. Each retry is recorded in the report's warnings; anything else still fails after the panel's one re-run.
- **`model` in `review-gate.json`**: the `provider/id` that panel members without their own `model:` run on, in place of the session's model. Resolution is strict — an exact registry entry, or a custom id on a known provider sent to the provider verbatim; a fuzzy match fails before the panel runs, and each member's reported model is checked against the configured value when the panel runs.

### Changed

- A PROCEED now tells the model to commit the whole reviewed tree in one commit: splitting it moves the changeset hash and sends the remainder back through the panel.
- Every key in `review-gate.json` is optional; `{}` now means all defaults instead of failing the load.
- Cleared reports carry explicit handling for LOW and overturned findings: commit the bits as they stand, fold fixes into planned work rather than a follow-up review bait loop, and move on.
- **Reviewer instructions name the verification the panel must not re-run**: the project's tests, typecheck, linter, and formatter are the author's and CI's job — a reviewer that re-runs them burns turns re-deriving a deterministic result, and the specs now say so in every reviewer's hard rules and in every task prompt, so user-defined reviewers get it too. Read-only inspection and ad-hoc probes stay allowed.

### Fixed

- **`/review-model` no longer offers models from providers without credentials.** The picker listed the full registry (`getAll`), so a provider pi knows but isn't logged into was a choosable entry that died a panel round later with "No API key" — five reviewers, twice each. The picker now lists `getAvailable()` (credential-filtered, like `/model`), and a set-time check refuses a logged-out provider with the `/login` guidance; `runGate` re-checks before children spawn, so credential drift between pick and run fails once and loudly instead of ten times quietly. The stored override is the canonical `provider/id`, so a logged-in provider typed as `OpenAI/...` passes the case-sensitive credential lookup.

[0.1.1]: https://github.com/johnfink8/pi-adversarial-review/compare/v0.1.0...v0.1.1

## [0.1.0] - 2026-10-13

First public release.

### Added

- **`adversarial_review` tool** that runs a panel of reviewer agents over the working tree against HEAD and returns the panel's verdict, every finding, and the path to each full report.
- **`git commit` gate.** A commit run through bash is blocked unless the panel has cleared the working tree as it stands. A cleared commit gets the panel's report appended to its result, and is re-checked afterwards in case it shipped bytes the panel never read.
- **A moderator** who reads every report when the panel blocks, and either upholds the block or overturns it.
- **Five bundled reviewers** (`assumption-auditor`, `fail-loud-reviewer`, `requirement-fitter`, `type-safety-reviewer`, `code-style-reviewer`) and a bundled moderator. A user directory replaces either set whole.
- **Warm re-reviews.** On the same HEAD, each panel member resumes its earlier session and is shown only what changed since its last pass.
- **`/review`** to run the panel by hand, and **`/review-skip <reason>`** to let one commit through unreviewed.
- **The rules the author works under**, injected into the system prompt.
- **`<agentDir>/review-gate.json`** with `maxConcurrency`.

[0.1.0]: https://github.com/johnfink8/pi-adversarial-review/releases/tag/v0.1.0
