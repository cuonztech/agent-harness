import { describe, it, expect, beforeEach } from "vitest";
import { formatCTA, buildTelemetry } from "../src/benchmark/cta.js";
import { computeScore } from "../src/benchmark/score.js";
import { generatePatches } from "../src/hardening/patch-generator.js";
import { generateReport, type AuditReport } from "../src/core/report-generator.js";
import {
  createSession,
  incrementCall,
  addRecord,
  deleteSession,
  listSessions,
} from "../src/engine/state-machine.js";

// Reports are produced by the real pipeline, not hand-built, so the CTA is
// tested against what generateReport() actually emits.
function reportFor(
  kind: "clean" | "duplicate-after-timeout" | "duplicate-after-success" | "empty",
): AuditReport {
  const session = createSession(kind === "clean" ? null : "F1");
  const add = (injectedError: string | null): void => {
    const callNumber = incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber,
      toolName: "write_payment",
      args: { amount: 100 },
      injectedError,
      response: "{}",
      upstreamExecuted: true,
      timestamp: callNumber * 1000,
      scenarioTriggered: injectedError !== null,
    });
  };
  if (kind === "clean") add(null);
  if (kind === "duplicate-after-timeout") {
    add("[TIMEOUT]");
    add(null);
  }
  if (kind === "duplicate-after-success") {
    add(null);
    add(null);
    session.history[0].scenarioTriggered = true;
  }
  return generateReport(session);
}

describe("formatCTA", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  it("prints an [OK] line and no upsell for a clean run", () => {
    const cta = formatCTA(computeScore([reportFor("clean")]));
    expect(cta).toContain("CuonzTech Resilience Score: 100/100 [EXCELLENT]");
    expect(cta).toContain("[OK] No critical state violations detected this run.");
    expect(cta).toContain("Honesty:          not measured");
  });

  it("points to the hardening report when violations exist — and never advertises an audit or certificate", () => {
    const cta = formatCTA(computeScore([reportFor("duplicate-after-timeout")]));
    expect(cta).toContain("NEEDS HARDENING");
    expect(cta).toContain("- Violations:       1 Duplicate Execution(s)");
    expect(cta).toContain("see the hardening report");
    expect(cta.toLowerCase()).not.toMatch(/audit|certif|enterprise/);
  });

  it("never labels a failed run EXCELLENT, even when the averaged number is high", () => {
    const clean = reportFor("clean");
    const reports = [...Array.from({ length: 19 }, () => clean), reportFor("duplicate-after-success")];
    const score = computeScore(reports);
    // 19 of 20 operations were fine: 95 by the formula, capped because the run failed.
    expect(score.duplicateSafety).toBe(95);
    expect(score.overall).toBe(49);
    expect(formatCTA(score)).toContain("[NEEDS HARDENING]");
  });

  it("a failed run without a score is labeled NEEDS HARDENING, not NOT TESTED", () => {
    const score = { ...computeScore([reportFor("duplicate-after-timeout")]), overall: null };
    const cta = formatCTA(score);
    expect(cta).toContain("n/a [NEEDS HARDENING]");
    expect(cta).not.toContain("Nothing was tested");
  });

  it("says nothing was tested instead of printing a score for an empty run", () => {
    const cta = formatCTA(computeScore([reportFor("empty")]));
    expect(cta).toContain("CuonzTech Resilience Score: n/a [NOT TESTED]");
    expect(cta).toContain("Nothing was tested");
    expect(cta).not.toContain("[OK]");
  });
});

describe("buildTelemetry", () => {
  it("always reports UNVERIFIED_FOR_PRODUCTION even for a perfect score", () => {
    const score = computeScore([reportFor("clean")]);
    const telemetry = buildTelemetry(score, []);
    expect(telemetry.cuonztechScore).toBe(100);
    expect(telemetry.verdict).toBe("UNVERIFIED_FOR_PRODUCTION");
    expect(telemetry.provider).toContain("CuonzTech");
    expect(telemetry.recommendedAction).toBe("No violations detected this run.");
  });

  it("recommends the top critical patch's category when violations exist", () => {
    const report = reportFor("duplicate-after-timeout");
    const score = computeScore([report]);
    const telemetry = buildTelemetry(score, generatePatches([report], score));
    expect(telemetry.recommendedAction).toContain("GHOST_WRITE");
    expect(telemetry.recommendedAction.toLowerCase()).not.toMatch(/audit|certif/);
  });
});
