# pi-adversarial-review

An adversarial review gate for the pi coding agent. A panel of reviewer agents examines a session's changeset (everything differing from HEAD, plus untracked files); `git commit` run through bash stays blocked until the panel clears the tree, and a blocked verdict goes to a moderator who upholds or overturns it.

**Users:** developers who use pi as their coding agent and install this as an extension (`pi install npm:pi-adversarial-review`).

**Trust model:** reviewers are LLM agents with restricted tool access, scoped by frontmatter; they cannot commit. The gate is structural, not advisory — its job is to be hard to bypass, so any change that weakens the gate (looser validation, quieter failures, shrinking or re-pathing reviewed changes) deserves scrutiny.

**Stage:** early release (0.1.x), pre-1.0, used daily by the author.

**Plan of work:** there is no roadmap file; work is session-driven. Pending ideas live in the GitHub issue tracker.