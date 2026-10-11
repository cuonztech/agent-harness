import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  markGhostCommitted,
  deleteSession,
  listSessions,
} from "../src/core/state-engine.js";
import { generateReport, formatMarkdown } from "../src/core/report-generator.js";

// The verdict logic itself is covered case by case in
// tests/audit-matrix.test.ts; this file covers the report's shape, counters
// and the informational key summary.
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
    expect(report.duplicateExecutions).toBe(0);
    expect(report.retryAfterViolations).toBe(0);
    expect(report.operations).toHaveLength(1);
    expect(report.operations[0]).toMatchObject({
      tool: "write_payment",
      attempts: 1,
      executions: 1,
      keys: ["key-001"],
      outcome: "CLEAN",
    });
    expect(report.scoring).toEqual({
      writeOperations: 1,
      safeOperations: 1,
      operationsWithFailure: 0,
      handlingPoints: 0,
    });
    expect(report.keySummary).toHaveLength(1);
    expect(report.keySummary[0].state).toBe("COMMITTED");
  });

  it("an unresolved ghost-write (one write call, nothing since) is PASS and shows up as an observation", () => {
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
    expect(report.ghostWritesInjected).toBe(1);
    expect(report.operations[0].ghostWrite).toBe(true);
    expect(report.operations[0].outcome).toBe("UNVERIFIED_AFTER_TIMEOUT");
    expect(report.observations[0].type).toBe("UNVERIFIED_AFTER_TIMEOUT");
    expect(report.keySummary[0].ghostCommitted).toBe(true);
  });

  it("a timeout that did NOT execute upstream is an ordinary failed attempt, not a ghost-write", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "key-vr" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      upstreamExecuted: false,
      timestamp: 1000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "write_payment",
      args: { idempotency_key: "key-vr" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 3000,
    });

    const report = generateReport(session);
    expect(report.verdict).toBe("PASS");
    expect(report.ghostWritesInjected).toBe(0);
    expect(report.operations[0]).toMatchObject({
      attempts: 2,
      executions: 1,
      failedAttempts: 1,
      outcome: "RECOVERED_BY_RETRY",
    });
  });

  it("a failure on a read tool is counted as an injected error but never creates an operation", () => {
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
    expect(report.injectedErrors).toBe(1);
    expect(report.operations).toHaveLength(0);
    expect(report.coverage.readCalls).toBe(1);
    expect(report.verdict).toBe("NOT_TESTED");
  });

  it("classifies and counts calls by tool class", () => {
    const session = createSession();
    const calls = ["write_payment", "get_payment", "search_payments", "frobnicate"];
    for (const [i, toolName] of calls.entries()) {
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: i + 1,
        toolName,
        args: {},
        injectedError: null,
        response: '{"result":"ok"}',
        timestamp: Date.now(),
      });
    }

    const report = generateReport(session);
    expect(report.coverage).toMatchObject({
      writeCalls: 1,
      readCalls: 2,
      unclassifiedCalls: 1,
      unclassifiedTools: ["frobnicate"],
    });
  });

  it("formats the markdown report", () => {
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

    const md = formatMarkdown(generateReport(session));
    expect(md).toContain("# Agent Audit Report [PASS]");
    expect(md).toContain("Duplicate Executions");
    expect(md).toContain("## Coverage");
    expect(md).toContain("## Write Operations");
    expect(md).toContain("Idempotency Key Summary");
    expect(md).toContain("not measured");
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
