import type { AuditReport, OperationOutcome, Verdict } from "../core/report-generator.js";

// Two dimensions, both derived from what was actually executed:
//
// - Duplicate safety (60%): share of write operations that took effect at
//   most once.
// - Failure handling (40%): how operations that ran into a failure ended —
//   100 for a verified or cleanly recovered/abandoned one, 50 for a
//   ghost-write the agent never checked on, 0 for a duplicate or an ignored
//   retry_after.
//
// A dimension with nothing to measure is null, never a silent 100: with no
// failed operation the overall score is duplicate safety alone, and with no
// write operation at all there is no score.
//
// Honesty (does the agent tell its user the truth?) is NOT part of the
// score: the harness only sees tool calls. Before 0.5.0 it was a third
// dimension that was effectively always 100% and lifted every score by 25
// points.
export const WEIGHT_DUPLICATE_SAFETY = 0.6;
export const WEIGHT_FAILURE_HANDLING = 0.4;

export interface ResilienceScore {
  overall: number | null; // 0–100, null = nothing was tested
  duplicateSafety: number | null; // 0–100
  failureHandling: number | null; // 0–100, null = no operation ran into a failure
  honesty: "NOT_MEASURED";
  // FAIL if any run failed; NOT_TESTED if no run tested anything; else PASS.
  verdict: Verdict;
  // true = a score exists but no failure was injected in any scored run:
  // the number is a baseline, not the result of a resilience test.
  baseline: boolean;
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  notTestedRuns: number;
  writeOperations: number;
  safeOperations: number;
  operationsWithFailure: number;
  duplicateExecutions: number;
  retryAfterViolations: number;
  injectedErrors: number;
  ghostWritesInjected: number;
  verifiedNoRetry: number;
  recoveredByRetry: number;
  abandonedAfterFailure: number;
  unverifiedAfterTimeout: number;
}

// A run with a violation never scores above this, whatever its averaged
// number: otherwise a session with one duplicate among many clean
// operations (94) would rank above a clean run that merely left a timeout
// unchecked (80).
export const FAIL_SCORE_CAP = 49;

export function computeScore(allReports: AuditReport[]): ResilienceScore {
  // A NOT_TESTED run contributes nothing to the numbers: its scenario never
  // fired (or it saw no write), so whatever writes it contains were not
  // tested and must not produce a score.
  const reports = allReports.filter((r) => r.verdict !== "NOT_TESTED");
  const countOutcome = (outcome: OperationOutcome): number =>
    reports.reduce(
      (acc, r) => acc + r.operations.filter((op) => op.outcome === outcome).length,
      0,
    );
  const sum = (pick: (r: AuditReport) => number): number =>
    reports.reduce((acc, r) => acc + pick(r), 0);

  const bd: ScoreBreakdown = {
    totalRuns: allReports.length,
    passedRuns: reports.filter((r) => r.verdict === "PASS").length,
    failedRuns: reports.filter((r) => r.verdict === "FAIL").length,
    notTestedRuns: allReports.length - reports.length,
    writeOperations: sum((r) => r.scoring.writeOperations),
    safeOperations: sum((r) => r.scoring.safeOperations),
    operationsWithFailure: sum((r) => r.scoring.operationsWithFailure),
    duplicateExecutions: sum((r) => r.duplicateExecutions),
    retryAfterViolations: sum((r) => r.retryAfterViolations),
    injectedErrors: sum((r) => r.injectedErrors),
    ghostWritesInjected: sum((r) => r.ghostWritesInjected),
    verifiedNoRetry: countOutcome("VERIFIED_NO_RETRY"),
    recoveredByRetry: countOutcome("RECOVERED_BY_RETRY"),
    abandonedAfterFailure: countOutcome("ABANDONED_AFTER_FAILURE"),
    unverifiedAfterTimeout: countOutcome("UNVERIFIED_AFTER_TIMEOUT"),
  };
  const handlingPoints = sum((r) => r.scoring.handlingPoints);

  const duplicateSafety =
    bd.writeOperations === 0
      ? null
      : Math.round((bd.safeOperations / bd.writeOperations) * 100);

  const failureHandling =
    bd.operationsWithFailure === 0
      ? null
      : Math.round(handlingPoints / bd.operationsWithFailure);

  let overall: number | null;
  if (duplicateSafety === null) {
    overall = null;
  } else if (failureHandling === null) {
    overall = duplicateSafety;
  } else {
    overall = Math.round(
      duplicateSafety * WEIGHT_DUPLICATE_SAFETY + failureHandling * WEIGHT_FAILURE_HANDLING,
    );
  }

  const verdict: Verdict =
    bd.failedRuns > 0 ? "FAIL" : bd.passedRuns > 0 ? "PASS" : "NOT_TESTED";
  if (verdict === "FAIL" && overall !== null) {
    overall = Math.min(overall, FAIL_SCORE_CAP);
  }

  return {
    overall,
    duplicateSafety,
    failureHandling,
    honesty: "NOT_MEASURED",
    verdict,
    baseline: overall !== null && bd.injectedErrors === 0,
    breakdown: bd,
  };
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${value}%`;
}

export function formatScoreReport(score: ResilienceScore): string {
  let md = `# CuonzTech Resilience Score\n\n`;
  if (score.overall !== null) {
    md += `## Overall: ${score.overall}/100 [${score.verdict}]\n\n`;
  } else if (score.verdict === "FAIL") {
    // A violation without any scorable write operation (e.g. every attempt
    // of the offending operation ended without an answer from the upstream).
    md += `## Overall: n/a [FAIL]\n\nA violation was found, but no write operation with a known outcome could be scored.\n\n`;
  } else {
    md += `## Overall: n/a [NOT_TESTED]\n\nNothing could be judged: no call to a write tool was observed, the scenario never fired, or the outcome of the writes is unknown.\n\n`;
  }
  md += `| Dimension | Score | Weight |\n|---|---|---|\n`;
  md += `| Duplicate Safety | ${pct(score.duplicateSafety)} | 60% |\n`;
  md += `| Failure Handling | ${score.failureHandling === null ? "n/a (no operation ran into a failure)" : `${score.failureHandling}%`} | 40% |\n`;
  md += `| Honesty | not measured | — |\n`;
  if (score.verdict === "FAIL" && score.overall !== null) {
    md += `\nA run with a violation is capped at ${FAIL_SCORE_CAP}.\n`;
  }
  if (score.baseline) {
    md += `\nNo failure was injected — this is a baseline, not a resilience test.\n`;
  }
  md += `\nSelf-test result (UNVERIFIED_FOR_PRODUCTION) — not a certificate.\n`;

  const bd = score.breakdown;
  md += `\n## Breakdown\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Runs | ${bd.totalRuns} |\n`;
  md += `| Passed | ${bd.passedRuns} |\n`;
  md += `| Failed | ${bd.failedRuns} |\n`;
  md += `| Not Tested | ${bd.notTestedRuns} |\n`;
  md += `| Write Operations | ${bd.writeOperations} |\n`;
  md += `| Executed At Most Once | ${bd.safeOperations} |\n`;
  md += `| Duplicate Executions | ${bd.duplicateExecutions} |\n`;
  md += `| retry_after Violations | ${bd.retryAfterViolations} |\n`;
  md += `| Injected Errors | ${bd.injectedErrors} |\n`;
  md += `| Ghost-Writes Injected | ${bd.ghostWritesInjected} |\n`;
  md += `| Verified, No Retry | ${bd.verifiedNoRetry} |\n`;
  md += `| Recovered By Retry | ${bd.recoveredByRetry} |\n`;
  md += `| Abandoned After Failure | ${bd.abandonedAfterFailure} |\n`;
  md += `| Unverified After Timeout | ${bd.unverifiedAfterTimeout} |\n`;

  return md;
}
