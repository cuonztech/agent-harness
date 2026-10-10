import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  getSession,
  incrementCall,
  addRecord,
  resetSession,
  deleteSession,
  listSessions,
  isWriteTool,
  type CallRecord,
} from "../src/core/state-engine.js";

describe("StateEngine", () => {
  beforeEach(() => {
    // Clean up all sessions before each test
    for (const s of listSessions()) {
      deleteSession(s.sessionId);
    }
  });

  it("creates a session with defaults", () => {
    const session = createSession();
    expect(session.sessionId).toBeTypeOf("string");
    expect(session.callCount).toBe(0);
    expect(session.scenarioId).toBeNull();
    expect(session.mode).toBe("deterministic");
    expect(session.errorRate).toBe(0.0);
    expect(session.history).toEqual([]);
  });

  it("creates a session with scenario and chaos mode", () => {
    const session = createSession("F1", "chaos", 0.3);
    expect(session.scenarioId).toBe("F1");
    expect(session.mode).toBe("chaos");
    expect(session.errorRate).toBe(0.3);
  });

  it("retrieves a session by ID", () => {
    const session = createSession();
    const retrieved = getSession(session.sessionId);
    expect(retrieved).toBe(session);
  });

  it("returns undefined for unknown session", () => {
    expect(getSession("nonexistent")).toBeUndefined();
  });

  it("increments call count", () => {
    const session = createSession();
    expect(incrementCall(session.sessionId)).toBe(1);
    expect(incrementCall(session.sessionId)).toBe(2);
    expect(incrementCall(session.sessionId)).toBe(3);
  });

  it("throws on increment for unknown session", () => {
    expect(() => incrementCall("nonexistent")).toThrow("not found");
  });

  it("adds call records", () => {
    const session = createSession();
    const record: CallRecord = {
      callNumber: 1,
      toolName: "write_payment",
      args: { amount: 100 },
      injectedError: null,
      response: '{"result":"ok"}',
      timestamp: Date.now(),
    };
    addRecord(session.sessionId, record);
    const s = getSession(session.sessionId);
    expect(s?.history).toHaveLength(1);
    expect(s?.history[0].toolName).toBe("write_payment");
  });

  it("resets session state", () => {
    const session = createSession();
    incrementCall(session.sessionId);
    incrementCall(session.sessionId);
    resetSession(session.sessionId);
    const s = getSession(session.sessionId);
    expect(s?.callCount).toBe(0);
    expect(s?.history).toEqual([]);
  });

  it("deletes a session", () => {
    const session = createSession();
    expect(deleteSession(session.sessionId)).toBe(true);
    expect(getSession(session.sessionId)).toBeUndefined();
  });

  it("returns false when deleting unknown session", () => {
    expect(deleteSession("nonexistent")).toBe(false);
  });

  it("lists all sessions", () => {
    createSession();
    createSession();
    expect(listSessions().length).toBeGreaterThanOrEqual(2);
  });

  describe("write-tool detection (configurable beyond the 'write' prefix)", () => {
    it("defaults to the write* prefix", () => {
      const session = createSession();
      expect(session.writeToolPatterns).toEqual(["write*"]);
      expect(isWriteTool("write_payment")).toBe(true);
      expect(isWriteTool("create_payment")).toBe(false);
    });

    it("accepts custom glob patterns via createSession", () => {
      const session = createSession("F1", "deterministic", 0, [
        "create_*",
        "send_*",
        "book_*",
      ]);
      expect(session.writeToolPatterns).toEqual(["create_*", "send_*", "book_*"]);
      expect(isWriteTool("create_payment", session.writeToolPatterns)).toBe(true);
      expect(isWriteTool("send_invoice", session.writeToolPatterns)).toBe(true);
      expect(isWriteTool("write_payment", session.writeToolPatterns)).toBe(false);
    });

    it("an empty pattern list falls back to the write* default instead of matching nothing", () => {
      const session = createSession("F1", "deterministic", 0, []);
      expect(session.writeToolPatterns).toEqual(["write*"]);
    });

    it("addRecord uses the session's own write-tool patterns for key tracking", () => {
      const session = createSession(null, "deterministic", 0, ["create_*"]);
      incrementCall(session.sessionId);
      addRecord(session.sessionId, {
        callNumber: 1,
        toolName: "create_payment",
        args: { idempotency_key: "custom-write-1" },
        injectedError: null,
        response: '{"result":"ok"}',
        upstreamExecuted: true,
        timestamp: Date.now(),
      });
      const tracking = session.keyStates.get("custom-write-1");
      expect(tracking?.writeCalls).toBe(1);
      expect(tracking?.state).toBe("COMMITTED");
    });
  });
});