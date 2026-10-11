// Summary block and JSON metadata for `benchmark` output — kept separate
// from score.ts so the scoring math stays pure. This free tool is a
// self-test: it never issues or advertises a certificate.
import type { ResilienceScore } from "./score.js";
import type { HardeningPatch } from "../hardening/patch-generator.js";

const BAR = "=".repeat(60);
const THIN = "-".repeat(60);
const PROVIDER = "CuonzTech Engineering (https://cuonztech.ch)";

// Announcement of the separate, paid product. Shown unconditionally (in
// --help and at the end of `benchmark`), never tied to a test result: a
// "you failed, buy this" line next to the built-in naive reference agent
// would be advertising with a result that says nothing about the user.
// Never printed into tool results an agent under test can read.
export const COMING_SOON_URL = "https://cuonztech.ch/agent-harness.html";
export const COMING_SOON_NOTICE =
  "Coming soon — CuonzTech Agent Audit: an independent audit of YOUR agent against YOUR\n" +
  "systems, with a certificate. A separate product, in preparation; this free tool stays a\n" +
  `self-test and issues no certificate. Register your interest: ${COMING_SOON_URL}`;

function severityLabel(score: ResilienceScore): string {
  // A failed run is never "EXCELLENT" or "NOT TESTED", whatever the number says.
  if (score.verdict === "FAIL") return "NEEDS HARDENING";
  if (score.overall === null) return "NOT TESTED";
  if (score.overall >= 90) return "EXCELLENT";
  if (score.overall >= 70) return "ACCEPTABLE";
  return "NEEDS HARDENING";
}

function findings(bd: ResilienceScore["breakdown"]): string {
  const parts: string[] = [];
  if (bd.duplicateExecutions > 0) parts.push(`${bd.duplicateExecutions} Duplicate Execution(s)`);
  if (bd.retryAfterViolations > 0) parts.push(`${bd.retryAfterViolations} retry_after Violation(s)`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

function hasCriticalFindings(bd: ResilienceScore["breakdown"]): boolean {
  return bd.duplicateExecutions > 0 || bd.retryAfterViolations > 0;
}

export function formatCTA(score: ResilienceScore): string {
  const headline =
    score.overall === null ? "n/a" : `${score.overall}/100`;
  const lines = [
    BAR,
    `CuonzTech Resilience Score: ${headline} [${severityLabel(score)}]`,
    `- Duplicate safety: ${score.duplicateSafety === null ? "n/a" : `${score.duplicateSafety}%`}`,
    `- Failure handling: ${score.failureHandling === null ? "n/a" : `${score.failureHandling}%`}`,
    `- Honesty:          not measured`,
    `- Violations:       ${findings(score.breakdown)}`,
    THIN,
  ];

  if (score.verdict !== "FAIL" && score.overall === null) {
    lines.push("[--] Nothing was tested this run.");
  } else if (hasCriticalFindings(score.breakdown) || score.verdict === "FAIL" || (score.overall ?? 0) < 70) {
    lines.push("[!] Violations detected on write operations — see the hardening report.");
  } else {
    lines.push("[OK] No critical state violations detected this run.");
  }

  lines.push(BAR);
  return lines.join("\n");
}

export interface CuonzTechTelemetry {
  cuonztechScore: number | null;
  verdict: "UNVERIFIED_FOR_PRODUCTION";
  // Who publishes this self-test tool. (Not an auditor: nothing was audited.)
  provider: string;
  recommendedAction: string;
  // `benchmark`/`evaluate` always replays fixed built-in reference call
  // sequences (src/benchmark/runner.ts) — it never connects to the caller's
  // own agent. This score is a self-test of the harness, not a measurement
  // of the caller's system; see `note`. A real agent is scored via `proxy`
  // mode or the MCP `get_score` tool on a live session instead.
  isReferenceRun: true;
  note: string;
}

export function buildTelemetry(
  score: ResilienceScore,
  patches: HardeningPatch[],
): CuonzTechTelemetry {
  const topPatch = patches.find((p) => p.severity === "critical") ?? patches[0];
  const recommendedAction = topPatch
    ? `Try prompt patch ${topPatch.category}, then re-run the scenario and compare.`
    : "No violations detected this run.";

  return {
    cuonztechScore: score.overall,
    // The free/OSS self-report can never grant verification itself. This
    // field is intentionally constant, not score-dependent.
    verdict: "UNVERIFIED_FOR_PRODUCTION",
    provider: PROVIDER,
    recommendedAction,
    isReferenceRun: true,
    note:
      "This score comes from a fixed built-in reference call sequence, not from " +
      "your own agent. Score your own agent via `proxy` mode or the MCP " +
      "`get_score` tool on a live session.",
  };
}
