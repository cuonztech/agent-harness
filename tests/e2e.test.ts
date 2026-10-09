import { describe, it, expect, beforeEach } from "vitest";
import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
} from "../src/tools/handlers.js";
import { listSessions, deleteSession } from "../src/core/state-engine.js";

function parseJSON(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("End-to-End: Agent plays through F1–F5", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  it("F1 — Agent retries after timeout with read-verify (PASS → GHOST_CAUGHT)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F1" }));
    const sid = sess.sessionId;

    // Call 1: write → triggers timeout, but the simulated upstream actually
    // executed the write (ghost-write) — upstreamExecuted is now tracked.
    const call1 = handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 100 },
      idempotency_key: "idem-f1-001",
    });
    expect(parseJSON(call1).injectedError).toContain("TIMEOUT");
    expect(call1.isError).toBe(true);

    // Call 2: read to verify state before retry
    const call2 = handleExecuteCall({
      session_id: sid,
      tool_name: "read_payment_status",
      arguments: { transaction_ref: "idem-f1-001" },
    });
    expect(parseJSON(call2).injectedError).toBeNull();
    expect(call2.isError).toBe(false);

    // Call 3: retry write with same idempotency key
    const call3 = handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 100 },
      idempotency_key: "idem-f1-001",
    });
    expect(parseJSON(call3).injectedError).toBeNull();
    expect(call3.isError).toBe(false);

    // Report: agent correctly detected the ghost-write via read-before-retry → PASS
    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.verdict).toBe("PASS");
    expect(report.totalCalls).toBe(3);
    expect(report.injectedErrors).toBe(1);
    expect(report.upstreamCalls).toBe(1);
    expect(report.ghostWriteDetections).toBe(1);
    expect(report.ghostWriteMisses).toBe(0);
    expect(report.keySummary[0].classification).toBe("GHOST_CAUGHT");
    expect(report.keySummary[0].readBeforeRetry).toBe(true);
    expect(report.keySummary[0].ghostCommitted).toBe(true);
  });

  it("F1 — Agent blind-retries without read (FAIL → GHOST_MISSED)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F1" }));
    const sid = sess.sessionId;

    // Call 1: write → timeout (ghost-write: upstream actually executed)
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 100 },
      idempotency_key: "idem-f1-blind",
    });

    // Call 2: immediate write retry without read
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 100 },
      idempotency_key: "idem-f1-blind",
    });

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.ghostWriteMisses).toBe(1);
    expect(report.ghostWriteDetections).toBe(0);
    expect(report.keySummary[0].classification).toBe("GHOST_MISSED");
    expect(report.keySummary[0].readBeforeRetry).toBe(false);
    expect(report.keySummary[0].ghostCommitted).toBe(true);
    expect(report.violations.some((v: { type: string }) => v.type === "GHOST_MISSED")).toBe(true);
  });

  it("F3 — Agent handles malformed JSON gracefully (PASS)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F3" }));
    const sid = sess.sessionId;

    // Call 1: malformed JSON
    const call1 = handleExecuteCall({
      session_id: sid,
      tool_name: "execute_query",
      arguments: { query: "SELECT 1" },
    });
    expect(parseJSON(call1).injectedError).toContain("MALFORMED");

    // Call 2: agent retries (no SyntaxError crash)
    const call2 = handleExecuteCall({
      session_id: sid,
      tool_name: "execute_query",
      arguments: { query: "SELECT 1", retry: true },
    });
    expect(parseJSON(call2).injectedError).toBeNull();

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.syntaxCrashes).toBe(0);
    expect(report.injectedErrors).toBe(1);
  });

  it("F4 — Redundant call after committed success (FAIL → REDUNDANT_CALL)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F4" }));
    const sid = sess.sessionId;

    // Call 1: write → success
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_order",
      arguments: { item: "widget", qty: 5 },
      idempotency_key: "idem-f4-dup",
    });

    // Call 2: same write, same key, no error before → REDUNDANT
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_order",
      arguments: { item: "widget", qty: 5 },
      idempotency_key: "idem-f4-dup",
    });

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.redundantCalls).toBe(1);
    expect(report.validRetries).toBe(0);
    expect(report.keySummary[0].classification).toBe("REDUNDANT_CALL");
    expect(report.violations.some((v: { type: string }) => v.type === "REDUNDANT_CALL")).toBe(true);
  });

  it("F5 — Agent retries once after 500 with read-verify (PASS → VALID_RETRY)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F5" }));
    const sid = sess.sessionId;

    // Call 1: 500 error
    const call1 = handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 50 },
      idempotency_key: "idem-f5-001",
    });
    expect(call1.isError).toBe(true);

    // Call 2: read to verify
    handleExecuteCall({
      session_id: sid,
      tool_name: "read_payment_status",
      arguments: { ref: "idem-f5-001" },
    });

    // Call 3: retry with same key → success
    const call3 = handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 50 },
      idempotency_key: "idem-f5-001",
    });
    expect(call3.isError).toBe(false);

    // Call 4: read to verify success
    handleExecuteCall({
      session_id: sid,
      tool_name: "read_payment_status",
      arguments: { ref: "idem-f5-001" },
    });

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.totalCalls).toBe(4);
    expect(report.injectedErrors).toBe(1);
    expect(report.validRetries).toBe(1);
    expect(report.blindRetries).toBe(0);
    expect(report.redundantCalls).toBe(0);
    expect(report.keySummary[0].classification).toBe("VALID_RETRY");
    expect(report.keySummary[0].readBeforeRetry).toBe(true);
    expect(report.verdict).toBe("PASS");
  });

  it("F5 — Agent retries without read-verify (FAIL → BLIND_RETRY)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F5" }));
    const sid = sess.sessionId;

    // Call 1: 500 error
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 50 },
      idempotency_key: "idem-f5-blind",
    });

    // Call 2: immediate retry without read
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 50 },
      idempotency_key: "idem-f5-blind",
    });

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.verdict).toBe("FAIL");
    expect(report.blindRetries).toBe(1);
    expect(report.keySummary[0].classification).toBe("BLIND_RETRY");
  });

  it("F2 — Rate limit hit, agent waits and retries (PASS)", async () => {
    const sess = parseJSON(handleStartSession({ scenario_id: "F2" }));
    const sid = sess.sessionId;

    // Call 1: success
    handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 10 },
      idempotency_key: "idem-f2-001",
    });

    // Call 2: rate-limited (429)
    const call2 = handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 10 },
      idempotency_key: "idem-f2-001",
    });
    expect(call2.isError).toBe(true);
    expect(parseJSON(call2).injectedError).toContain("RATE_LIMIT");

    // Call 3: read after rate-limit
    handleExecuteCall({
      session_id: sid,
      tool_name: "read_status",
      arguments: {},
    });

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.injectedErrors).toBe(1);
    expect(report.totalCalls).toBe(3);
  });

  it("Chaos mode — stochastic error injection works", async () => {
    const sess = parseJSON(
      handleStartSession({ mode: "chaos", error_rate: 1.0 }),
    );
    const sid = sess.sessionId;

    const call1 = handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 100 },
    });
    expect(call1.isError).toBe(true);
    expect(parseJSON(call1).injectedError).toContain("CHAOS");
  });

  it("Multiple sessions are fully isolated", async () => {
    const s1 = parseJSON(handleStartSession({ scenario_id: "F1" }));
    const s2 = parseJSON(handleStartSession({ scenario_id: "F3" }));

    // F1 session: call 1 gets timeout
    const c1 = handleExecuteCall({
      session_id: s1.sessionId,
      tool_name: "write_x",
      arguments: {},
      idempotency_key: "iso-test-1",
    });
    expect(parseJSON(c1).injectedError).toContain("TIMEOUT");

    // F3 session: call 1 gets malformed JSON
    const c2 = handleExecuteCall({
      session_id: s2.sessionId,
      tool_name: "execute_q",
      arguments: {},
    });
    expect(parseJSON(c2).injectedError).toContain("MALFORMED");

    // Reports are independent
    const r1 = parseJSON(await handleGetReport({ session_id: s1.sessionId, format: "json" }));
    const r2 = parseJSON(await handleGetReport({ session_id: s2.sessionId, format: "json" }));
    expect(r1.scenarioId).toBe("F1");
    expect(r2.scenarioId).toBe("F3");
    expect(r1.totalCalls).toBe(1);
    expect(r2.totalCalls).toBe(1);
  });

  it("No idempotency key → no key-based classification", async () => {
    const sess = parseJSON(handleStartSession({}));
    const sid = sess.sessionId;

    handleExecuteCall({
      session_id: sid,
      tool_name: "write_payment",
      arguments: { amount: 100 },
      // No idempotency_key
    });

    const report = parseJSON(await handleGetReport({ session_id: sid, format: "json" }));
    expect(report.keySummary).toHaveLength(0);
    expect(report.verdict).toBe("PASS");
  });
});