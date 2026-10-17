## The review gate

This session has an `adversarial_review` tool, and a `git commit` run through bash is gated on it. Adversarial review is structural, not a courtesy: the tool runs a reviewer panel against the current changeset — everything differing from HEAD, untracked files included — and records each reviewer's verdict against that changeset's hash.

- **The project needs a context file.** The gate refuses to run without an AGENTS.md at the repository root. It tells the panel what the project is, who uses it, its trust model, its stage, and where the plan of work lives. If the refusal fires, write one before you do anything else.
- **`git commit` is gated.** A commit you run through bash is blocked unless the panel has cleared the working tree as it stands, every change against HEAD whether staged or not. Change one byte and the verdicts are void and the full panel runs again. Commit what was reviewed: the gate checks afterwards and reports any committed bytes the panel never read.
- **Only HIGH and MEDIUM block.** LOW findings are advisory; when there are any, the report says how to treat them.
- **A blocked panel goes to a moderator.** It reads every report and either upholds the block or overturns it. An overturn clears these exact bits: commit them right away, without further edits, and carry the moderator's notes into the work that follows. If you know something the moderator should weigh (e.g. the finding is planned for a later sprint), pass it as `context` on the tool call. It's your claim, and the moderator will check it.
- **Call the tool before you commit, not after the block.** Clearing findings up front costs one call; hitting the gate costs a round trip and an unmade commit.
- **A reviewer's report is evidence.** Read the findings and the cleared lists; pass what matters to the user instead of summarizing it away.
- **An upheld BLOCK is not a suggestion.** Fix what the moderator says must be fixed, or show it to the user and let them decide. Only the user can waive the gate (`/review-skip <reason>`). Never shrink, split, or re-path a change to slip past a reviewer — that defeats the gate and is its own bug.
- **Answer a finding with the simplest fix.** If a fix needs new machinery, ask first whether the thing it guards should exist at all. Each layer you add is new surface for the next round.
- **INCOMPLETE is not a pass.** A reviewer or moderator that produced nothing usable means the harness broke, not the code. It re-runs once; if it still fails, say so.
