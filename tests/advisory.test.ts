import { describe, expect, it } from "vitest";
import { type AggregatedFinding, advisoryGuidance } from "../src/gate.ts";

const finding = (severity: AggregatedFinding["severity"]): AggregatedFinding => ({
  agent: "a",
  severity,
  file: "f.ts",
  line: "1",
  problem: "p",
  fix: "x",
});

describe("advisory guidance", () => {
  it("is given when a PROCEED carries LOWs", () => {
    const block = advisoryGuidance({ cleared: true, verdict: "PROCEED", findings: [finding("LOW"), finding("LOW")] });
    expect(block).toContain("Advisory findings (2 LOW)");
    expect(block).toContain("Do not start a follow-up change");
  });

  it("counts an overturned BLOCK's overruled findings alongside its LOWs", () => {
    const block = advisoryGuidance({
      cleared: true,
      verdict: "BLOCK",
      findings: [finding("LOW"), finding("MEDIUM"), finding("HIGH")],
    });
    expect(block).toContain("Advisory findings (1 LOW, 2 overturned)");
  });

  it("is given for an overturned BLOCK with no LOWs at all", () => {
    const block = advisoryGuidance({ cleared: true, verdict: "BLOCK", findings: [finding("MEDIUM")] });
    expect(block).toContain("Advisory findings (1 overturned)");
  });

  it("is absent when nothing is left to advise on", () => {
    expect(advisoryGuidance({ cleared: true, verdict: "PROCEED", findings: [] })).toBeUndefined();
  });

  it("is absent when the bits are not cleared, so a BLOCK's fix list stays the only instruction", () => {
    expect(
      advisoryGuidance({ cleared: false, verdict: "BLOCK", findings: [finding("MEDIUM"), finding("LOW")] }),
    ).toBeUndefined();
  });
});
