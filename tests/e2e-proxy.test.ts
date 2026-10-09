// Real E2E test for `proxy` CLI mode: spawns the COMPILED harness
// (dist/index.js proxy ...) as its own process, which in turn spawns the
// fixture upstream server (tests/fixtures/upstream-fixture-server.mjs) as
// ITS own child process — two real OS processes, real stdio, real MCP
// protocol on both hops. Proves the gateway actually forwards real tool
// calls to a real upstream, not just the unit-level chaos decision logic
// already covered by tests/proxy.spec.ts.
// Needs a fresh `dist/` — see "pretest" in package.json.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  return first && first.type === "text" ? first.text : "";
}

async function connectProxy(extraArgs: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/index.js",
      "proxy",
      "--upstream-command",
      process.execPath,
      "--upstream-args",
      "tests/fixtures/upstream-fixture-server.mjs",
      ...extraArgs,
    ],
  });
  const client = new Client({ name: "e2e-proxy-test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

describe("MCP proxy mode (two real stdio processes)", () => {
  describe("passthrough (no scenario)", () => {
    let client: Client;

    beforeAll(async () => {
      client = await connectProxy();
    }, 15_000);

    afterAll(async () => {
      await client?.close();
    });

    it("advertises the upstream's real tools plus the harness's audit tools", async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "write_payment",
          "read_payment_status",
          "get_report",
          "get_score",
          "list_scenarios",
          "reset_session",
          "delete_session",
        ].sort(),
      );

      // The upstream's own inputSchema must survive unchanged through the
      // gateway — that's the whole point of a transparent proxy.
      const writePayment = tools.tools.find((t) => t.name === "write_payment");
      expect(writePayment?.inputSchema).toMatchObject({
        type: "object",
        required: ["amount"],
      });
    });

    it("forwards a real tool call to the real upstream and tracks it", async () => {
      const callRes = await client.callTool({
        name: "write_payment",
        arguments: { amount: 42 },
      });
      const body = JSON.parse(textOf(callRes)) as {
        upstreamExecuted: boolean;
        statusCode: number;
        response: { result: string; amount: number; written: boolean };
      };
      expect(callRes.isError).toBe(false);
      expect(body.upstreamExecuted).toBe(true);
      expect(body.statusCode).toBe(200);
      expect(body.response.amount).toBe(42);
      expect(body.response.written).toBe(true);

      const reportRes = await client.callTool({ name: "get_report", arguments: { format: "json" } });
      const report = JSON.parse(textOf(reportRes)) as { totalCalls: number; upstreamCalls: number };
      expect(report.totalCalls).toBe(1);
      expect(report.upstreamCalls).toBe(1);
    });
  });

  describe("F1 scenario (ghost-write through a real upstream)", () => {
    let client: Client;

    beforeAll(async () => {
      client = await connectProxy(["--scenario", "F1"]);
    }, 15_000);

    afterAll(async () => {
      await client?.close();
    });

    it("executes the real upstream write but reports a timeout to the caller", async () => {
      const callRes = await client.callTool({
        name: "write_payment",
        arguments: { amount: 10, idempotency_key: "proxy-ghost-1" },
      });
      const body = JSON.parse(textOf(callRes)) as {
        upstreamExecuted: boolean;
        injectedError: string;
      };
      expect(callRes.isError).toBe(true);
      expect(body.upstreamExecuted).toBe(true);
      expect(body.injectedError).toContain("TIMEOUT");

      const scoreRes = await client.callTool({ name: "get_score", arguments: { format: "json" } });
      const score = JSON.parse(textOf(scoreRes)) as { score: { overall: number } };
      expect(score.score.overall).toBeGreaterThanOrEqual(0);
      expect(score.score.overall).toBeLessThanOrEqual(100);
    });
  });
});
