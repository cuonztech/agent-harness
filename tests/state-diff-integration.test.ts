// Covers the StateDiffStore wiring into the real audit pipeline
// (src/engine/state-machine.ts -> src/core/report-generator.ts), i.e. the
// three capabilities the marketing site advertises under "Reales
// State-Diffing": record existence, didAgentReadBefore, and silent give-up.
// tests/state-diff.test.ts covers the class itself in isolation; this file
// covers it wired into generateReport()'s actual KeySummaryEntry.stateDiff.
import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  markGhostCommitted,
  deleteSession,
  listSessions,
  resetSession,
} from "../src/engine/state-machine.js";
import { generateReport, formatMarkdown } from "../src/core/report-generator.js";

describe("StateDiffStore wired into the real audit pipeline", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  it("recordExisted: true once a write actually lands", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-exists", amount: 10 },
      injectedError: null,
      response: '{"result":"ok"}',
      upstreamExecuted: false,
      timestamp: 1000,
    });

    const report = generateReport(session);
    expect(report.keySummary[0].stateDiff.recordExisted).toBe(true);
  });

  it("didAgentReadBefore (strict): true when the read carries the SAME idempotency_key as the failed write", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-strict-match" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      timestamp: 1000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "read_payment_status",
      args: { idempotency_key: "sd-strict-match" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 2000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 3,
      toolName: "write_payment",
      args: { idempotency_key: "sd-strict-match" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 3000,
    });

    const report = generateReport(session);
    expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
    expect(report.keySummary[0].stateDiff.didAgentReadBefore).toBe(true);
  });

  it("didAgentReadBefore (strict): false when the read does NOT carry the failed write's idempotency_key, even though the lenient readBeforeRetry heuristic still passes", () => {
    // The agent's check-status call uses its own domain param
    // (transaction_ref), not the literal idempotency_key field. The lenient
    // readBeforeRetry flag (any read-shaped tool call in the window) is set;
    // the strict, key-matched StateDiffStore check is not. Both are
    // informational — the verdict comes from the second execution.
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-loose-miss" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      upstreamExecuted: true,
      timestamp: 1000,
    });
    markGhostCommitted(session.sessionId, "sd-loose-miss");
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "read_payment_status",
      args: { transaction_ref: "sd-loose-miss" }, // no idempotency_key
      injectedError: null,
      response: '{"result":"ok"}',
      upstreamExecuted: false,
      timestamp: 2000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 3,
      toolName: "write_payment",
      args: { idempotency_key: "sd-loose-miss" },
      injectedError: null,
      response: '{"result":"ok"}',
      upstreamExecuted: false,
      timestamp: 3000,
    });

    const report = generateReport(session);
    // Read or not: the write executed twice. This used to be GHOST_CAUGHT /
    // "excellent behavior".
    expect(report.verdict).toBe("FAIL");
    expect(report.violations[0].duplicate?.verifiedBefore).toBe(true);
    expect(report.keySummary[0].readBeforeRetry).toBe(true);
    expect(report.keySummary[0].stateDiff.didAgentReadBefore).toBe(false);
    expect(report.keySummary[0].stateDiff.wasOverwritten).toBe(true);
    // Regression: agentGaveUpSilently must NOT fire just because the strict
    // read-match missed. The agent demonstrably did NOT give up here.
    expect(report.keySummary[0].stateDiff.agentGaveUpSilently).toBe(false);
  });

  it("agentGaveUpSilently: false after a recovered retry — the agent took further action, it did not abandon the key, even though its read used a different param than idempotency_key", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-valid-retry-loose" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      timestamp: 1000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "read_payment_status",
      args: { transaction_ref: "sd-valid-retry-loose" }, // no idempotency_key
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 2000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 3,
      toolName: "write_payment",
      args: { idempotency_key: "sd-valid-retry-loose" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 3000,
    });

    const report = generateReport(session);
    expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
    expect(report.keySummary[0].stateDiff.didAgentReadBefore).toBe(false);
    expect(report.keySummary[0].stateDiff.agentGaveUpSilently).toBe(false);
  });

  it("agentGaveUpSilently: true for an unresolved ghost-write with no follow-up at all", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-abandoned" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      upstreamExecuted: true,
      timestamp: 1000,
    });
    markGhostCommitted(session.sessionId, "sd-abandoned");

    const report = generateReport(session);
    // Informational: nothing was duplicated, so the verdict stays PASS.
    expect(report.verdict).toBe("PASS");
    expect(report.keySummary[0].stateDiff.agentGaveUpSilently).toBe(true);
    expect(report.keySummary[0].stateDiff.didAgentReadBefore).toBe(false);
  });

  it("agentGaveUpSilently: false once the agent reads the exact key before giving up", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-checked" },
      injectedError: "[TIMEOUT]",
      response: '{"error":"timeout"}',
      upstreamExecuted: true,
      timestamp: 1000,
    });
    markGhostCommitted(session.sessionId, "sd-checked");
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "read_payment_status",
      args: { idempotency_key: "sd-checked" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 2000,
    });

    const report = generateReport(session);
    expect(report.keySummary[0].stateDiff.didAgentReadBefore).toBe(true);
    expect(report.keySummary[0].stateDiff.agentGaveUpSilently).toBe(false);
  });

  it("wasOverwritten: true once a second successful write lands for the same key", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-overwrite", amount: 10 },
      injectedError: null,
      response: '{"result":"ok","amount":10}',
      timestamp: 1000,
    });
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 2,
      toolName: "write_payment",
      args: { idempotency_key: "sd-overwrite", amount: 20 },
      injectedError: null,
      response: '{"result":"ok","amount":20}',
      timestamp: 2000,
    });

    const report = generateReport(session);
    expect(report.keySummary[0].stateDiff.wasOverwritten).toBe(true);
  });

  it("wasOverwritten: false for a key whose only write never landed (record does not exist)", () => {
    // Regression: `record?.overwrittenAt !== null` is true for a missing
    // record (undefined !== null), so the report claimed "Overwritten: yes"
    // for data that never existed.
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-never-written" },
      injectedError: "[RATE_LIMIT]",
      response: '{"error":"RATE_LIMITED"}',
      upstreamExecuted: false,
      timestamp: 1000,
    });

    const report = generateReport(session);
    expect(report.keySummary[0].stateDiff.recordExisted).toBe(false);
    expect(report.keySummary[0].stateDiff.wasOverwritten).toBe(false);
  });

  it("reset_session clears the state-diff store along with history and keyStates", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-reset" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 1000,
    });
    expect(session.stateDiff.exists("sd-reset")).toBe(true);

    resetSession(session.sessionId);

    expect(session.stateDiff.exists("sd-reset")).toBe(false);
    expect(generateReport(session).keySummary).toHaveLength(0);
  });

  it("markdown report renders the State-Diff section", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    addRecord(session.sessionId, {
      callNumber: 1,
      toolName: "write_payment",
      args: { idempotency_key: "sd-md" },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: 1000,
    });

    const md = formatMarkdown(generateReport(session));
    expect(md).toContain("State-Diff (strict, key-matched)");
    expect(md).toContain("didAgentReadBefore");
  });
});
