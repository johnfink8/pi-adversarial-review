import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { captureChangeset, committedDrift, NotARepositoryError, writeInterdiff } from "../src/changeset.ts";
import { tempRepo } from "./repo.ts";

describe("captureChangeset", () => {
  it("covers tracked edits and untracked files", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    repo.write("new.txt", "fresh\n");
    const changeset = await captureChangeset(repo.root);
    expect(changeset.files).toEqual(["a.txt", "new.txt"]);
    const patch = fs.readFileSync(changeset.patchPath, "utf-8");
    expect(patch).toContain("+two");
    expect(patch).toContain("fresh");
  });

  it("ignores the index entirely", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    repo.write("new.txt", "fresh\n");
    const unstaged = (await captureChangeset(repo.root)).hash;

    repo.git("add", "-A");
    expect((await captureChangeset(repo.root)).hash).toBe(unstaged);
    repo.git("reset", "-q");
    repo.git("rm", "-q", "--cached", "a.txt");
    expect((await captureChangeset(repo.root)).hash).toBe(unstaged);
    repo.git("reset", "-q");
    repo.git("add", "-N", "new.txt");
    expect((await captureChangeset(repo.root)).hash).toBe(unstaged);
  });

  it("changes hash when the worktree changes", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    const first = await captureChangeset(repo.root);
    repo.write("a.txt", "three\n");
    expect((await captureChangeset(repo.root)).hash).not.toBe(first.hash);
  });

  it("refuses a directory that is not a repository", async () => {
    const repo = tempRepo();
    fs.rmSync(path.join(repo.root, ".git"), { recursive: true });
    await expect(captureChangeset(repo.root)).rejects.toBeInstanceOf(NotARepositoryError);
  });
});

describe("committedDrift", () => {
  it("is empty when the commit ships the reviewed bytes", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    const reviewed = await captureChangeset(repo.root);
    repo.git("add", "-A");
    repo.git("commit", "-qm", "clean");
    expect(await committedDrift(repo.root, reviewed.head, reviewed.snapshot)).toEqual([]);
  });

  it("catches a stale stage", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    repo.git("add", "a.txt");
    repo.write("a.txt", "three\n");
    const reviewed = await captureChangeset(repo.root);
    repo.git("commit", "-qm", "stale");
    const drift = await committedDrift(repo.root, reviewed.head, reviewed.snapshot);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("a.txt");
  });
});

describe("writeInterdiff", () => {
  it("diffs two reviewed trees", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    const first = await captureChangeset(repo.root);
    repo.write("a.txt", "three\n");
    const second = await captureChangeset(repo.root);
    const delta = await writeInterdiff(second, first.tree);
    expect(delta.files).toEqual(["a.txt"]);
    const text = fs.readFileSync(delta.path, "utf-8");
    expect(text).toContain("-two");
    expect(text).toContain("+three");
  });

  it("survives concurrent writers of the same delta", async () => {
    const repo = tempRepo();
    repo.write("a.txt", "two\n");
    const first = await captureChangeset(repo.root);
    repo.write("a.txt", "three\n");
    const second = await captureChangeset(repo.root);
    const deltas = await Promise.all(Array.from({ length: 6 }, () => writeInterdiff(second, first.tree)));
    expect(new Set(deltas.map((d) => d.path)).size).toBe(1);
    const leftovers = fs.readdirSync(path.dirname(second.patchPath)).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });
});
