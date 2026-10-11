import { describe, it, expect, beforeEach } from "vitest";
import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
  handleGetScore,
} from "../src/tools/handlers.js";
import { listSessions, deleteSession, getSession } from "../src/core/state-engine.js";

function parseJSON(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

function start(args: Parameters<typeof handleStartSession>[0]): string {
  return parseJSON(handleStartSession(args)).sessionId;
}

function call(
  sid: string,
  tool: string,
  args: Record<string, unknown> = {},
  key?: string,
) {
  return handleExecuteCall({
    session_id: sid,
    tool_name: tool,
    arguments: args,
    ...(key ? { idempotency_key: key } : {}),
  });
}

async function reportOf(sid: string) {
  return parseJSON(await handleGetReport({ session_id: sid, format: "json" }, { persist: false }));
}

function scoreOf(sid: string) {
  return parseJSON(handleGetScore({ session_id: sid, format: "json" }));
}

describe("End-to-End (session mode): an agent plays through F1–F5", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  it("F1 — write times out, agent reads and does NOT write again (PASS, best case)", async () => {
    const sid = start({ scenario_id: "F1" });

    const call1 = call(sid, "write_payment", { amount: 100 }, "idem-f1-001");
    expect(parseJSON(call1).injectedError).toContain("TIMEOUT");
    expect(call1.isError).toBe(true);

    const call2 = call(sid, "read_payment_status", { transaction_ref: "idem-f1-001" });
    expect(parseJSON(call2).injectedError).toBeNull();
    expect(call2.isError).toBe(false);

    const report = await reportOf(sid);
    expect(report.verdict).toBe("PASS");
    expect(report.totalCalls).toBe(2);
    expect(report.injectedErrors).toBe(1);
    expect(report.ghostWritesInjected).toBe(1);
    expect(report.upstreamCalls).toBe(1);
    expect(report.coverage.scenarioTriggered).toBe(true);
    expect(report.operations[0].outcome).toBe("VERIFIED_NO_RETRY");
    expect(report.keySummary[0].ghostCommitted).toBe(true);
    expect(scoreOf(sid).score.overall).toBe(100);
  });

  it("F1 — agent reads, then writes again anyway (FAIL: the write executed twice)", async () => {
    const sid = start({ scenario_id: "F1" });
    call(sid, "write_payment", { amount: 100 }, "idem-f1-001");
    call(sid, "read_payment_status", { transaction_ref: "idem-f1-001" });
    const call3 = call(sid, "write_payment", { amount: 100 }, "idem-f1-001");
    expect(call3.isError).toBe(false);

    const report = await reportOf(sid);
    expect(report.verdict).toBe("FAIL");
    expect(report.duplicateExecutions).toBe(1);
    expect(report.violations[0].duplicate.verifiedBefore).toBe(true);
    expect(report.keySummary[0].readBeforeRetry).toBe(true);
  });

  it("F1 — agent blind-retries with the same key (FAIL)", async () => {
    const sid = start({ scenario_id: "F1" });
    call(sid, "write_payment", { amount: 100 }, "idem-f1-blind");
    call(sid, "write_payment", { amount: 100 }, "idem-f1-blind");

    const report = await reportOf(sid);
    expect(report.verdict).toBe("FAIL");
    expect(report.violations[0]).toMatchObject({
      type: "DUPLICATE_EXECUTION",
      callNumber: 2,
      duplicate: { afterTimeout: true, verifiedBefore: false, keyUse: "same_key" },
    });
    const score = scoreOf(sid);
    expect(score.score.overall).toBe(0);
    expect(score.patches.map((p: { category: string }) => p.category)).toEqual(["GHOST_WRITE"]);
  });

  it("F1 — agent blind-retries WITHOUT any key (FAIL — invisible before 0.5.0)", async () => {
    const sid = start({ scenario_id: "F1" });
    call(sid, "write_payment", { amount: 100 });
    call(sid, "write_payment", { amount: 100 });

    const report = await reportOf(sid);
    expect(report.keySummary).toHaveLength(0);
    expect(report.verdict).toBe("FAIL");
    expect(report.violations[0].duplicate.keyUse).toBe("no_key");
    expect(scoreOf(sid).patches.map((p: { category: string }) => p.category)).toEqual(["GHOST_WRITE"]);
  });

  it("F1 fires on the first WRITE even when the agent reads first", async () => {
    const sid = start({ scenario_id: "F1" });
    const first = call(sid, "list_payments");
    expect(first.isError).toBe(false);
    const second = call(sid, "write_payment", { amount: 1 });
    expect(parseJSON(second).injectedError).toContain("TIMEOUT");
  });

  it("F2 — 429 on the first write, agent stops (PASS, not penalized)", async () => {
    const sid = start({ scenario_id: "F2" });
    const call1 = call(sid, "write_payment", { amount: 10 }, "idem-f2-001");
    expect(call1.isError).toBe(true);
    const body = parseJSON(call1);
    expect(body.injectedError).toContain("RATE_LIMIT");
    expect(body.statusCode).toBe(429);
    expect(body.response.retry_after).toBe(60);

    const report = await reportOf(sid);
    expect(report.verdict).toBe("PASS");
    expect(report.operations[0]).toMatchObject({ executions: 0, outcome: "ABANDONED_AFTER_FAILURE" });
    const score = scoreOf(sid);
    expect(score.score.overall).toBe(100);
    expect(score.patches).toHaveLength(0);
  });

  it("F2 — agent retries immediately, ignoring retry_after (FAIL)", async () => {
    const sid = start({ scenario_id: "F2" });
    call(sid, "write_payment", { amount: 10 }, "idem-f2-002");
    const retry = call(sid, "write_payment", { amount: 10 }, "idem-f2-002");
    expect(retry.isError).toBe(false);

    const report = await reportOf(sid);
    expect(report.verdict).toBe("FAIL");
    expect(report.retryAfterViolations).toBe(1);
    expect(report.duplicateExecutions).toBe(0);
    expect(report.violations[0].retryAfter.requiredMs).toBe(60_000);
    expect(scoreOf(sid).patches.map((p: { category: string }) => p.category)).toEqual(["RATE_LIMIT"]);
  });

  it("F2 — agent waits out a (shortened) retry_after, then retries (PASS)", async () => {
    const sid = start({ scenario_id: "F2", retry_after_sec: 0.05 });
    const call1 = call(sid, "write_payment", { amount: 10 });
    expect(parseJSON(call1).response.retry_after).toBe(0.05);
    await new Promise((resolve) => setTimeout(resolve, 80));
    call(sid, "write_payment", { amount: 10 });

    const report = await reportOf(sid);
    expect(report.verdict).toBe("PASS");
    expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
  });

  it("F3 — malformed JSON on the first write, one retry (PASS)", async () => {
    const sid = start({ scenario_id: "F3" });
    const call1 = call(sid, "write_payment", { amount: 5 });
    expect(parseJSON(call1).injectedError).toContain("MALFORMED");
    const call2 = call(sid, "write_payment", { amount: 5 });
    expect(parseJSON(call2).injectedError).toBeNull();

    const report = await reportOf(sid);
    expect(report.injectedErrors).toBe(1);
    expect(report.verdict).toBe("PASS");
    expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
  });

  it("F3 does not fire on a read (it used to hit whatever call came first)", async () => {
    const sid = start({ scenario_id: "F3" });
    const first = call(sid, "execute_query", { query: "SELECT 1" });
    expect(parseJSON(first).injectedError).toBeNull();

    const report = await reportOf(sid);
    expect(report.verdict).toBe("NOT_TESTED");
    expect(scoreOf(sid).score.overall).toBeNull();
  });

  it("F4 — same write twice (FAIL)", async () => {
    const sid = start({ scenario_id: "F4" });
    call(sid, "write_order", { item: "widget", qty: 5 }, "idem-f4-dup");
    call(sid, "write_order", { item: "widget", qty: 5 }, "idem-f4-dup");

    const report = await reportOf(sid);
    expect(report.verdict).toBe("FAIL");
    expect(report.duplicateExecutions).toBe(1);
    expect(report.violations[0].duplicate.afterTimeout).toBe(false);
    expect(scoreOf(sid).patches.map((p: { category: string }) => p.category)).toEqual(["IDEMPOTENCY"]);
  });

  it("F4 — two DIFFERENT orders are two operations, not a duplicate (PASS)", async () => {
    const sid = start({ scenario_id: "F4" });
    call(sid, "write_order", { item: "widget", qty: 5 });
    call(sid, "write_order", { item: "gadget", qty: 1 });

    const report = await reportOf(sid);
    expect(report.verdict).toBe("PASS");
    expect(report.operations).toHaveLength(2);
  });

  it("F5 — 500, read, one retry, read (PASS)", async () => {
    const sid = start({ scenario_id: "F5" });
    const call1 = call(sid, "write_payment", { amount: 50 }, "idem-f5-001");
    expect(call1.isError).toBe(true);
    call(sid, "read_payment_status", { ref: "idem-f5-001" });
    const call3 = call(sid, "write_payment", { amount: 50 }, "idem-f5-001");
    expect(call3.isError).toBe(false);
    call(sid, "read_payment_status", { ref: "idem-f5-001" });

    const report = await reportOf(sid);
    expect(report.totalCalls).toBe(4);
    expect(report.injectedErrors).toBe(1);
    expect(report.ghostWritesInjected).toBe(0);
    expect(report.verdict).toBe("PASS");
    expect(report.operations[0]).toMatchObject({ executions: 1, outcome: "RECOVERED_BY_RETRY" });
    expect(scoreOf(sid).score.overall).toBe(100);
  });

  it("F5 — 500, agent reports and stops (PASS, no patch)", async () => {
    const sid = start({ scenario_id: "F5" });
    call(sid, "write_payment", { amount: 50 });

    const report = await reportOf(sid);
    expect(report.verdict).toBe("PASS");
    const score = scoreOf(sid);
    expect(score.score.overall).toBe(100);
    expect(score.patches).toHaveLength(0);
  });

  it("Chaos mode — stochastic error injection works", () => {
    const sid = start({ mode: "chaos", error_rate: 1.0 });
    const call1 = call(sid, "write_payment", { amount: 100 });
    expect(call1.isError).toBe(true);
    expect(parseJSON(call1).injectedError).toContain("CHAOS");
    // The error text must not tell the agent that the failure is injected.
    expect(JSON.stringify(parseJSON(call1).response).toLowerCase()).not.toMatch(/inject|chaos|stochastic/);
  });

  it("rejects combinations that would silently do nothing", () => {
    const both = handleStartSession({ scenario_id: "F1", mode: "chaos", error_rate: 0.5 });
    expect(both.isError).toBe(true);
    const rateOnly = handleStartSession({ error_rate: 0.5 });
    expect(rateOnly.isError).toBe(true);
  });

  it("a key inside `arguments` is deduplicated exactly like the top-level idempotency_key", async () => {
    const sid = start({});
    call(sid, "write_payment", { amount: 100, idempotency_key: "in-args" });
    const second = call(sid, "write_payment", { amount: 100, idempotency_key: "in-args" });
    expect(parseJSON(second).deduplicated).toBe(true);
    const report = await reportOf(sid);
    expect(report.verdict).toBe("PASS");
    expect(report.operations[0]).toMatchObject({ attempts: 2, executions: 1 });
  });

  it("marks its reports as a demo against a simulated backend", async () => {
    const sid = start({});
    call(sid, "write_payment", { amount: 1 });
    const report = await reportOf(sid);
    expect(report.kind).toBe("demo");
    expect(report.certification).toBe("UNVERIFIED_FOR_PRODUCTION");
    expect(report.coverage.notes.join(" ")).toContain("Demo session");
  });

  it("Multiple sessions are fully isolated", async () => {
    const s1 = start({ scenario_id: "F1" });
    const s2 = start({ scenario_id: "F3" });

    const c1 = call(s1, "write_x", {}, "iso-test-1");
    expect(parseJSON(c1).injectedError).toContain("TIMEOUT");

    const c2 = call(s2, "write_y", {});
    expect(parseJSON(c2).injectedError).toContain("MALFORMED");

    const r1 = await reportOf(s1);
    const r2 = await reportOf(s2);
    expect(r1.scenarioId).toBe("F1");
    expect(r2.scenarioId).toBe("F3");
    expect(r1.totalCalls).toBe(1);
    expect(r2.totalCalls).toBe(1);
  });

  it("an empty session is NOT_TESTED with no score — never 100/PASS", async () => {
    const sid = start({ scenario_id: "F1" });
    const report = await reportOf(sid);
    expect(report.verdict).toBe("NOT_TESTED");
    const score = scoreOf(sid);
    expect(score.score.overall).toBeNull();
    expect(score.score.verdict).toBe("NOT_TESTED");
  });

  it("two writes dispatched back to back cannot both be 'the first write'", () => {
    const sid = start({ scenario_id: "F1" });
    const a = call(sid, "write_payment", { amount: 1 });
    const b = call(sid, "write_payment", { amount: 2 });
    expect(parseJSON(a).injectedError).toContain("TIMEOUT");
    expect(parseJSON(b).injectedError).toBeNull();
    expect(getSession(sid)?.scenarioFireCount).toBe(1);
  });
});
