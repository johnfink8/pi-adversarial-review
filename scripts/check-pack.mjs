// Fails when the npm tarball would be missing a file the extension reads at
// runtime. The tests import ../src directly, so a `files` glob that drops one
// would otherwise pass CI and ship broken.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const RUNTIME_DIRS = { src: ".ts", prompts: ".md", reviewers: ".md", moderator: ".md" };

const [pack] = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf-8" }),
);
const packed = new Set(pack.files.map((file) => file.path));

const required = ["package.json", "README.md", "LICENSE", "CHANGELOG.md"];
for (const [dir, extension] of Object.entries(RUNTIME_DIRS)) {
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(extension)) {
      required.push(path.relative(".", path.join(entry.parentPath, entry.name)));
    }
  }
}

const missing = required.filter((file) => !packed.has(file));
if (missing.length > 0) {
  console.error(`npm tarball is missing files the extension needs:\n${missing.map((f) => `  ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`npm tarball has all ${required.length} required files (${packed.size} total).`);
