import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterAll } from "vitest";

// The review store, warm sessions, spec overrides and config all live under the
// agent dir, so every test file gets its own and never touches the user's.
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-adversarial-review-test-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// Tests delete config and override files under the agent dir. If pi ever stops
// honouring the variable, they would delete the user's real ones instead, so
// the suite refuses to run rather than trusting the isolation.
if (getAgentDir() !== agentDir) {
  throw new Error(
    `agent-dir isolation failed: getAgentDir() returned ${getAgentDir()}, not ${agentDir}. ` +
      "Refusing to run tests that would write to the real pi agent directory.",
  );
}

afterAll(() => {
  fs.rmSync(agentDir, { recursive: true, force: true });
});
