import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
} from "../tools/handlers.js";
import { deleteSession, listSessions } from "../engine/state-machine.js";
import { computeScore, formatScoreReport, type ResilienceScore } from "./score.js";
import { generatePatches, formatPatchReport, type HardeningPatch } from "../hardening/patch-generator.js";
import type { AuditReport } from "../core/report-generator.js";

export interface BenchmarkConfig {
  scenarios: string[]; // ["F1","F2","F3","F4","F5"]
  runsPerScenario: number; // default 1
  jitterMs: number; // random delay between calls
}

export interface BenchmarkResult {
  reports: AuditReport[];
  score: ResilienceScore;
  patches: HardeningPatch[];
  markdownReport: string;
  markdownScore: string;
  markdownPatches: string;
}

export function defaultConfig(): BenchmarkConfig {
  return {
    scenarios: ["F1", "F2", "F3", "F4", "F5"],
    runsPerScenario: 1,
    jitterMs: 0,
  };
}

function parseJSON(result: { content: Array<{ text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBenchmark(
  config: BenchmarkConfig = defaultConfig(),
): Promise<BenchmarkResult> {
  const reports: AuditReport[] = [];

  for (const scenarioId of config.scenarios) {
    for (let run = 0; run < config.runsPerScenario; run++) {
      // Clean up previous sessions
      for (const s of listSessions()) deleteSession(s.sessionId);

      const jitter = config.jitterMs > 0
        ? Math.floor(Math.random() * config.jitterMs)
        : 0;

      // Start session
      const sess = parseJSON(
        handleStartSession({ scenario_id: scenarioId }),
      ) as { sessionId: string };
      const sid = sess.sessionId;

      // Run scenario-specific agent simulation
      await simulateAgent(sid, scenarioId, jitter);

      // Get report
      const report = parseJSON(
        await handleGetReport({ session_id: sid, format: "json" }),
      ) as AuditReport;
      reports.push(report);
    }
  }

  const score = computeScore(reports);
  const patches = generatePatches(reports, score);

  return {
    reports,
    score,
    patches,
    markdownReport: reports
      .map((r, i) => `## Run ${i + 1}: ${r.scenarioId ?? "ad-hoc"}\n\n${formatSingleReport(r)}`)
      .join("\n\n---\n\n"),
    markdownScore: formatScoreReport(score),
    markdownPatches: formatPatchReport(patches),
  };
}

async function simulateAgent(
  sessionId: string,
  scenarioId: string,
  jitterMs: number,
): Promise<void> {
  const key = `bench-${scenarioId}-${Date.now()}`;

  switch (scenarioId) {
    case "F1": {
      // F1: write → timeout → read → retry with same key
      call(sessionId, "write_payment", { amount: 100 }, key);
      await sleep(jitterMs);
      call(sessionId, "read_payment_status", { ref: key });
      await sleep(jitterMs);
      call(sessionId, "write_payment", { amount: 100 }, key);
      break;
    }
    case "F2": {
      // F2: write → success → write → 429 → read → wait
      call(sessionId, "write_payment", { amount: 10 }, key);
      await sleep(jitterMs);
      call(sessionId, "write_payment", { amount: 10 }, key);
      await sleep(jitterMs);
      call(sessionId, "read_status", {});
      break;
    }
    case "F3": {
      // F3: malformed JSON → retry
      call(sessionId, "execute_query", { query: "SELECT 1" });
      await sleep(jitterMs);
      call(sessionId, "execute_query", { query: "SELECT 1", retry: true });
      break;
    }
    case "F4": {
      // F4: duplicate write with same key (bad agent)
      call(sessionId, "write_order", { item: "widget" }, key);
      await sleep(jitterMs);
      call(sessionId, "write_order", { item: "widget" }, key);
      break;
    }
    case "F5": {
      // F5: 500 → read → retry → read
      call(sessionId, "write_payment", { amount: 50 }, key);
      await sleep(jitterMs);
      call(sessionId, "read_payment_status", { ref: key });
      await sleep(jitterMs);
      call(sessionId, "write_payment", { amount: 50 }, key);
      await sleep(jitterMs);
      call(sessionId, "read_payment_status", { ref: key });
      break;
    }
  }
}

function call(
  sessionId: string,
  toolName: string,
  args: Record<string, unknown>,
  idempotencyKey?: string,
): void {
  handleExecuteCall({
    session_id: sessionId,
    tool_name: toolName,
    arguments: args,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
}

function formatSingleReport(r: AuditReport): string {
  let md = `| Metric | Value |\n|---|---|\n`;
  md += `| Verdict | ${r.verdict} |\n`;
  md += `| Total Calls | ${r.totalCalls} |\n`;
  md += `| Injected Errors | ${r.injectedErrors} |\n`;
  md += `| Valid Retries | ${r.validRetries} |\n`;
  md += `| Blind Retries | ${r.blindRetries} |\n`;
  md += `| Redundant Calls | ${r.redundantCalls} |\n`;
  md += `| Ghost Writes | ${r.ghostWrites} |\n`;
  return md;
}