import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  markGhostCommitted,
  deleteSession,
  listSessions,
  releaseScenarioFire,
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
      expect(decideChaosAction(session, 1, "write_payment", {}).injectError).toBe(true);
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

    it.each(["F2", "F3", "F5"])(
      "%s fires on the first write, not on a read that happens to come first",
      (scenarioId) => {
        const session = createSession(scenarioId);
        const onRead = decideChaosAction(session, 1, "read_payment_status", {});
        expect(onRead.injectError).toBe(false);
        expect(onRead.scenarioTriggered).toBe(false);

        const onWrite = decideChaosAction(session, 2, "write_payment", {});
        expect(onWrite.injectError).toBe(true);
        expect(onWrite.scenarioTriggered).toBe(true);
        expect(onWrite.executeUpstream).toBe(false);

        const onSecondWrite = decideChaosAction(session, 3, "write_payment", {});
        expect(onSecondWrite.injectError).toBe(false);
      },
    );

    it("F2 announces the session's own retry_after", () => {
      const session = createSession("F2", "deterministic", 0, undefined, { retryAfterSec: 7 });
      const decision = decideChaosAction(session, 1, "write_payment", {});
      expect(decision.retryAfterSec).toBe(7);
      expect(decision.errorBody).toMatchObject({ error: "RATE_LIMITED", retry_after: 7 });
    });

    it("two F1 decisions taken before either call is recorded: only the first is the ghost-write", () => {
      // Parallel dispatch: both calls are decided before any record exists.
      const session = createSession("F1");
      const first = decideChaosAction(session, 1, "write_payment", {});
      const second = decideChaosAction(session, 2, "write_payment", {});
      expect(first.injectError).toBe(true);
      expect(second.injectError).toBe(false);
    });

    it("a scenario that could not be applied is handed to the next write (releaseScenarioFire)", () => {
      const session = createSession("F1");
      expect(decideChaosAction(session, 1, "write_payment", {}).scenarioTriggered).toBe(true);
      // e.g. the upstream call for that write failed or was rejected
      releaseScenarioFire(session);
      expect(decideChaosAction(session, 2, "write_payment", {}).scenarioTriggered).toBe(true);
      expect(decideChaosAction(session, 3, "write_payment", {}).scenarioTriggered).toBe(false);
    });

    it("in a session that knows its tools, a call to a tool that does not exist is never a write", () => {
      const session = createSession("F2");
      session.knownToolsOnly = true;
      session.toolClassOverrides.set("book_room", "write");
      // Looks like a write by name, but the upstream has no such tool.
      const ghost = decideChaosAction(session, 1, "create_booking", {});
      expect(ghost.injectError).toBe(false);
      const real = decideChaosAction(session, 2, "book_room", {});
      expect(real.scenarioTriggered).toBe(true);
    });

    it("never fires a scenario on a tool that is not classified as a write", () => {
      const session = createSession("F1");
      const decision = decideChaosAction(session, 1, "mutate_ledger", {});
      expect(decision.injectError).toBe(false);
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

    it("ghost-write, read, then a second write → FAIL (two executions), flagged as verified-before", () => {
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
      expect(report.ghostWritesInjected).toBe(1);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate?.verifiedBefore).toBe(true);
    });

    it("ghost-write, blind retry → FAIL", () => {
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
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].type).toBe("DUPLICATE_EXECUTION");
      expect(report.violations[0].duplicate?.verifiedBefore).toBe(false);
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
      expect(md).toContain("Ghost-Writes Injected");
      expect(md).toContain("Simulated Backend Executions");
    });
  });
});