import { describe, it, expect, beforeEach } from "vitest";
import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
  handleGetScore,
  handleListScenarios,
  handleResetSession,
  handleDeleteSession,
} from "../src/tools/handlers.js";
import { listSessions, deleteSession } from "../src/core/state-engine.js";

describe("Tool Handlers", () => {
  beforeEach(() => {
    for (const s of listSessions()) {
      deleteSession(s.sessionId);
    }
  });

  describe("handleStartSession", () => {
    it("creates a session with defaults", () => {
      const result = handleStartSession({});
      expect(result.content).toHaveLength(1);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.sessionId).toBeTypeOf("string");
      expect(body.mode).toBe("deterministic");
    });

    it("creates a session with scenario F1", () => {
      const result = handleStartSession({ scenario_id: "F1" });
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.scenarioId).toBe("F1");
    });

    it("rejects unknown scenario", () => {
      const result = handleStartSession({ scenario_id: "F99" });
      expect(result.isError).toBe(true);
    });

    it("write_tool_patterns makes a non-'write'-prefixed tool trigger F1", () => {
      const withDefault = handleStartSession({ scenario_id: "F1" });
      const defaultSid = JSON.parse((withDefault.content[0] as { text: string }).text).sessionId;
      const defaultResult = handleExecuteCall({
        session_id: defaultSid,
        tool_name: "create_payment",
        arguments: { amount: 10 },
      });
      // Default patterns (["write*"]) don't match "create_payment" — F1 never fires.
      const defaultBody = JSON.parse((defaultResult.content[0] as { text: string }).text);
      expect(defaultBody.injectedError).toBeNull();

      const withCustom = handleStartSession({
        scenario_id: "F1",
        write_tool_patterns: ["create_*"],
      });
      const customSid = JSON.parse((withCustom.content[0] as { text: string }).text).sessionId;
      const customResult = handleExecuteCall({
        session_id: customSid,
        tool_name: "create_payment",
        arguments: { amount: 10 },
      });
      const customBody = JSON.parse((customResult.content[0] as { text: string }).text);
      expect(customBody.injectedError).toContain("TIMEOUT");
    });
  });

  describe("handleExecuteCall", () => {
    it("executes a call and returns result", () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const result = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "key-001",
      });

      expect(result.content).toHaveLength(1);
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.callNumber).toBe(1);
    });

    it("returns error for unknown session", () => {
      const result = handleExecuteCall({
        session_id: "00000000-0000-0000-0000-000000000000",
        tool_name: "test",
        arguments: {},
      });
      expect(result.isError).toBe(true);
    });

    it("injects error for F1 scenario on first write", () => {
      const session = handleStartSession({ scenario_id: "F1" });
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const result = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100, idempotency_key: "key-f1" },
      });

      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.injectedError).toContain("TIMEOUT");
      expect(result.isError).toBe(true);
    });

    it("enforces idempotency in ad-hoc mode: repeated key returns the identical cached result", () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const first = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-001",
      });
      const firstBody = JSON.parse((first.content[0] as { text: string }).text);

      const second = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-001",
      });
      const secondBody = JSON.parse((second.content[0] as { text: string }).text);

      // Before the fix, call 2 got its own callNumber/timestamp — a different
      // response from call 1 despite the identical idempotency key.
      expect(secondBody.response).toEqual(firstBody.response);
      expect(secondBody.deduplicated).toBe(true);
      expect(secondBody.callNumber).toBe(2); // call counter still advances
    });

    it("a dedup hit must not make the audit report misclassify itself as REDUNDANT_CALL/FAIL", async () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-report-001",
      });
      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-report-001",
      });

      const report = await handleGetReport({ session_id: sid, format: "json" });
      const body = JSON.parse((report.content[0] as { text: string }).text);
      expect(body.redundantCalls).toBe(0);
      expect(body.verdict).toBe("PASS");
      const keyEntry = body.keySummary.find((k: { key: string }) => k.key === "dedup-report-001");
      expect(keyEntry.writeCalls).toBe(1);
    });

    it("does NOT dedup when the reused key carries different arguments", () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const first = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-argmismatch",
      });
      const firstBody = JSON.parse((first.content[0] as { text: string }).text);

      const second = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 999 },
        idempotency_key: "dedup-argmismatch",
      });
      const secondBody = JSON.parse((second.content[0] as { text: string }).text);

      expect(secondBody.deduplicated).toBeUndefined();
      expect(secondBody.response).not.toEqual(firstBody.response);
    });

    it("does NOT dedup in chaos mode — a committed key must stay re-executable so error_rate keeps applying", () => {
      // error_rate 0 here only isolates the dedup guard itself (mode check):
      // the key commits cleanly on call 1, then call 2 must still go through
      // normal execution (fresh callNumber/timestamp in the response) instead
      // of being served from cache — proving the key is NOT permanently
      // immune to future chaos injection just because it once committed.
      const session = handleStartSession({ mode: "chaos", error_rate: 0.0 });
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const first = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-chaos-001",
      });
      const firstBody = JSON.parse((first.content[0] as { text: string }).text);

      const second = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "dedup-chaos-001",
      });
      const secondBody = JSON.parse((second.content[0] as { text: string }).text);

      expect(secondBody.deduplicated).toBeUndefined();
      // Nested callNumber comes from the response BODY, not the wrapper — a
      // dedup hit would replay call 1's stale body (callNumber 1) verbatim.
      expect(firstBody.response.callNumber).toBe(1);
      expect(secondBody.response.callNumber).toBe(2);
    });

    it("does NOT dedup inside a deterministic scenario — positional triggers stay authoritative", () => {
      const session = handleStartSession({ scenario_id: "F2" });
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      // Call 1: success (F2 only triggers on callNumber 2)
      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 10 },
        idempotency_key: "f2-no-dedup",
      });

      // Call 2: same key — F2 must still rate-limit this, not replay call 1's result
      const second = handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 10 },
        idempotency_key: "f2-no-dedup",
      });
      const secondBody = JSON.parse((second.content[0] as { text: string }).text);
      expect(secondBody.injectedError).toContain("RATE_LIMIT");
      expect(second.isError).toBe(true);
    });
  });

  describe("handleGetReport", () => {
    it("generates markdown report", async () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const report = await handleGetReport({ session_id: sid, format: "markdown" });
      const text = (report.content[0] as { text: string }).text;
      expect(text).toContain("# Agent Audit Report");
    });

    it("generates JSON report", async () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const report = await handleGetReport({ session_id: sid, format: "json" });
      const body = JSON.parse((report.content[0] as { text: string }).text);
      expect(body.verdict).toBe("PASS");
    });
  });

  describe("handleGetScore", () => {
    it("returns error for unknown session", () => {
      const result = handleGetScore({ session_id: "00000000-0000-0000-0000-000000000000" });
      expect(result.isError).toBe(true);
    });

    it("scores a clean session at 100 with no patches", () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "score-clean-001",
      });

      const result = handleGetScore({ session_id: sid, format: "json" });
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.score.overall).toBe(100);
      expect(body.patches).toHaveLength(0);
    });

    it("scores THIS session's real violations, not a canned benchmark script", () => {
      const session = handleStartSession({ scenario_id: "F1" });
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      // Blind retry: write -> timeout (ghost-write) -> immediate retry, no read
      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "score-blind-001",
      });
      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "score-blind-001",
      });

      const result = handleGetScore({ session_id: sid, format: "json" });
      const body = JSON.parse((result.content[0] as { text: string }).text);
      expect(body.score.overall).toBeLessThan(100);
      expect(body.score.breakdown.ghostMissed).toBe(1);
      const patch = body.patches.find((p: { category: string }) => p.category === "GHOST_WRITE");
      expect(patch).toBeDefined();
    });

    it("markdown format includes the score header and patch section", () => {
      const session = handleStartSession({ scenario_id: "F1" });
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "score-md-001",
      });
      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: { amount: 100 },
        idempotency_key: "score-md-001",
      });

      const result = handleGetScore({ session_id: sid });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("CuonzTech Resilience Score");
      expect(text).toContain("Hardening Report");
    });
  });

  describe("handleListScenarios", () => {
    it("lists all 5 scenarios", () => {
      const result = handleListScenarios();
      const list = JSON.parse((result.content[0] as { text: string }).text);
      expect(list).toHaveLength(5);
    });
  });

  describe("handleResetSession", () => {
    it("resets a session", () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      handleExecuteCall({
        session_id: sid,
        tool_name: "write_payment",
        arguments: {},
      });

      const result = handleResetSession({ session_id: sid });
      expect((result.content[0] as { text: string }).text).toContain("reset");
    });
  });

  describe("handleDeleteSession", () => {
    it("deletes a session", () => {
      const session = handleStartSession({});
      const sid = JSON.parse((session.content[0] as { text: string }).text).sessionId;

      const result = handleDeleteSession({ session_id: sid });
      expect((result.content[0] as { text: string }).text).toContain("deleted");
    });
  });
});