import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { onTestFinished } from "vitest";

export interface TempRepo {
  root: string;
  git: (...args: string[]) => string;
  write: (file: string, text: string) => void;
}

/** A git repository with one commit, removed when the test finishes. */
export function tempRepo(): TempRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "review-repo-")));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
  const write = (file: string, text: string) => fs.writeFileSync(path.join(root, file), text);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "test");
  git("config", "commit.gpgsign", "false");
  write("a.txt", "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { root, git, write };
}
