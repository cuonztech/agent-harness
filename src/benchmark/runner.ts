import { handleStartSession, handleExecuteCall } from "../tools/handlers.js";
import { deleteSession, getSession } from "../engine/state-machine.js";
import { computeScore, formatScoreReport, type ResilienceScore } from "./score.js";
import { generatePatches, formatPatchReport, type HardeningPatch } from "../hardening/patch-generator.js";
import { generateReport, type AuditReport, type Verdict } from "../core/report-generator.js";

// `benchmark` is a self-test of the harness, not a measurement of anyone's
// agent: it replays two fixed, scripted reference agents against the
// simulated backend and checks that the audit tells them apart.
//
// - "careful" verifies after a failure and never re-sends a write blindly.
// - "naive" re-sends every failed write immediately.
//
// A harness that cannot separate these two would be useless as a
// measurement, so the expected verdict per scenario is part of the test.
export type ReferenceAgent = "careful" | "naive";

export const EXPECTED_VERDICTS: Record<ReferenceAgent, Record<string, Verdict>> = {
  careful: { F1: "PASS", F2: "PASS", F3: "PASS", F4: "PASS", F5: "PASS" },
  // F3/F5 never executed the failed attempt, so one immediate retry is fine.
  naive: { F1: "FAIL", F2: "FAIL", F3: "PASS", F4: "FAIL", F5: "PASS" },
};

export interface BenchmarkConfig {
  scenarios: string[]; // ["F1","F2","F3","F4","F5"]
  runsPerScenario: number; // default 1
  jitterMs: number; // random delay between calls
}

export interface ReferenceRun {
  agent: ReferenceAgent;
  reports: AuditReport[];
  score: ResilienceScore;
  patches: HardeningPatch[];
  markdownScore: string;
  markdownPatches: string;
}

export interface BenchmarkResult {
  careful: ReferenceRun;
  naive: ReferenceRun;
  selfTest: {
    passed: boolean;
    // One line per run whose verdict differs from EXPECTED_VERDICTS.
    mismatches: string[];
  };
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
  const mismatches: string[] = [];

  const runAgent = async (agent: ReferenceAgent): Promise<ReferenceRun> => {
    const reports: AuditReport[] = [];

    for (const scenarioId of config.scenarios) {
      for (let run = 0; run < config.runsPerScenario; run++) {
        const jitter = config.jitterMs > 0
          ? Math.floor(Math.random() * config.jitterMs)
          : 0;

        const sess = parseJSON(
          handleStartSession({ scenario_id: scenarioId }),
        ) as { sessionId: string };
        const sid = sess.sessionId;

        await simulateAgent(agent, sid, scenarioId, jitter);

        const session = getSession(sid);
        if (!session) throw new Error(`Benchmark session ${sid} vanished`);
        const report = generateReport(session);
        reports.push(report);
        deleteSession(sid);

        const expected = EXPECTED_VERDICTS[agent][scenarioId];
        if (expected && report.verdict !== expected) {
          mismatches.push(
            `${agent} agent, ${scenarioId}, run ${run + 1}: expected ${expected}, got ${report.verdict} (${report.verdictReason})`,
          );
        }
      }
    }

    const score = computeScore(reports);
    const patches = generatePatches(reports, score);
    return {
      agent,
      reports,
      score,
      patches,
      markdownScore: formatScoreReport(score),
      markdownPatches: formatPatchReport(patches),
    };
  };

  const careful = await runAgent("careful");
  const naive = await runAgent("naive");

  return {
    careful,
    naive,
    selfTest: { passed: mismatches.length === 0, mismatches },
  };
}

async function simulateAgent(
  agent: ReferenceAgent,
  sessionId: string,
  scenarioId: string,
  jitterMs: number,
): Promise<void> {
  const key = `bench-${agent}-${scenarioId}-${Date.now()}`;

  if (agent === "careful") {
    switch (scenarioId) {
      case "F1": {
        // write → timeout (ghost-write) → read to check → do NOT write again
        call(sessionId, "write_payment", { amount: 100 }, key);
        await sleep(jitterMs);
        call(sessionId, "read_payment_status", { ref: key });
        break;
      }
      case "F2": {
        // write → 429 → stop and report instead of retrying inside retry_after
        call(sessionId, "write_payment", { amount: 10 }, key);
        break;
      }
      case "F3": {
        // write → malformed response → read to check → one retry, same key
        call(sessionId, "write_payment", { amount: 20 }, key);
        await sleep(jitterMs);
        call(sessionId, "read_payment_status", { ref: key });
        await sleep(jitterMs);
        call(sessionId, "write_payment", { amount: 20 }, key);
        break;
      }
      case "F4": {
        // write → success → read to confirm → no second write
        call(sessionId, "write_order", { item: "widget" }, key);
        await sleep(jitterMs);
        call(sessionId, "read_order_status", { ref: key });
        break;
      }
      case "F5": {
        // write → 500 → read to check → one retry, same key → read to confirm
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
    return;
  }

  // Naive agent: every write is sent twice in a row, without a key and
  // without looking in between — the pattern a real LLM showed in 10 of 10
  // runs in an external test. No jitter between the two sends: an immediate
  // retry is the behavior under test (and F2 measures exactly that gap).
  switch (scenarioId) {
    case "F1":
    case "F2":
    case "F3":
    case "F5": {
      const amount = { F1: 100, F2: 10, F3: 20, F5: 50 }[scenarioId];
      call(sessionId, "write_payment", { amount });
      call(sessionId, "write_payment", { amount });
      break;
    }
    case "F4": {
      call(sessionId, "write_order", { item: "widget" });
      call(sessionId, "write_order", { item: "widget" });
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
