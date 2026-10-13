import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { captureChangeset } from "../src/changeset.ts";
import { repoDir } from "../src/record.ts";
import { keepWarm, loadWarm, pruneWarm } from "../src/warm.ts";
import { tempRepo } from "./repo.ts";

function fakeSession(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-session-"));
  onTestFinished(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "x_sid-1.jsonl"), "{}\n");
  return dir;
}

describe("warm sessions", () => {
  it("start cold, resume warm on the same HEAD, and go cold after a commit", async () => {
    const repo = tempRepo();
    const warnings: string[] = [];
    repo.write("a.txt", "two\n");
    const first = await captureChangeset(repo.root);

    const cold = await loadWarm(repo.root, first.head, "rev", "spec1", warnings);
    expect(cold.since).toBeUndefined();
    expect(cold.seedDir).toBeUndefined();

    await keepWarm(
      repo.root,
      first.head,
      { agent: "rev", specHash: "spec1", sessionId: "sid-1", tree: first.tree, changesetHash: first.hash },
      fakeSession(),
    );
    repo.write("a.txt", "three\n");
    const second = await captureChangeset(repo.root);
    const warm = await loadWarm(repo.root, second.head, "rev", "spec1", warnings);
    expect(warm.since?.tree).toBe(first.tree);
    expect(warm.sessionId).toBe("sid-1");
    expect(warm.seedDir).toBeDefined();

    repo.git("add", "-A");
    repo.git("commit", "-qm", "landed");
    const after = await captureChangeset(repo.root);
    expect((await loadWarm(repo.root, after.head, "rev", "spec1", warnings)).since).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it("goes cold and says so when the spec changed", async () => {
    const repo = tempRepo();
    const warnings: string[] = [];
    repo.write("a.txt", "two\n");
    const changeset = await captureChangeset(repo.root);
    await keepWarm(
      repo.root,
      changeset.head,
      { agent: "rev", specHash: "spec1", sessionId: "sid-1", tree: changeset.tree, changesetHash: changeset.hash },
      fakeSession(),
    );
    const start = await loadWarm(repo.root, changeset.head, "rev", "spec2", warnings);
    expect(start.since).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("prunes sessions for commits HEAD has moved past", async () => {
    const repo = tempRepo();
    const warnings: string[] = [];
    repo.write("a.txt", "two\n");
    const before = await captureChangeset(repo.root);
    await keepWarm(
      repo.root,
      before.head,
      { agent: "rev", specHash: "spec1", sessionId: "sid-1", tree: before.tree, changesetHash: before.hash },
      fakeSession(),
    );
    repo.git("add", "-A");
    repo.git("commit", "-qm", "landed");
    const after = await captureChangeset(repo.root).catch(() => undefined);
    const head = after?.head ?? repo.git("rev-parse", "HEAD");
    await pruneWarm(repo.root, head, warnings);
    expect(fs.existsSync(path.join(repoDir(repo.root), "warm", before.head))).toBe(false);
    expect(warnings).toEqual([]);
  });
});
