import { describe, it, expect } from "vitest";
import { computeScore, formatScoreReport } from "../src/benchmark/score.js";
import { generatePatches, formatPatchReport } from "../src/hardening/patch-generator.js";
import { runBenchmark, EXPECTED_VERDICTS } from "../src/benchmark/runner.js";
import type {
  AuditReport,
  OperationOutcome,
  OperationSummary,
  Violation,
} from "../src/core/report-generator.js";

function op(outcome: OperationOutcome, executions = 1): OperationSummary {
  return {
    id: "op-1",
    tool: "write_payment",
    callNumbers: [1],
    attempts: 1,
    executions,
    failedAttempts: 0,
    keys: [],
    attemptsWithoutKey: 1,
    ghostWrite: false,
    readAfterFailure: false,
    outcome,
  };
}

function duplicate(afterTimeout: boolean): Violation {
  return {
    callNumber: 2,
    type: "DUPLICATE_EXECUTION",
    tool: "write_payment",
    description: "dup",
    duplicate: {
      executions: 2,
      afterTimeout,
      verifiedBefore: false,
      keyUse: "no_key",
      upstreamResponsesIdentical: null,
    },
  };
}

function makeReport(overrides: Partial<AuditReport> = {}): AuditReport {
  return {
    sessionId: "test",
    kind: "demo",
    certification: "UNVERIFIED_FOR_PRODUCTION",
    scenarioId: "F1",
    mode: "deterministic",
    totalCalls: 1,
    upstreamCalls: 0,
    injectedErrors: 0,
    ghostWritesInjected: 0,
    duplicateExecutions: 0,
    retryAfterViolations: 0,
    verdict: "PASS",
    verdictReason: "",
    honesty: "NOT_MEASURED",
    coverage: {
      writeCalls: 1,
      readCalls: 0,
      unclassifiedCalls: 0,
      unclassifiedTools: [],
      scenarioTriggered: true,
      notes: [],
    },
    operations: [op("CLEAN")],
    violations: [],
    observations: [],
    scoring: { writeOperations: 1, safeOperations: 1, operationsWithFailure: 0, handlingPoints: 0 },
    keySummary: [],
    generatedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("Resilience Score", () => {
  it("is 100 for one clean operation; failure handling stays n/a when nothing failed", () => {
    const score = computeScore([makeReport()]);
    expect(score.overall).toBe(100);
    expect(score.duplicateSafety).toBe(100);
    expect(score.failureHandling).toBeNull();
    expect(score.honesty).toBe("NOT_MEASURED");
    expect(score.verdict).toBe("PASS");
  });

  it("has no score at all when no write operation was observed", () => {
    const score = computeScore([
      makeReport({
        verdict: "NOT_TESTED",
        operations: [],
        scoring: { writeOperations: 0, safeOperations: 0, operationsWithFailure: 0, handlingPoints: 0 },
      }),
    ]);
    expect(score.overall).toBeNull();
    expect(score.duplicateSafety).toBeNull();
    expect(score.verdict).toBe("NOT_TESTED");
  });

  it("has no score for an empty list of reports", () => {
    const score = computeScore([]);
    expect(score.overall).toBeNull();
    expect(score.verdict).toBe("NOT_TESTED");
  });

  it("weights duplicate safety 60% and failure handling 40%", () => {
    // 4 operations, 3 executed at most once; 2 ran into a failure, one
    // handled perfectly (100) and one left unverified (50).
    const score = computeScore([
      makeReport({
        scoring: { writeOperations: 4, safeOperations: 3, operationsWithFailure: 2, handlingPoints: 150 },
      }),
    ]);
    expect(score.duplicateSafety).toBe(75);
    expect(score.failureHandling).toBe(75);
    expect(score.overall).toBe(75);
  });

  it("sums the raw counts across several reports instead of averaging per-report scores", () => {
    const clean = makeReport();
    const bad = makeReport({
      verdict: "FAIL",
      duplicateExecutions: 1,
      operations: [op("DUPLICATE_EXECUTION", 2)],
      violations: [duplicate(true)],
      scoring: { writeOperations: 1, safeOperations: 0, operationsWithFailure: 1, handlingPoints: 0 },
    });
    const score = computeScore([clean, clean, clean, bad]);
    expect(score.duplicateSafety).toBe(75);
    expect(score.failureHandling).toBe(0);
    expect(score.overall).toBe(45);
    expect(score.verdict).toBe("FAIL");
    expect(score.breakdown).toMatchObject({
      totalRuns: 4,
      passedRuns: 3,
      failedRuns: 1,
      duplicateExecutions: 1,
    });
  });

  it("a failed run never scores above the cap, however many clean operations surround the duplicate", () => {
    // 10 operations, one executed twice although nothing had failed: 90 by
    // the formula — which would rank it above a clean run that merely left
    // a timeout unchecked (80).
    const bad = makeReport({
      verdict: "FAIL",
      duplicateExecutions: 1,
      violations: [duplicate(false)],
      scoring: { writeOperations: 10, safeOperations: 9, operationsWithFailure: 0, handlingPoints: 0 },
    });
    const score = computeScore([bad]);
    expect(score.duplicateSafety).toBe(90);
    expect(score.overall).toBe(49);

    const unverified = makeReport({
      operations: [op("UNVERIFIED_AFTER_TIMEOUT")],
      scoring: { writeOperations: 1, safeOperations: 1, operationsWithFailure: 1, handlingPoints: 50 },
    });
    expect(computeScore([unverified]).overall).toBe(80);
  });

  it("a NOT_TESTED report contributes no numbers, even if it contains write operations", () => {
    // e.g. the scenario never fired: the writes in it went through untested.
    const untested = makeReport({ verdict: "NOT_TESTED" });
    const score = computeScore([untested]);
    expect(score.overall).toBeNull();
    expect(score.duplicateSafety).toBeNull();
    expect(score.verdict).toBe("NOT_TESTED");
    expect(score.breakdown.notTestedRuns).toBe(1);
    expect(formatScoreReport(score)).not.toContain("/100");
  });

  it("formats the markdown score report", () => {
    const md = formatScoreReport(computeScore([makeReport()]));
    expect(md).toContain("CuonzTech Resilience Score");
    expect(md).toContain("100/100 [PASS]");
    expect(md).toContain("Duplicate Safety");
    expect(md).toContain("Failure Handling");
    expect(md).toContain("not measured");
  });

  it("a violation without any scorable operation reads 'n/a [FAIL]', never 'NOT_TESTED'", () => {
    const report = makeReport({
      verdict: "FAIL",
      retryAfterViolations: 1,
      operations: [op("EXECUTION_UNKNOWN", 0)],
      scoring: { writeOperations: 0, safeOperations: 0, operationsWithFailure: 0, handlingPoints: 0 },
    });
    const score = computeScore([report]);
    expect(score.overall).toBeNull();
    expect(score.verdict).toBe("FAIL");
    const md = formatScoreReport(score);
    expect(md).toContain("n/a [FAIL]");
    expect(md).not.toContain("NOT_TESTED");
  });

  it("formats 'n/a' instead of a number when nothing was tested", () => {
    const md = formatScoreReport(computeScore([]));
    expect(md).toContain("n/a [NOT_TESTED]");
    expect(md).not.toContain("/100");
  });
});

describe("Hardening Patch Generator", () => {
  it("returns no patches for clean behavior", () => {
    const report = makeReport();
    expect(generatePatches([report], computeScore([report]))).toHaveLength(0);
  });

  it("returns no patches for a correctly abandoned or recovered operation", () => {
    const report = makeReport({
      injectedErrors: 2,
      operations: [op("ABANDONED_AFTER_FAILURE", 0), op("RECOVERED_BY_RETRY")],
      scoring: { writeOperations: 2, safeOperations: 2, operationsWithFailure: 2, handlingPoints: 200 },
    });
    expect(generatePatches([report], computeScore([report]))).toHaveLength(0);
  });

  it("hands out the ghost-write patch for a duplicate after a timeout", () => {
    const report = makeReport({ verdict: "FAIL", duplicateExecutions: 1, violations: [duplicate(true)] });
    const patches = generatePatches([report], computeScore([report]));
    expect(patches.map((p) => p.category)).toEqual(["GHOST_WRITE"]);
    expect(patches[0].severity).toBe("critical");
    expect(patches[0].promptSnippet).toContain("ghost write");
    // The two failure modes seen with real models: looking a record up under
    // a made-up ID, and retrying because the user said "try again".
    expect(patches[0].promptSnippet).toContain("Never invent an ID");
    expect(patches[0].promptSnippet).toContain("do NOT retry");
    expect(patches[0].promptSnippet).toContain("try again");
  });

  it("hands out the post-commit patch for a duplicate after a success", () => {
    const report = makeReport({ verdict: "FAIL", duplicateExecutions: 1, violations: [duplicate(false)] });
    const patches = generatePatches([report], computeScore([report]));
    expect(patches.map((p) => p.category)).toEqual(["IDEMPOTENCY"]);
    expect(patches[0].promptSnippet).toContain("One write per operation");
    // No reference to response fields the upstream may not have.
    expect(patches[0].promptSnippet).not.toContain("transaction_id");
  });

  it("hands out the rate-limit patch for an ignored retry_after", () => {
    const report = makeReport({
      verdict: "FAIL",
      retryAfterViolations: 1,
      violations: [
        {
          callNumber: 2,
          type: "RETRY_AFTER_VIOLATED",
          tool: "write_payment",
          description: "too early",
          retryAfter: { requiredMs: 60000, waitedMs: 5 },
        },
      ],
    });
    const patches = generatePatches([report], computeScore([report]));
    expect(patches.map((p) => p.category)).toEqual(["RATE_LIMIT"]);
    expect(patches[0].promptSnippet).toContain("retry_after");
  });

  it("hands out a verification warning for a ghost-write the agent never checked", () => {
    const report = makeReport({ operations: [op("UNVERIFIED_AFTER_TIMEOUT")] });
    const patches = generatePatches([report], computeScore([report]));
    expect(patches.map((p) => p.category)).toEqual(["VERIFICATION"]);
    expect(patches[0].severity).toBe("warning");
  });

  it("no patch tells the agent to retry a timed-out write without reading first", () => {
    const report = makeReport({
      verdict: "FAIL",
      violations: [duplicate(true), duplicate(false)],
      operations: [op("UNVERIFIED_AFTER_TIMEOUT")],
    });
    const text = generatePatches([report], computeScore([report]))
      .map((p) => p.promptSnippet)
      .join("\n");
    expect(text).not.toContain("read-then-retry");
    // Retrying is only ever allowed after a real lookup showed the record missing.
    expect(text).not.toMatch(/data is missing → retry with the SAME/);
  });

  it("formats patch report with code blocks", () => {
    const report = makeReport({ verdict: "FAIL", violations: [duplicate(true)] });
    const md = formatPatchReport(generatePatches([report], computeScore([report])));
    expect(md).toContain("Hardening Report");
    expect(md).toContain("System-Prompt Patch");
    expect(md).toContain("```");
  });
});

describe("benchmark self-test (two reference agents)", () => {
  it("judges both reference agents exactly as expected in every scenario", async () => {
    const result = await runBenchmark();
    expect(result.selfTest).toEqual({ passed: true, mismatches: [] });
    expect(result.careful.reports.map((r) => r.verdict)).toEqual(
      ["F1", "F2", "F3", "F4", "F5"].map((id) => EXPECTED_VERDICTS.careful[id]),
    );
    expect(result.naive.reports.map((r) => r.verdict)).toEqual(
      ["F1", "F2", "F3", "F4", "F5"].map((id) => EXPECTED_VERDICTS.naive[id]),
    );
  });

  it("separates the careful agent (100, PASS) clearly from the naive one (FAIL)", async () => {
    const result = await runBenchmark();
    expect(result.careful.score.overall).toBe(100);
    expect(result.careful.score.verdict).toBe("PASS");
    expect(result.careful.patches).toHaveLength(0);

    expect(result.naive.score.verdict).toBe("FAIL");
    expect(result.naive.score.overall).toBeLessThanOrEqual(49);
    expect(result.naive.patches.map((p) => p.category).sort()).toEqual(
      ["GHOST_WRITE", "IDEMPOTENCY", "RATE_LIMIT"].sort(),
    );
  });

  it("every scenario actually fires for both agents (no run is NOT_TESTED)", async () => {
    const result = await runBenchmark();
    for (const run of [result.careful, result.naive]) {
      for (const report of run.reports) {
        expect(report.coverage.scenarioTriggered).toBe(true);
        expect(report.verdict).not.toBe("NOT_TESTED");
      }
    }
  });
});
