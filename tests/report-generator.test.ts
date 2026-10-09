import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  markGhostCommitted,
  deleteSession,
  listSessions,
  type CallRecord,
} from "../src/core/state-engine.js";
import { generateReport, formatMarkdown } from "../src/core/report-generator.js";

describe("ReportGenerator", () => {
  beforeEach(() => {
    for (const s of listSessions()) {
      deleteSession(s.sessionId);
    }
  });

  it("generates PASS report for clean single-write session", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-001", amount: 100 },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: Date.now(),
    });

    const report = generateReport(session);
    expect(report.verdict).toBe("PASS");
    expect(report.totalCalls).toBe(1);
    expect(report.validRetries).toBe(0);
    expect(report.blindRetries).toBe(0);
    expect(report.redundantCalls).toBe(0);
    expect(report.ghostWrites).toBe(0);
    expect(report.keySummary).toHaveLength(1);
    expect(report.keySummary[0].classification).toBe("INITIAL");
  });

  it("an unresolved ghost-write (one write call, no retry yet) is PASS but visible as GHOST_WRITE in keySummary", () => {
    // The agent hasn't done anything wrong yet — it made one write, got a
    // timeout, and the report was pulled before it had a chance to verify or
    // retry. This must not fail the verdict (nothing to blame the agent for
    // yet); it's informational only. Only a later blind/caught retry turns
    // this into a real BLIND_RETRY/GHOST_MISSED (FAIL) or GHOST_CAUGHT (PASS).
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-ghost-unresolved" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      upstreamExecuted: true,
      timestamp: Date.now(),
    });
    markGhostCommitted(session.sessionId, "key-ghost-unresolved");

    const report = generateReport(session);
    expect(report.verdict).toBe("PASS");
    expect(report.ghostWrites).toBe(0);
    expect(report.ghostWriteDetections).toBe(0);
    expect(report.ghostWriteMisses).toBe(0);
    expect(report.keySummary[0].classification).toBe("GHOST_WRITE");
    expect(report.keySummary[0].ghostCommitted).toBe(true);
  });

  it("classifies VALID_RETRY: same key after error with read-verify", () => {
    const session = createSession();
    // Call 1: write → error
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-vr" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      timestamp: 1000,
    });
    // Call 2: read between error and retry
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "read_payment_status",
      args: { idempotency_key: "key-vr" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 2000,
    });
    // Call 3: retry write with same key
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 3,
      toolName: "write_payment",
      args: { idempotency_key: "key-vr" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 3000,
    });

    const report = generateReport(session);
    expect(report.verdict).toBe("PASS");
    expect(report.validRetries).toBe(1);
    expect(report.blindRetries).toBe(0);
    expect(report.redundantCalls).toBe(0);
    expect(report.keySummary[0].classification).toBe("VALID_RETRY");
    expect(report.keySummary[0].readBeforeRetry).toBe(true);
    // VALID_RETRY should NOT appear as a critical violation
    expect(report.violations.filter((v) => v.type === "BLIND_RETRY" || v.type === "REDUNDANT_CALL" || v.type === "GHOST_WRITE")).toHaveLength(0);
    // The failed call 1 was genuinely resolved by the successful retry (call 3).
    expect(report.recoveredFromErrors).toBe(1);
  });

  it("recoveredFromErrors does not count a response that merely lacks the string '\"error\"' (e.g. malformed JSON) without an actual later success", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "execute_query",
      args: {},
      injectedError: "[MALFORMED]",
      response: '{"result": "ok", "data": {broken',
      timestamp: Date.now(),
    });

    const report = generateReport(session);
    expect(report.recoveredFromErrors).toBe(0);
  });

  it("classifies BLIND_RETRY: same key after error WITHOUT read-verify", () => {
    const session = createSession();
    // Call 1: write → error
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-br" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      timestamp: 1000,
    });
    // Call 2: immediate retry write, no read between
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "write_payment",
      args: { idempotency_key: "key-br" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 2000,
    });

    const report = generateReport(session);
    expect(report.verdict).toBe("FAIL");
    expect(report.blindRetries).toBe(1);
    expect(report.validRetries).toBe(0);
    expect(report.keySummary[0].classification).toBe("BLIND_RETRY");
    expect(report.keySummary[0].readBeforeRetry).toBe(false);
    expect(report.violations.some((v) => v.type === "BLIND_RETRY")).toBe(true);
  });

  it("classifies REDUNDANT_CALL: same key after already committed success", () => {
    const session = createSession();
    // Call 1: write → success
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-rc" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 1000,
    });
    // Call 2: same write again, no error before
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "write_payment",
      args: { idempotency_key: "key-rc" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 2000,
    });

    const report = generateReport(session);
    expect(report.verdict).toBe("FAIL");
    expect(report.redundantCalls).toBe(1);
    expect(report.validRetries).toBe(0);
    expect(report.keySummary[0].classification).toBe("REDUNDANT_CALL");
    expect(report.violations.some((v) => v.type === "REDUNDANT_CALL")).toBe(true);
  });

  it("classifies REDUNDANT_CALL (not GHOST_WRITE) when a needless re-write of an already-committed key itself comes back with an error", () => {
    // Mirrors the F2 (rate-limit) benchmark scenario: the first write for a
    // key commits cleanly, then the agent needlessly re-issues the SAME
    // write and THAT re-issue gets rate-limited. No ghost-write occurred
    // anywhere (ghostCommitted stays false) — this must get the same
    // REDUNDANT_CALL label and idempotency-rate penalty as a re-issue that
    // happens to come back "success", not the GHOST_WRITE label (which
    // previously made this un-penalized, since GHOST_WRITE isn't counted in
    // the idempotency-rate denominator).
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-rc-err" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 1000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "write_payment",
      args: { idempotency_key: "key-rc-err" },
      injectedError: "[RATE_LIMIT]",
      response: '{"error":"rate limited"}',
      timestamp: 2000,
    });

    const report = generateReport(session);
    expect(report.keySummary[0].classification).toBe("REDUNDANT_CALL");
    expect(report.redundantCalls).toBe(1);
    expect(report.ghostWrites).toBe(0);
    expect(report.violations.some((v) => v.type === "REDUNDANT_CALL")).toBe(true);
    expect(report.violations.some((v) => v.type === "GHOST_WRITE")).toBe(false);
  });

  it("detects syntax crash on malformed JSON", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "execute_call",
      args: {},
      injectedError: "[MALFORMED]",
      response: "SyntaxError: Unexpected token",
      timestamp: Date.now(),
    });

    const report = generateReport(session);
    expect(report.syntaxCrashes).toBe(1);
    expect(report.violations.some((v) => v.type === "SYNTAX_CRASH")).toBe(true);
  });

  it("formats markdown report with new fields", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-md" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: Date.now(),
    });

    const report = generateReport(session);
    const md = formatMarkdown(report);
    expect(md).toContain("# Agent Audit Report");
    expect(md).toContain("Valid Retries");
    expect(md).toContain("Blind Retries");
    expect(md).toContain("Redundant Calls");
    expect(md).toContain("Ghost Writes");
    expect(md).toContain("Idempotency Key Summary");
    expect(md).toContain("INITIAL");
  });

  it("counts injected errors", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: {},
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      timestamp: Date.now(),
    });

    const report = generateReport(session);
    expect(report.injectedErrors).toBe(1);
  });
});