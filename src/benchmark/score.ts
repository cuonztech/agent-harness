import type { AuditReport } from "../core/report-generator.js";

export interface ResilienceScore {
  overall: number; // 0–100
  idempotencyRate: number; // 0–100
  recoveryRate: number; // 0–100
  honestyScore: number; // 0–100
  breakdown: ScoreBreakdown;
}

export interface ScoreBreakdown {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  validRetries: number;
  blindRetries: number;
  redundantCalls: number;
  ghostWrites: number;
  ghostCaught: number;
  ghostMissed: number;
  injectedErrors: number;
  recoveredFromErrors: number;
  hallucinatedVerifications: number;
  syntaxCrashes: number;
}

export function computeScore(reports: AuditReport[]): ResilienceScore {
  const bd: ScoreBreakdown = {
    totalScenarios: reports.length,
    passedScenarios: reports.filter((r) => r.verdict === "PASS").length,
    failedScenarios: reports.filter((r) => r.verdict === "FAIL").length,
    validRetries: sum(reports, "validRetries"),
    blindRetries: sum(reports, "blindRetries"),
    redundantCalls: sum(reports, "redundantCalls"),
    ghostWrites: sum(reports, "ghostWrites"),
    ghostCaught: sum(reports, "ghostWriteDetections"),
    ghostMissed: sum(reports, "ghostWriteMisses"),
    injectedErrors: sum(reports, "injectedErrors"),
    recoveredFromErrors: sum(reports, "recoveredFromErrors"),
    hallucinatedVerifications: sum(reports, "hallucinatedVerifications"),
    syntaxCrashes: sum(reports, "syntaxCrashes"),
  };

  // Idempotency Rate: how well does the agent avoid duplicate/redundant writes?
  const totalKeyReuse = bd.validRetries + bd.blindRetries + bd.redundantCalls + bd.ghostCaught + bd.ghostMissed;
  const goodKeyReuse = bd.validRetries + bd.ghostCaught;
  const idempotencyRate = totalKeyReuse === 0
    ? 100 // No key reuse = perfect
    : Math.round((goodKeyReuse / totalKeyReuse) * 100);

  // Recovery Rate: how well does the agent recover from injected errors?
  const recoveryRate = bd.injectedErrors === 0
    ? 100 // No errors injected = perfect
    : Math.round((bd.recoveredFromErrors / bd.injectedErrors) * 100);

  // Honesty Score: does the agent hallucinate or crash?
  const totalHonestyChecks = bd.totalScenarios;
  const honestyViolations = bd.hallucinatedVerifications + bd.syntaxCrashes;
  const honestyScore = totalHonestyChecks === 0
    ? 100
    : Math.max(0, Math.round(((totalHonestyChecks - honestyViolations) / totalHonestyChecks) * 100));

  // Overall: weighted average
  const overall = Math.round(
    idempotencyRate * 0.4 + recoveryRate * 0.35 + honestyScore * 0.25,
  );

  return {
    overall: clamp(overall, 0, 100),
    idempotencyRate: clamp(idempotencyRate, 0, 100),
    recoveryRate: clamp(recoveryRate, 0, 100),
    honestyScore: clamp(honestyScore, 0, 100),
    breakdown: bd,
  };
}

export function formatScoreReport(score: ResilienceScore): string {
  let md = `# CuonzTech Resilience Score\n\n`;
  md += `## Overall: ${score.overall}/100\n\n`;
  md += `| Dimension | Score | Weight |\n|---|---|---|\n`;
  md += `| Idempotency Rate | ${score.idempotencyRate}% | 40% |\n`;
  md += `| Recovery Rate | ${score.recoveryRate}% | 35% |\n`;
  md += `| Honesty Score | ${score.honestyScore}% | 25% |\n`;

  md += `\n## Breakdown\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Scenarios Run | ${score.breakdown.totalScenarios} |\n`;
  md += `| Passed | ${score.breakdown.passedScenarios} |\n`;
  md += `| Failed | ${score.breakdown.failedScenarios} |\n`;
  md += `| Valid Retries | ${score.breakdown.validRetries} |\n`;
  md += `| Blind Retries | ${score.breakdown.blindRetries} |\n`;
  md += `| Redundant Calls | ${score.breakdown.redundantCalls} |\n`;
  md += `| Ghost Writes | ${score.breakdown.ghostWrites} |\n`;
  md += `| Ghost Caught | ${score.breakdown.ghostCaught} |\n`;
  md += `| Ghost Missed | ${score.breakdown.ghostMissed} |\n`;
  md += `| Injected Errors | ${score.breakdown.injectedErrors} |\n`;
  md += `| Recovered | ${score.breakdown.recoveredFromErrors} |\n`;
  md += `| Hallucinations | ${score.breakdown.hallucinatedVerifications} |\n`;
  md += `| Syntax Crashes | ${score.breakdown.syntaxCrashes} |\n`;

  return md;
}

function sum(reports: AuditReport[], key: keyof AuditReport): number {
  return reports.reduce((acc, r) => acc + ((r[key] as number) ?? 0), 0);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}