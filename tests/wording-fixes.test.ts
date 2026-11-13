// Textkorrekturen aus dem kontextfreien Test von 0.9.0 (Befunde 6 und 8).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createSession, incrementCall, addRecord, deleteSession, listSessions, type CallRecord, type SessionState } from "../src/engine/state-machine.js";
import { buildCallForensics } from "../src/core/call-forensics.js";
import { proProcessEnv } from "./helpers/license-env.js";

function add(s: SessionState, partial: Partial<CallRecord> & { toolName: string }): void {
  const callNumber = incrementCall(s.sessionId);
  addRecord(s.sessionId, {
    callNumber, args: {}, injectedError: null, response: "{}", upstreamExecuted: true, timestamp: callNumber * 1000, ...partial,
  });
}
const clear = (): void => { for (const s of listSessions()) deleteSession(s.sessionId); };

describe("Zeitleiste: andere Argumente sind keine Wiederholung (Befund 6)", () => {
  it("ein anderer Gast, anderes Datum, anderer Betrag nach einem Fehler heisst «Weiterer Aufruf», nicht «Wiederholung/Doppelausfuehrung»", () => {
    clear();
    const s = createSession("F5");
    add(s, { toolName: "create_booking", args: { guest: "Anna", date: "2026-11-03", amount: 100 }, injectedError: "[500]", upstreamExecuted: false, scenarioTriggered: true });
    add(s, { toolName: "create_booking", args: { guest: "Bob", date: "2026-12-24", amount: 250 } });
    const f = buildCallForensics(s);
    expect(f.entries[1].summaryDe).toContain("Weiterer Aufruf des Tools mit anderen Argumenten als Aufruf #1");
    expect(f.entries[1].summaryDe).not.toContain("Wiederholung von");
    expect(f.entries[1].summaryDe).not.toContain("Doppelausführung");
  });

  it("zweimal derselbe Vorgang bleibt «Wiederholung … Doppelausfuehrung»", () => {
    clear();
    const s = createSession("F4");
    const args = { guest: "Anna", date: "2026-11-03", amount: 100 };
    add(s, { toolName: "create_booking", args, scenarioTriggered: true });
    add(s, { toolName: "create_booking", args, scenarioTriggered: true });
    expect(buildCallForensics(s).entries[1].summaryDe).toBe("Wiederholung von Aufruf #1: erneut im Zielsystem ausgeführt (Doppelausführung).");
  });

  it("ein Retry mit nur einem geaenderten Feld bleibt eine Wiederholung (Parameter-Mutation sichtbar)", () => {
    clear();
    const s = createSession("F1");
    add(s, { toolName: "create_booking", args: { guest: "Anna", date: "2026-11-03", amount: 100 }, injectedError: "[TIMEOUT]", scenarioTriggered: true });
    add(s, { toolName: "create_booking", args: { guest: "Anna", date: "2026-11-03", amount: 120 } });
    const f = buildCallForensics(s);
    expect(f.entries[1].summaryDe).toContain("Wiederholung von Aufruf #1");
    expect(f.mutationsOnRetryCount).toBe(1);
  });
});

describe("Startmeldung bei F4 (Befund 8)", () => {
  it("F4 meldet, dass nichts eingespielt wird, und behauptet keine Fehlerinjektion", async () => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", "--allow-writes", "--scenario", "F4", "--upstream-command", process.execPath, "--upstream-arg", "tests/fixtures/upstream-fixture-server.mjs"], { env: proProcessEnv() });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    await new Promise((res) => setTimeout(res, 1500));
    child.kill();
    expect(err).toContain("scenario F4 injects no failure");
    expect(err).not.toContain("failure injection is active");
  }, 20_000);

  it("F2 meldet weiterhin eine aktive Fehlerinjektion", async () => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", "--allow-writes", "--scenario", "F2", "--upstream-command", process.execPath, "--upstream-arg", "tests/fixtures/upstream-fixture-server.mjs"], { env: proProcessEnv() });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    await new Promise((res) => setTimeout(res, 1500));
    child.kill();
    expect(err).toContain("failure injection is active");
  }, 20_000);
});
