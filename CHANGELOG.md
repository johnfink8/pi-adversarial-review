# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Rate-limit retries with backoff**: a panel member that fails on a provider 429 retries up to three times (5s → 15s → 45s with jitter, or the provider's `Retry-After` when it names one), releasing its concurrency slot while waiting and restarting from its warm seed. Each retry is recorded in the report's warnings; anything else still fails after the panel's one re-run.
- **`model` in `review-gate.json`**: the `provider/id` that panel members without their own `model:` run on, in place of the session's model. Resolution is strict — an exact registry entry, or a custom id on a known provider sent to the provider verbatim; a fuzzy match fails before the panel runs, and each member's reported model is checked against the configured value when the panel runs.

### Changed

- Every key in `review-gate.json` is optional; `{}` now means all defaults instead of failing the load.
- Cleared reports carry explicit handling for LOW and overturned findings: commit the bits as they stand, fold fixes into planned work rather than a follow-up review bait loop, and move on.

[Unreleased]: https://github.com/johnfink8/pi-adversarial-review/compare/v0.1.0...HEAD

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
