import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  markGhostCommitted,
  deleteSession,
  listSessions,
} from "../src/engine/state-machine.js";
import { generateReport, formatMarkdown } from "../src/core/report-generator.js";
import { decideChaosAction } from "../src/proxy/ghost-write.js";

describe("Proxy & Ghost-Write", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  describe("Chaos Decision Engine", () => {
    it("returns no chaos once past the agent's first write (F1 already triggered)", () => {
      const session = createSession("F1");
      // F1 now triggers on the first WRITE call, not a fixed call number —
      // simulate that first write already having happened.
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "write_payment",
        args: {},
        injectedError: "[TIMEOUT]",
        response: '{"error":"timeout"}',
        upstreamExecuted: true,
        timestamp: Date.now(),
      });
      const decision = decideChaosAction(session, 2, "write_payment", {});
      expect(decision.injectError).toBe(false);
      expect(decision.executeUpstream).toBe(true);
    });

    it("returns ghost-write for F1 timeout on the agent's first write", () => {
      const session = createSession("F1");
      const decision = decideChaosAction(session, 1, "write_payment", {});
      expect(decision.injectError).toBe(true);
      expect(decision.errorType).toContain("TIMEOUT");
      expect(decision.executeUpstream).toBe(true); // Ghost-write: execute upstream
    });

    it("triggers F1 on the first write even if the agent read first", () => {
      const session = createSession("F1");
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "read_payment_status",
        args: {},
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: true,
        timestamp: Date.now(),
      });
      const decision = decideChaosAction(session, 2, "write_payment", {});
      expect(decision.injectError).toBe(true);
      expect(decision.errorType).toContain("TIMEOUT");
    });

    it("returns error-only for F5 (no upstream execution)", () => {
      const session = createSession("F5");
      const decision = decideChaosAction(session, 1, "write_payment", {});
      expect(decision.injectError).toBe(true);
      expect(decision.errorType).toContain("ERROR");
      expect(decision.executeUpstream).toBe(false);
    });

    it("executes upstream for real on F4 duplicate dispatch (no fabricated success)", () => {
      const session = createSession("F4");
      const first = decideChaosAction(session, 1, "write_payment", {});
      expect(first.errorType).toBeNull(); // "success" type: not a simulated failure
      expect(first.executeUpstream).toBe(true);

      const second = decideChaosAction(session, 2, "write_payment", {});
      expect(second.errorType).toBeNull();
      expect(second.executeUpstream).toBe(true); // the duplicate call reaches upstream too
    });

    it("returns chaos injection in chaos mode at 100% rate", () => {
      const session = createSession(null, "chaos", 1.0);
      const decision = decideChaosAction(session, 1, "any_tool", {});
      expect(decision.injectError).toBe(true);
      expect(decision.errorType).toContain("CHAOS");
    });

    it("returns no chaos in chaos mode at 0% rate", () => {
      const session = createSession(null, "chaos", 0.0);
      const decision = decideChaosAction(session, 1, "any_tool", {});
      expect(decision.injectError).toBe(false);
    });
  });

  describe("Ghost-Write State Tracking", () => {
    it("marks key as GHOST_COMMITTED", () => {
      const session = createSession();
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "write_payment",
        args: { idempotency_key: "ghost-001" },
        injectedError: "[TIMEOUT]",
        response: '{"error":"timeout"}',
        upstreamExecuted: true,
        timestamp: 1000,
      });

      markGhostCommitted(session.sessionId, "ghost-001");

      const keyState = session.keyStates.get("ghost-001");
      expect(keyState?.state).toBe("GHOST_COMMITTED");
      expect(keyState?.ghostCommitted).toBe(true);
    });

    it("GHOST_CAUGHT: agent reads before retry → PASS", () => {
      const session = createSession();

      // Call 1: write → ghost-write (upstream executed, timeout returned)
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "write_payment",
        args: { idempotency_key: "ghost-002" },
        injectedError: "[TIMEOUT]",
        response: '{"error":"timeout"}',
        upstreamExecuted: true,
        timestamp: 1000,
      });
      markGhostCommitted(session.sessionId, "ghost-002");

      // Call 2: read to verify
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 2,
        toolName: "read_payment_status",
        args: { idempotency_key: "ghost-002" },
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: false,
        timestamp: 2000,
      });

      // Call 3: retry write with same key
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 3,
        toolName: "write_payment",
        args: { idempotency_key: "ghost-002" },
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: false,
        timestamp: 3000,
      });

      const report = generateReport(session);
      expect(report.ghostWriteDetections).toBe(1);
      expect(report.ghostWriteMisses).toBe(0);
      expect(report.verdict).toBe("PASS");
      expect(report.keySummary[0].classification).toBe("GHOST_CAUGHT");
    });

    it("GHOST_MISSED: agent blindly retries → FAIL", () => {
      const session = createSession();

      // Call 1: write → ghost-write
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "write_payment",
        args: { idempotency_key: "ghost-003" },
        injectedError: "[TIMEOUT]",
        response: '{"error":"timeout"}',
        upstreamExecuted: true,
        timestamp: 1000,
      });
      markGhostCommitted(session.sessionId, "ghost-003");

      // Call 2: blind retry, no read between
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 2,
        toolName: "write_payment",
        args: { idempotency_key: "ghost-003" },
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: false,
        timestamp: 2000,
      });

      const report = generateReport(session);
      expect(report.ghostWriteMisses).toBe(1);
      expect(report.ghostWriteDetections).toBe(0);
      expect(report.verdict).toBe("FAIL");
      expect(report.keySummary[0].classification).toBe("GHOST_MISSED");
      expect(report.violations.some((v) => v.type === "GHOST_MISSED")).toBe(true);
    });
  });

  describe("Report Ghost-Write Metrics", () => {
    it("includes upstreamCalls count", () => {
      const session = createSession();
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "write_payment",
        args: {},
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: true,
        timestamp: Date.now(),
      });

      const report = generateReport(session);
      expect(report.upstreamCalls).toBe(1);
    });

    it("markdown includes ghost-write fields", () => {
      const session = createSession();
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "write_payment",
        args: { idempotency_key: "md-ghost" },
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: true,
        timestamp: Date.now(),
      });

      const md = formatMarkdown(generateReport(session));
      expect(md).toContain("Ghost-Write Detections");
      expect(md).toContain("Ghost-Write Misses");
      expect(md).toContain("Upstream Calls");
    });
  });
});