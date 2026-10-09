// Echter Stdio-E2E-Test: spawnt den KOMPILIERTEN Server (dist/index.js) als
// eigenen Prozess und spricht ihn per echtem MCP-Client-SDK über Stdio an —
// anders als die restliche Suite, die die Handler-Funktionen direkt aufruft.
// Das testet, was `npx cuonztech-agent-harness` tatsächlich ausliefert:
// Protokoll-Handshake, Tool-Registrierung, echte Tool-Aufrufe über die Wire.
// Braucht einen frischen `dist/` — siehe "pretest" in package.json.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  return first && first.type === "text" ? first.text : "";
}

describe("MCP stdio server (real process, real protocol)", () => {
  let client: Client;

  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
    });
    client = new Client({ name: "e2e-test-client", version: "0.0.1" });
    await client.connect(transport);
  }, 15_000);

  afterAll(async () => {
    await client?.close();
  });

  it("completes the MCP handshake and lists all registered tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "delete_session",
        "execute_call",
        "get_report",
        "get_score",
        "list_scenarios",
        "reset_session",
        "start_session",
      ].sort(),
    );
  });

  it("runs a full session lifecycle over the wire: start -> execute -> report -> delete", async () => {
    const startRes = await client.callTool({
      name: "start_session",
      arguments: { scenario_id: "F1" },
    });
    const start = JSON.parse(textOf(startRes)) as { sessionId: string; scenarioId: string };
    expect(start.sessionId).toBeTypeOf("string");
    expect(start.scenarioId).toBe("F1");

    const callRes = await client.callTool({
      name: "execute_call",
      arguments: {
        session_id: start.sessionId,
        tool_name: "write_payment",
        arguments: { amount: 50 },
        idempotency_key: "e2e-key-1",
      },
    });
    const callBody = JSON.parse(textOf(callRes)) as { statusCode: number; injectedError: string };
    expect(callRes.isError).toBe(true);
    expect(callBody.statusCode).toBe(408);
    expect(callBody.injectedError).toContain("TIMEOUT");

    const reportRes = await client.callTool({
      name: "get_report",
      arguments: { session_id: start.sessionId, format: "json" },
    });
    const report = JSON.parse(textOf(reportRes)) as { verdict: string; totalCalls: number };
    expect(report.totalCalls).toBe(1);
    expect(["PASS", "FAIL"]).toContain(report.verdict);

    const scoreRes = await client.callTool({
      name: "get_score",
      arguments: { session_id: start.sessionId, format: "json" },
    });
    const score = JSON.parse(textOf(scoreRes)) as {
      score: { overall: number; recoveryRate: number; breakdown: { injectedErrors: number } };
      patches: Array<{ category: string }>;
    };
    expect(score.score.overall).toBeGreaterThanOrEqual(0);
    expect(score.score.overall).toBeLessThanOrEqual(100);
    // The one F1 call above injected a TIMEOUT that was never followed up on
    // within this session — real session scoring (not the CLI's scripted
    // benchmark) must reflect that as an unrecovered error, not a canned 100%.
    expect(score.score.breakdown.injectedErrors).toBe(1);
    expect(score.score.recoveryRate).toBe(0);

    const scenariosRes = await client.callTool({ name: "list_scenarios", arguments: {} });
    const scenarios = JSON.parse(textOf(scenariosRes)) as Array<{ id: string }>;
    expect(scenarios.map((s) => s.id)).toEqual(["F1", "F2", "F3", "F4", "F5"]);

    const deleteRes = await client.callTool({
      name: "delete_session",
      arguments: { session_id: start.sessionId },
    });
    expect(deleteRes.isError).toBeFalsy();
    expect(textOf(deleteRes)).toContain("deleted");
  });

  it("returns an MCP error result for an unknown session instead of crashing the server", async () => {
    const res = await client.callTool({
      name: "execute_call",
      arguments: {
        session_id: "00000000-0000-0000-0000-000000000000",
        tool_name: "write_payment",
        arguments: {},
      },
    });
    expect(res.isError).toBe(true);
    // The process must still be alive for the next call — proves the server
    // caught the error itself instead of (crashing and) letting it bubble.
    const tools = await client.listTools();
    expect(tools.tools.length).toBeGreaterThan(0);
  });
});
