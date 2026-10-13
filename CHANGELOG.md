# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-13

First public release.

### Added

- **`adversarial_review` tool** that runs a panel of reviewer agents over the working tree against HEAD and returns the panel's verdict, every finding, and the path to each full report.
- **`git commit` gate.** A commit run through bash is blocked unless the panel cleared exactly these bits. A cleared commit gets the panel's report appended to its result, and is re-checked afterwards in case the command changed the tree.
- **A moderator** who reads every report when the panel blocks, and either upholds the block or overturns it.
- **Five bundled reviewers** (`assumption-auditor`, `fail-loud-reviewer`, `requirement-fitter`, `type-safety-reviewer`, `code-style-reviewer`) and a bundled moderator. A user directory replaces either set whole.
- **Warm re-reviews.** On the same HEAD, each panel member resumes its earlier session and is shown only what changed since its last pass.
- **`/review`** to run the panel by hand, and **`/review-skip <reason>`** to let one commit through unreviewed.
- **The rules the author works under**, injected into the system prompt.
- **`<agentDir>/review-gate.json`** with `maxConcurrency`.

[0.1.0]: https://github.com/johnfink8/pi-adversarial-review/releases/tag/v0.1.0
