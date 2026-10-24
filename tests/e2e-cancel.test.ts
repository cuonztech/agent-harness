// E2E test for cancellation of an in-flight tool call through the proxy.
// The proxy forwards the client's cancellation to the upstream. Whether the
// write is then prevented depends on the upstream: an upstream that honors
// cancellation (FIXTURE_HONOR_CANCEL=1) executes nothing; one that ignores it
// still executes the write, which is the documented product boundary.
// Needs a fresh `dist/` — see "pretest" in package.json.
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";
const BOOKING = { guest: "Anna Keller", room: 12 };
const HOLD_MS = 800;

function jsonOf(result: unknown): Record<string, unknown> {
  const first = (result as CallToolResult).content?.[0];
  return JSON.parse(first && first.type === "text" ? first.text : "{}") as Record<string, unknown>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function connectProxy(upstreamEnv: string[]): Promise<Client> {
  const extraArgs = upstreamEnv.flatMap((pair) => ["--upstream-env-var", pair]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/index.js",
      "proxy",
      "--upstream-command",
      process.execPath,
      "--upstream-arg",
      FIXTURE,
      "--audit-tools",
      "off",
      ...extraArgs,
    ],
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e-cancel-test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

// Sends a write, cancels it while the upstream still holds it, waits past the
// hold, then reads the upstream's ground-truth ledger.
async function cancelledWriteExecutions(upstreamEnv: string[]): Promise<number> {
  const client = await connectProxy(upstreamEnv);
  try {
    const controller = new AbortController();
    const pending = client
      .callTool({ name: "create_booking", arguments: BOOKING }, undefined, { signal: controller.signal })
      .catch(() => undefined);
    await sleep(150);
    controller.abort();
    await pending;
    await sleep(HOLD_MS + 400);
    const ledger = jsonOf(await client.callTool({ name: "get_ledger", arguments: {} }));
    return Number(ledger.executedWrites);
  } finally {
    await client.close();
  }
}

describe("cancelling an in-flight write", () => {
  it("executes nothing when the upstream honors the cancellation", async () => {
    const executed = await cancelledWriteExecutions([
      `FIXTURE_HOLD_BEFORE_WRITE_MS=${HOLD_MS}`,
      "FIXTURE_HONOR_CANCEL=1",
    ]);
    expect(executed).toBe(0);
  }, 30_000);

  it("documents the boundary: an upstream that ignores cancellation still executes the write", async () => {
    const executed = await cancelledWriteExecutions([`FIXTURE_HOLD_BEFORE_WRITE_MS=${HOLD_MS}`]);
    expect(executed).toBe(1);
  }, 30_000);
});
