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
          "create_payment",
          "read_env_token",
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

    it("forwards a real tool call to the real upstream and returns its real response unchanged", async () => {
      const callRes = await client.callTool({
        name: "write_payment",
        arguments: { amount: 42 },
      });
      // The agent must see the upstream's real response verbatim — no
      // callNumber/statusCode/upstreamExecuted/injectedError audit envelope.
      const body = JSON.parse(textOf(callRes)) as {
        result: string;
        amount: number;
        written: boolean;
      };
      expect(callRes.isError).toBe(false);
      expect(body.amount).toBe(42);
      expect(body.written).toBe(true);
      expect(body).not.toHaveProperty("upstreamExecuted");
      expect(body).not.toHaveProperty("callNumber");

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

    it("executes the real upstream write but reports a timeout to the caller, without leaking audit metadata", async () => {
      const callRes = await client.callTool({
        name: "write_payment",
        arguments: { amount: 10, idempotency_key: "proxy-ghost-1" },
      });
      // The agent must see a realistic timeout error body — not the real
      // upstream response, and not an envelope revealing that upstream
      // actually executed the write behind the scenes.
      const body = JSON.parse(textOf(callRes)) as { error: string; message: string };
      expect(callRes.isError).toBe(true);
      expect(body.error).toBe("REQUEST_TIMEOUT");
      expect(body).not.toHaveProperty("upstreamExecuted");
      expect(body).not.toHaveProperty("injectedError");

      // The real execution IS tracked internally, just not shown to the agent.
      const reportRes = await client.callTool({ name: "get_report", arguments: { format: "json" } });
      const report = JSON.parse(textOf(reportRes)) as { upstreamCalls: number };
      expect(report.upstreamCalls).toBe(1);

      const scoreRes = await client.callTool({ name: "get_score", arguments: { format: "json" } });
      const score = JSON.parse(textOf(scoreRes)) as { score: { overall: number } };
      expect(score.score.overall).toBeGreaterThanOrEqual(0);
      expect(score.score.overall).toBeLessThanOrEqual(100);
    });

    it("counts writeCalls correctly and keeps the key GHOST_COMMITTED through a read + successful retry", async () => {
      // Regression: handleGhostWrite() used to run BEFORE addRecord() in the
      // proxy interceptor, so addRecord() treated the just-created key entry
      // as "existing" — double-counting writeCalls and clobbering the state
      // back to FAILED_DOWNSTREAM via its own isError branch. Order is now
      // addRecord() first, mirroring tools/handlers.ts.
      await client.callTool({
        name: "read_payment_status",
        arguments: {},
      });
      await client.callTool({
        name: "write_payment",
        arguments: { amount: 10, idempotency_key: "proxy-ghost-1" },
      });

      const reportRes = await client.callTool({ name: "get_report", arguments: { format: "json" } });
      const report = JSON.parse(textOf(reportRes)) as {
        keySummary: Array<{ key: string; state: string; writeCalls: number; classification: string }>;
      };
      const entry = report.keySummary.find((k) => k.key === "proxy-ghost-1");
      expect(entry?.state).toBe("GHOST_COMMITTED");
      expect(entry?.writeCalls).toBe(2);
      expect(entry?.classification).toBe("GHOST_CAUGHT");
    });
  });

  describe("F4 scenario (duplicate dispatch through a real upstream)", () => {
    let client: Client;

    beforeAll(async () => {
      client = await connectProxy(["--scenario", "F4"]);
    }, 15_000);

    afterAll(async () => {
      await client?.close();
    });

    it("really executes BOTH duplicate writes upstream instead of fabricating a transaction id", async () => {
      const first = await client.callTool({
        name: "write_payment",
        arguments: { amount: 77, idempotency_key: "proxy-dup-1" },
      });
      const firstBody = JSON.parse(textOf(first)) as { amount: number; written: boolean };
      expect(first.isError).toBe(false);
      expect(firstBody.amount).toBe(77);
      expect(firstBody.written).toBe(true);
      // No fabricated "txn-fixed-001" — the fixture upstream never returns
      // a transaction_id at all, so the real response must not have one.
      expect(firstBody).not.toHaveProperty("transaction_id");

      const second = await client.callTool({
        name: "write_payment",
        arguments: { amount: 77, idempotency_key: "proxy-dup-1" },
      });
      expect(second.isError).toBe(false);

      // Both calls really reached the upstream — the proxy never silently
      // drops a write while telling the agent it succeeded.
      const reportRes = await client.callTool({ name: "get_report", arguments: { format: "json" } });
      const report = JSON.parse(textOf(reportRes)) as {
        upstreamCalls: number;
        keySummary: Array<{ key: string; writeCalls: number; classification: string }>;
      };
      expect(report.upstreamCalls).toBe(2);
      const entry = report.keySummary.find((k) => k.key === "proxy-dup-1");
      expect(entry?.writeCalls).toBe(2);
      // Two real writes to the same key with no error/read in between is a
      // genuine idempotency violation the agent should have avoided.
      expect(entry?.classification).toBe("REDUNDANT_CALL");
    });
  });

  describe("--write-tools (configurable write-tool detection)", () => {
    it("recognizes a non-'write'-prefixed tool as a write when matched by a custom pattern", async () => {
      const client = await connectProxy([
        "--scenario",
        "F1",
        "--write-tools",
        "create_*",
      ]);
      try {
        // create_payment is NOT "write"-prefixed — without --write-tools F1
        // would never trigger on it at all (see src/engine/state-machine.ts
        // isWriteTool default).
        const callRes = await client.callTool({
          name: "create_payment",
          arguments: { amount: 5, idempotency_key: "custom-write-tools-1" },
        });
        const body = JSON.parse(textOf(callRes)) as { error: string };
        expect(callRes.isError).toBe(true);
        expect(body.error).toBe("REQUEST_TIMEOUT");

        const reportRes = await client.callTool({ name: "get_report", arguments: { format: "json" } });
        const report = JSON.parse(textOf(reportRes)) as { upstreamCalls: number };
        // The real upstream write still executed (ghost-write) even though
        // the agent only saw a timeout.
        expect(report.upstreamCalls).toBe(1);
      } finally {
        await client.close();
      }
    });
  });

  describe("--upstream-env (extra env vars for the upstream process)", () => {
    it("passes a custom env var through to the upstream child process", async () => {
      const client = await connectProxy([
        "--upstream-env",
        "HARNESS_TEST_TOKEN=secret-e2e-token",
      ]);
      try {
        const callRes = await client.callTool({ name: "read_env_token", arguments: {} });
        const body = JSON.parse(textOf(callRes)) as { token: string | null };
        expect(body.token).toBe("secret-e2e-token");
      } finally {
        await client.close();
      }
    });
  });
});
