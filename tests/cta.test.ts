import { describe, it, expect } from "vitest";
import { formatCTA, buildTelemetry } from "../src/benchmark/cta.js";
import { computeScore } from "../src/benchmark/score.js";
import { generatePatches } from "../src/hardening/patch-generator.js";
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

describe("formatCTA", () => {
  it("prints an [OK] line and no upsell for a clean run", () => {
    const score = computeScore([makeReport()]);
    const cta = formatCTA(score);
    expect(cta).toContain("CuonzTech Resilience Score: 100/100 [EXCELLENT]");
    expect(cta).toContain("[OK] No critical state violations detected this run.");
    expect(cta).not.toContain("cuonztech.ch/audit");
  });

  it("prints the upsell CTA with cuonztech.ch/audit when critical findings exist", () => {
    const report = makeReport({ ghostWriteMisses: 1, blindRetries: 1, injectedErrors: 2 });
    const score = computeScore([report]);
    const cta = formatCTA(score);
    expect(cta).toContain("NEEDS HARDENING");
    expect(cta).toContain("1 Ghost-Write(s) Missed");
    expect(cta).toContain("1 Blind Retry(s)");
    expect(cta).toContain("https://cuonztech.ch/audit");
  });
});

describe("buildTelemetry", () => {
  it("always reports UNVERIFIED_FOR_PRODUCTION even for a perfect score", () => {
    const score = computeScore([makeReport()]);
    const telemetry = buildTelemetry(score, []);
    expect(telemetry.cuonztechScore).toBe(100);
    expect(telemetry.verdict).toBe("UNVERIFIED_FOR_PRODUCTION");
    expect(telemetry.auditProvider).toContain("CuonzTech");
    expect(telemetry.recommendedAction).toContain("Architecture Review");
  });

  it("recommends the top critical patch's category when violations exist", () => {
    const report = makeReport({ blindRetries: 2, injectedErrors: 2 });
    const score = computeScore([report]);
    const patches = generatePatches([report], score);
    const telemetry = buildTelemetry(score, patches);
    expect(telemetry.recommendedAction).toContain("IDEMPOTENCY");
    expect(telemetry.recommendedAction).toContain("cuonztech.ch/audit");
  });
});
