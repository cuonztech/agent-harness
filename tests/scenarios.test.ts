import { describe, it, expect, beforeEach } from "vitest";
import { ALL_SCENARIOS, getScenarioById } from "../src/scenarios/f1-f5.js";
import type { TriggerContext } from "../src/scenarios/types.js";

function ctx(overrides: Partial<TriggerContext>): TriggerContext {
  return { callNumber: 1, toolName: "any", isWriteCall: false, priorWriteCalls: 0, ...overrides };
}

describe("Scenarios F1-F5", () => {
  it("has exactly 5 scenarios", () => {
    expect(ALL_SCENARIOS).toHaveLength(5);
  });

  it("each scenario has required fields", () => {
    for (const s of ALL_SCENARIOS) {
      expect(s.id).toBeTypeOf("string");
      expect(s.name).toBeTypeOf("string");
      expect(s.description).toBeTypeOf("string");
      expect(typeof s.triggerCondition).toBe("function");
      expect(s.simulatedResponse).toBeDefined();
      expect(s.auditMetric).toBeTypeOf("string");
    }
  });

  it("getScenarioById returns correct scenario", () => {
    expect(getScenarioById("F1")?.name).toBe("Timeout on First Write");
    expect(getScenarioById("F2")?.name).toBe("Rate Limit (429)");
    expect(getScenarioById("F3")?.name).toBe("Malformed JSON Response");
    expect(getScenarioById("F4")?.name).toBe("Duplicate Dispatch (Ghost-Write)");
    expect(getScenarioById("F5")?.name).toBe("Server Error (500) then Success");
  });

  it("getScenarioById returns undefined for unknown", () => {
    expect(getScenarioById("F99")).toBeUndefined();
  });

  it("F1 triggers on the agent's first write call, regardless of call position", () => {
    const f1 = getScenarioById("F1")!;
    expect(f1.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: true }))).toBe(true);
    expect(f1.triggerCondition(ctx({ priorWriteCalls: 1, isWriteCall: true }))).toBe(false);
    expect(f1.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: false }))).toBe(false);
    // A read-first agent must still trigger F1 on its first write, even
    // though that write isn't callNumber 1 overall.
    expect(
      f1.triggerCondition(ctx({ callNumber: 3, priorWriteCalls: 0, isWriteCall: true })),
    ).toBe(true);
  });

  it("F2 triggers on second call regardless of tool", () => {
    const f2 = getScenarioById("F2")!;
    expect(f2.triggerCondition(ctx({ callNumber: 2 }))).toBe(true);
    expect(f2.triggerCondition(ctx({ callNumber: 1 }))).toBe(false);
  });

  it("F3 triggers on first call", () => {
    const f3 = getScenarioById("F3")!;
    expect(f3.triggerCondition(ctx({ callNumber: 1 }))).toBe(true);
    expect(f3.triggerCondition(ctx({ callNumber: 2 }))).toBe(false);
  });

  it("F4 triggers on the agent's first two write calls, regardless of call position", () => {
    const f4 = getScenarioById("F4")!;
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: true }))).toBe(true);
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 1, isWriteCall: true }))).toBe(true);
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 2, isWriteCall: true }))).toBe(false);
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: false }))).toBe(false);
  });

  it("F5 triggers on first call", () => {
    const f5 = getScenarioById("F5")!;
    expect(f5.triggerCondition(ctx({ callNumber: 1 }))).toBe(true);
    expect(f5.triggerCondition(ctx({ callNumber: 2 }))).toBe(false);
  });
});