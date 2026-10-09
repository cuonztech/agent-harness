import { describe, it, expect, beforeEach } from "vitest";
import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
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