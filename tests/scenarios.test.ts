import { describe, it, expect, beforeEach } from "vitest";
import { ALL_SCENARIOS, getScenarioById } from "../src/scenarios/f1-f5.js";

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

  it("F1 triggers on first write call", () => {
    const f1 = getScenarioById("F1")!;
    expect(f1.triggerCondition(1, "write_payment")).toBe(true);
    expect(f1.triggerCondition(2, "write_payment")).toBe(false);
    expect(f1.triggerCondition(1, "read_data")).toBe(false);
  });

  it("F2 triggers on second call regardless of tool", () => {
    const f2 = getScenarioById("F2")!;
    expect(f2.triggerCondition(2, "any_tool")).toBe(true);
    expect(f2.triggerCondition(1, "any_tool")).toBe(false);
  });

  it("F3 triggers on first call", () => {
    const f3 = getScenarioById("F3")!;
    expect(f3.triggerCondition(1, "any")).toBe(true);
    expect(f3.triggerCondition(2, "any")).toBe(false);
  });

  it("F4 triggers on first two write calls", () => {
    const f4 = getScenarioById("F4")!;
    expect(f4.triggerCondition(1, "write_payment")).toBe(true);
    expect(f4.triggerCondition(2, "write_payment")).toBe(true);
    expect(f4.triggerCondition(3, "write_payment")).toBe(false);
    expect(f4.triggerCondition(1, "read_data")).toBe(false);
  });

  it("F5 triggers on first call", () => {
    const f5 = getScenarioById("F5")!;
    expect(f5.triggerCondition(1, "any")).toBe(true);
    expect(f5.triggerCondition(2, "any")).toBe(false);
  });
});