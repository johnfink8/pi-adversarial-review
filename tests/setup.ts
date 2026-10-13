import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll } from "vitest";

// The review store, warm sessions, spec overrides and config all live under the
// agent dir, so every test file gets its own and never touches the user's.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adversarial-review-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});
