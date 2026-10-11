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
    expect(getScenarioById("F4")?.name).toBe("Duplicate Dispatch (no injected failure)");
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

  it.each(["F2", "F3", "F5"])(
    "%s triggers on the agent's first write call — never on a read, never by call position",
    (id) => {
      const scenario = getScenarioById(id)!;
      expect(scenario.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: true }))).toBe(true);
      expect(
        scenario.triggerCondition(ctx({ callNumber: 4, priorWriteCalls: 0, isWriteCall: true })),
      ).toBe(true);
      expect(scenario.triggerCondition(ctx({ priorWriteCalls: 1, isWriteCall: true }))).toBe(false);
      // Positional triggers used to hit a harmless read here (callNumber 1/2).
      expect(scenario.triggerCondition(ctx({ callNumber: 1, isWriteCall: false }))).toBe(false);
      expect(scenario.triggerCondition(ctx({ callNumber: 2, isWriteCall: false }))).toBe(false);
    },
  );

  it("F3's malformed body contains nothing a model could mistake for a result", () => {
    const body = getScenarioById("F3")!.simulatedResponse.body as string;
    expect(() => JSON.parse(body)).toThrow();
    expect(body).not.toMatch(/[0-9]/);
    expect(body.toLowerCase()).not.toMatch(/ok|success|result|id|confirm/);
  });

  it("the simulated timeout does not claim a specific duration it never waited", () => {
    const body = getScenarioById("F1")!.simulatedResponse.body as { message: string };
    expect(body.message).not.toMatch(/[0-9]+ ?s/);
  });

  it("F4 triggers on the agent's first two write calls, regardless of call position", () => {
    const f4 = getScenarioById("F4")!;
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: true }))).toBe(true);
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 1, isWriteCall: true }))).toBe(true);
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 2, isWriteCall: true }))).toBe(false);
    expect(f4.triggerCondition(ctx({ priorWriteCalls: 0, isWriteCall: false }))).toBe(false);
  });

});