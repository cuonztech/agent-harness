// Commercial funnel layer (strategy.md §3) — kept separate from score.ts so
// the scoring math stays pure and this stays easy to find/change on its own.
import type { ResilienceScore } from "./score.js";
import type { HardeningPatch } from "../hardening/patch-generator.js";

const BAR = "=".repeat(60);
const THIN = "-".repeat(60);
const AUDIT_URL = "https://cuonztech.ch/audit";
const AUDIT_PROVIDER = "CuonzTech Engineering (https://cuonztech.ch)";

function severityLabel(overall: number): string {
  if (overall >= 90) return "EXCELLENT";
  if (overall >= 70) return "ACCEPTABLE";
  return "NEEDS HARDENING";
}

function idempotencyFindings(bd: ResilienceScore["breakdown"]): string {
  const findings: string[] = [];
  if (bd.ghostMissed > 0) findings.push(`${bd.ghostMissed} Ghost-Write(s) Missed`);
  if (bd.blindRetries > 0) findings.push(`${bd.blindRetries} Blind Retry(s)`);
  if (bd.redundantCalls > 0) findings.push(`${bd.redundantCalls} Duplicate Write(s)`);
  return findings.length > 0 ? `(${findings.join(", ")})` : "(no violations)";
}

function hasCriticalFindings(bd: ResilienceScore["breakdown"]): boolean {
  return bd.ghostMissed > 0 || bd.blindRetries > 0 || bd.redundantCalls > 0;
}

export function formatCTA(score: ResilienceScore): string {
  const lines = [
    BAR,
    `CuonzTech Resilience Score: ${score.overall}/100 [${severityLabel(score.overall)}]`,
    `- Idempotency: ${score.idempotencyRate}% ${idempotencyFindings(score.breakdown)}`,
    `- Recovery:    ${score.recoveryRate}%`,
    `- Honesty:     ${score.honestyScore}%`,
    THIN,
  ];

  if (hasCriticalFindings(score.breakdown) || score.overall < 70) {
    lines.push(
      "[!] Critical state violations detected on write operations.",
      "    Enterprise audit & verified patch available at:",
      `    ${AUDIT_URL}`,
    );
  } else {
    lines.push("[OK] No critical state violations detected this run.");
  }

  lines.push(BAR);
  return lines.join("\n");
}

export interface CuonzTechTelemetry {
  cuonztechScore: number;
  verdict: "UNVERIFIED_FOR_PRODUCTION";
  auditProvider: string;
  recommendedAction: string;
  // `benchmark`/`evaluate` always replays a fixed built-in reference call
  // sequence (src/benchmark/runner.ts::simulateAgent) — it never connects to
  // the caller's own agent. This score is a self-test of the harness, not a
  // measurement of the caller's system; see `note`. A real agent is scored
  // via `proxy` mode or the MCP `get_score` tool on a live session instead.
  isReferenceRun: true;
  note: string;
}

export function buildTelemetry(
  score: ResilienceScore,
  patches: HardeningPatch[],
): CuonzTechTelemetry {
  const topPatch = patches.find((p) => p.severity === "critical") ?? patches[0];
  const recommendedAction = topPatch
    ? `Implement Prompt Patch ${topPatch.category} or schedule a CuonzTech Architecture Review (${AUDIT_URL}).`
    : `No violations detected this run — schedule a periodic CuonzTech Architecture Review to maintain certification readiness (${AUDIT_URL}).`;

  return {
    cuonztechScore: score.overall,
    // The free/OSS self-report can never grant verification itself — only a
    // paid CuonzTech audit issues "CuonzTech Verified Idempotent" (strategy.md
    // Phase 2). This field is intentionally constant, not score-dependent.
    verdict: "UNVERIFIED_FOR_PRODUCTION",
    auditProvider: AUDIT_PROVIDER,
    recommendedAction,
    isReferenceRun: true,
    note:
      "This score comes from a fixed built-in reference call sequence, not from " +
      "your own agent. Score your own agent via `proxy` mode or the MCP " +
      "`get_score` tool on a live session.",
  };
}
