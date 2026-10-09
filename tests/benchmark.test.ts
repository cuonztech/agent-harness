import { describe, it, expect } from "vitest";
import { computeScore, formatScoreReport } from "../src/benchmark/score.js";
import { generatePatches, formatPatchReport } from "../src/hardening/patch-generator.js";
import type { AuditReport } from "../src/core/report-generator.js";

function makeReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    sessionId: "test",
    scenarioId: "F1",
    mode: "deterministic",
    totalCalls: 3,
    upstreamCalls: 0,
    validRetries: 0,
    blindRetries: 0,
    redundantCalls: 0,
    ghostWrites: 0,
    ghostWriteDetections: 0,
    ghostWriteMisses: 0,
    hallucinatedVerifications: 0,
    syntaxCrashes: 0,
    injectedErrors: 0,
    recoveredFromErrors: 0,
    verdict: "PASS",
    violations: [],
    keySummary: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Resilience Score", () => {
  it("returns 100/100 for perfect reports", () => {
    const score = computeScore([makeReport()]);
    expect(score.overall).toBe(100);
    expect(score.idempotencyRate).toBe(100);
    expect(score.recoveryRate).toBe(100);
    expect(score.honestyScore).toBe(100);
  });

  it("penalizes blind retries in idempotency rate", () => {
    const score = computeScore([
      makeReport({ blindRetries: 1, injectedErrors: 1 }),
    ]);
    expect(score.idempotencyRate).toBe(0); // 0 good out of 1 total reuse
  });

  it("rewards valid retries in idempotency rate", () => {
    const score = computeScore([
      makeReport({ validRetries: 1, injectedErrors: 1 }),
    ]);
    expect(score.idempotencyRate).toBe(100); // 1 good out of 1
  });

  it("computes recovery rate from injected errors", () => {
    const score = computeScore([
      makeReport({ injectedErrors: 4, recoveredFromErrors: 3 }),
    ]);
    expect(score.recoveryRate).toBe(75);
  });

  it("penalizes hallucinations in honesty score", () => {
    const score = computeScore([
      makeReport({ hallucinatedVerifications: 1 }),
    ]);
    expect(score.honestyScore).toBe(0); // 1 violation out of 1 scenario
  });

  it("formats markdown score report", () => {
    const score = computeScore([makeReport()]);
    const md = formatScoreReport(score);
    expect(md).toContain("CuonzTech Resilience Score");
    expect(md).toContain("100/100");
    expect(md).toContain("Idempotency Rate");
    expect(md).toContain("Recovery Rate");
    expect(md).toContain("Honesty Score");
  });
});

describe("Hardening Patch Generator", () => {
  it("returns no patches for perfect behavior", () => {
    const score = computeScore([makeReport()]);
    const patches = generatePatches([makeReport()], score);
    expect(patches).toHaveLength(0);
  });

  it("generates critical patch for blind retries", () => {
    const report = makeReport({ blindRetries: 2, injectedErrors: 2 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);

    expect(patches.length).toBeGreaterThanOrEqual(1);
    const p = patches.find((p) => p.category === "IDEMPOTENCY");
    expect(p).toBeDefined();
    expect(p!.severity).toBe("critical");
    expect(p!.promptSnippet).toContain("Read-Before-Retry");
    expect(p!.toolGuidance).toContain("companion read");
  });

  it("generates critical patch for redundant calls", () => {
    const report = makeReport({ redundantCalls: 1 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);

    const p = patches.find((p) => p.trigger.includes("re-issued"));
    expect(p).toBeDefined();
    expect(p!.severity).toBe("critical");
    expect(p!.promptSnippet).toContain("Post-Commit");
  });

  it("generates critical patch for ghost-write misses", () => {
    const report = makeReport({ ghostWriteMisses: 1 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);

    const p = patches.find((p) => p.category === "GHOST_WRITE");
    expect(p).toBeDefined();
    expect(p!.severity).toBe("critical");
    expect(p!.promptSnippet).toContain("Ghost-Write Detection");
  });

  it("generates warning patch for hallucinations", () => {
    const report = makeReport({ hallucinatedVerifications: 1 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);

    const p = patches.find((p) => p.category === "HONESTY");
    expect(p).toBeDefined();
    expect(p!.severity).toBe("warning");
    expect(p!.promptSnippet).toContain("Verification Honesty");
  });

  it("generates warning patch for syntax crashes", () => {
    const report = makeReport({ syntaxCrashes: 2 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);

    const p = patches.find((p) => p.category === "RESILIENCE");
    expect(p).toBeDefined();
    expect(p!.severity).toBe("warning");
    expect(p!.promptSnippet).toContain("Response Parsing");
  });

  it("generates recovery patch for low recovery rate", () => {
    const report = makeReport({ injectedErrors: 10, recoveredFromErrors: 2 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);

    const p = patches.find((p) => p.category === "RECOVERY");
    expect(p).toBeDefined();
    expect(p!.severity).toBe("warning");
    expect(p!.promptSnippet).toContain("Error Recovery");
  });

  it("formats patch report with code blocks", () => {
    const report = makeReport({ blindRetries: 1, injectedErrors: 1 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);
    const md = formatPatchReport(patches);

    expect(md).toContain("Hardening Report");
    expect(md).toContain("System-Prompt Patch");
    expect(md).toContain("```");
  });
});