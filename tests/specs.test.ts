import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { discoverModerator, discoverReviewers } from "../src/specs.ts";

const overrideRoot = () => path.join(getAgentDir(), "review-gate");
const reviewersOverride = () => path.join(overrideRoot(), "reviewers");

afterEach(() => {
  if (fs.existsSync(overrideRoot())) fs.chmodSync(overrideRoot(), 0o755);
  fs.rmSync(overrideRoot(), { recursive: true, force: true });
});

function writeSpec(dir: string, name: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\nname: ${name}\ndescription: test\n---\nReview it.\n`);
}

describe("bundled specs", () => {
  it("ship a five-reviewer panel and one moderator", () => {
    const { reviewers } = discoverReviewers();
    expect(reviewers.map((r) => r.name).sort()).toEqual([
      "assumption-auditor",
      "code-style-reviewer",
      "fail-loud-reviewer",
      "requirement-fitter",
      "type-safety-reviewer",
    ]);
    expect(reviewers.every((r) => r.source === "bundled")).toBe(true);
    expect(discoverModerator().source).toBe("bundled");
  });
});

describe("user overrides", () => {
  it("replace the bundled panel whole", () => {
    writeSpec(reviewersOverride(), "solo");
    const { reviewers } = discoverReviewers();
    expect(reviewers.map((r) => r.name)).toEqual(["solo"]);
    expect(reviewers[0]?.source).toBe("user");
  });

  it("refuse a dangling symlink instead of falling back", () => {
    fs.mkdirSync(overrideRoot(), { recursive: true });
    fs.symlinkSync(path.join(overrideRoot(), "nowhere"), reviewersOverride());
    expect(() => discoverReviewers()).toThrow(/symlink to something that does not exist/);
  });

  it.skipIf(process.getuid?.() === 0)("refuse an unreadable override instead of falling back", () => {
    fs.mkdirSync(overrideRoot(), { recursive: true });
    fs.chmodSync(overrideRoot(), 0o000);
    expect(() => discoverReviewers()).toThrow(/Cannot read the reviewers override/);
  });

  it("refuse a stray non-spec entry", () => {
    writeSpec(reviewersOverride(), "solo");
    fs.writeFileSync(path.join(reviewersOverride(), "notes.txt"), "stray");
    expect(() => discoverReviewers()).toThrow(/not loadable specs: notes.txt/);
  });

  it("refuse a spec that will not parse rather than run a partial panel", () => {
    writeSpec(reviewersOverride(), "solo");
    fs.writeFileSync(path.join(reviewersOverride(), "broken.md"), "---\nname: broken\n---\nno description\n");
    expect(() => discoverReviewers()).toThrow(/will not run a partial panel/);
  });

  it("require exactly one moderator", () => {
    const dir = path.join(overrideRoot(), "moderator");
    writeSpec(dir, "one");
    writeSpec(dir, "two");
    expect(() => discoverModerator()).toThrow(/exactly one spec; found 2/);
  });
});
