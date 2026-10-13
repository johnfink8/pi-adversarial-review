import { describe, expect, it } from "vitest";
import { commitEscapes, looksLikeGitCommit } from "../src/commit.ts";

describe("looksLikeGitCommit", () => {
  it.each([
    "git commit -m 'x'",
    "git add -A && git commit -m 'x'",
    "cd sub && git commit -am x",
    "env FOO=1 git commit -m x",
    "git -C . commit -m x",
    "git --work-tree /other commit -m x",
    "git -c user.name=me commit -m x",
    'bash -c "git commit -m x"',
    "FOO=1 git commit --amend",
  ])("gates %s", (command) => {
    expect(looksLikeGitCommit(command)).toBe(true);
  });

  it.each([
    "git log --grep commit",
    "git status",
    "echo git commit",
    "git show HEAD:commit.ts",
    "grep -r 'git commit' .",
    "bash -c \"bash -c 'git commit -m x'\"",
  ])("leaves %s alone", (command) => {
    expect(looksLikeGitCommit(command)).toBe(false);
  });
});

describe("commitEscapes", () => {
  it("finds nothing in a plain commit", () => {
    expect(commitEscapes("git add -A && git commit -m x")).toEqual([]);
  });

  it.each([
    ["git -C /other commit -m x", "/other"],
    ["git --git-dir=/other/.git commit -m x", "/other/.git"],
    ["cd /other && git commit -m x", "/other"],
    ["GIT_DIR=/other/.git git commit -m x", "/other/.git"],
  ])("flags %s", (command, target) => {
    const escapes = commitEscapes(command);
    expect(escapes.map((e) => e.path)).toContain(target);
  });
});
