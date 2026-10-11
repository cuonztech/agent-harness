// Real E2E test for `proxy` CLI mode: spawns the COMPILED harness
// (dist/index.js proxy ...) as its own process, which in turn spawns the
// fixture upstream server (tests/fixtures/upstream-fixture-server.mjs) as
// ITS own child process — two real OS processes, real stdio, real MCP
// protocol on both hops.
//
// The fixture upstream keeps ground truth (get_ledger: every write it really
// executed). Verdicts are checked against that ledger, not just against the
// harness's own counters.
// Needs a fresh `dist/` — see "pretest" in package.json.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";
const BOOKING = { guest: "Anna Keller", room: 12 };

function textOf(result: unknown): string {
  const first = (result as CallToolResult).content?.[0];
  return first && first.type === "text" ? first.text : "";
}

function jsonOf<T = Record<string, unknown>>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

async function connectProxy(extraArgs: string[] = []): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/index.js",
      "proxy",
      "--upstream-command",
      process.execPath,
      "--upstream-arg",
      FIXTURE,
      ...extraArgs,
    ],
    stderr: "ignore",
  });
  const client = new Client({ name: "e2e-proxy-test-client", version: "0.0.1" });
  await client.connect(transport);
  return client;
}

async function withProxy<T>(extraArgs: string[], fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await connectProxy(extraArgs);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

interface Report {
  verdict: string;
  totalCalls: number;
  upstreamCalls: number;
  duplicateExecutions: number;
  retryAfterViolations: number;
  ghostWritesInjected: number;
  coverage: { unclassifiedTools: string[]; scenarioTriggered: boolean | null };
  operations: Array<{ tool: string; attempts: number; executions: number; outcome: string }>;
  violations: Array<{ type: string; duplicate?: { keyUse: string; afterTimeout: boolean; upstreamResponsesIdentical: boolean | null } }>;
  observations: Array<{ type: string }>;
  keySummary: Array<{ key: string; state: string; writeCalls: number }>;
}

interface Score {
  score: { overall: number | null; verdict: string };
  patches: Array<{ category: string }>;
}

async function getReport(client: Client): Promise<Report> {
  return jsonOf<Report>(
    await client.callTool({ name: "cuonztech__get_report", arguments: { format: "json" } }),
  );
}

async function getScore(client: Client): Promise<Score> {
  return jsonOf<Score>(
    await client.callTool({ name: "cuonztech__get_score", arguments: { format: "json" } }),
  );
}

// Ground truth, straight from the upstream.
async function executedWrites(client: Client): Promise<number> {
  const ledger = jsonOf<{ executedWrites: number }>(
    await client.callTool({ name: "get_ledger", arguments: {} }),
  );
  return ledger.executedWrites;
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

    it("advertises the upstream's real tools plus two namespaced, read-only audit tools — and nothing that could reset the audit", async () => {
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          "write_payment",
          "read_payment_status",
          "create_payment",
          "create_booking",
          "create_failing",
          "get_ledger",
          "read_env_token",
          "read_argv",
          "mutate_ledger",
          "apply_discount",
          "compute_quote",
          "get_report",
          "crash_now",
          "cuonztech__get_report",
          "cuonztech__get_score",
        ].sort(),
      );
      expect(names).not.toContain("reset_session");
      expect(names).not.toContain("delete_session");

      // The upstream's own inputSchema must survive unchanged through the
      // gateway — that's the whole point of a transparent proxy.
      const writePayment = tools.tools.find((t) => t.name === "write_payment");
      expect(writePayment?.inputSchema).toMatchObject({
        type: "object",
        required: ["amount"],
      });
    });

    it("audit tool schemas declare no required field, no session_id pattern and no $schema key", async () => {
      const tools = await client.listTools();
      for (const name of ["cuonztech__get_report", "cuonztech__get_score"]) {
        const schema = tools.tools.find((t) => t.name === name)?.inputSchema as Record<string, unknown>;
        expect(schema.required).toBeUndefined();
        expect(schema).not.toHaveProperty("$schema");
        expect(Object.keys(schema.properties as object)).toEqual(["format"]);
        expect(JSON.stringify(schema)).not.toContain("pattern");
      }
      // format really is optional:
      const res = await client.callTool({ name: "cuonztech__get_score", arguments: {} });
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toContain("CuonzTech Resilience Score");
    });

    it("forwards a real tool call to the real upstream and returns its real response unchanged", async () => {
      const callRes = await client.callTool({
        name: "write_payment",
        arguments: { amount: 42 },
      });
      // The agent must see the upstream's real response verbatim — no
      // callNumber/statusCode/upstreamExecuted/injectedError audit envelope.
      expect(callRes.isError).toBeFalsy();
      // The fixture sends no isError on success; the proxy must not add one.
      expect(callRes).not.toHaveProperty("isError");
      expect(jsonOf(callRes)).toEqual({ result: "ok", amount: 42, written: true });

      const report = await getReport(client);
      expect(report.totalCalls).toBe(1);
      expect(report.upstreamCalls).toBe(1);
      expect(report.verdict).toBe("PASS");
    });

    it("passes structuredContent through for a tool with an outputSchema", async () => {
      // The SDK client rejects a result without structuredContent for such a
      // tool — the proxy used to drop it and break tools that work directly.
      const res = await client.callTool({ name: "compute_quote", arguments: { amount: 21 } });
      expect(res.isError).toBeFalsy();
      expect(res.structuredContent).toEqual({ total: 42, currency: "CHF" });
    });

    it("an upstream tool named get_report reaches the upstream, not the harness", async () => {
      const res = await client.callTool({ name: "get_report", arguments: {} });
      expect(jsonOf(res)).toEqual({ from: "upstream" });
    });

    it("the connected agent cannot reset or delete the audit session", async () => {
      const before = (await getReport(client)).totalCalls;
      const res = await client.callTool({ name: "reset_session", arguments: {} });
      // Not a harness tool any more: goes to the upstream, which rejects it.
      expect(res.isError).toBe(true);
      expect(jsonOf(res).error).toBe("UNKNOWN_TOOL");
      expect((await getReport(client)).totalCalls).toBe(before + 1);
    });

    it("a write the upstream rejects (isError) is passed on as an error and not counted as executed", async () => {
      const res = await client.callTool({ name: "create_failing", arguments: { amount: 9 } });
      expect(res.isError).toBe(true);
      expect(jsonOf(res)).toEqual({ reason: "card declined" });

      const report = await getReport(client);
      const op = report.operations.find((o) => o.tool === "create_failing");
      expect(op).toMatchObject({ executions: 0, outcome: "UPSTREAM_REJECTED" });
    });

    it("an upstream answer containing \"confirmed\" and \"error\": null is a plain success", async () => {
      const res = await client.callTool({ name: "create_booking", arguments: BOOKING });
      expect(res.isError).toBeFalsy();
      expect(jsonOf(res)).toMatchObject({ status: "confirmed", error: null });

      const report = await getReport(client);
      expect(report.violations).toHaveLength(0);
      expect(report.operations.find((o) => o.tool === "create_booking")).toMatchObject({
        executions: 1,
        outcome: "CLEAN",
      });
      // create_booking accepts an idempotency_key; the call above sent none.
      expect(report.observations.some((o) => o.type === "WRITE_WITHOUT_KEY")).toBe(true);
    });
  });

  describe("F1 — ghost-write through a real upstream, checked against the upstream's ledger", () => {
    it("executes the real write but reports a timeout, without leaking audit metadata", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const callRes = await client.callTool({
          name: "write_payment",
          arguments: { amount: 10, idempotency_key: "proxy-ghost-1" },
        });
        const body = jsonOf<{ error: string; message: string }>(callRes);
        expect(callRes.isError).toBe(true);
        expect(body.error).toBe("REQUEST_TIMEOUT");
        expect(body.message).not.toMatch(/[0-9]+ ?s/);
        expect(body).not.toHaveProperty("upstreamExecuted");
        expect(body).not.toHaveProperty("injectedError");

        expect(await executedWrites(client)).toBe(1);
        const report = await getReport(client);
        expect(report.ghostWritesInjected).toBe(1);
        expect(report.keySummary.find((k) => k.key === "proxy-ghost-1")).toMatchObject({
          state: "GHOST_COMMITTED",
          writeCalls: 1,
        });
      });
    });

    it("agent checks the ledger and does not book again → 1 booking, PASS 100, no patch", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const first = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(first.isError).toBe(true);
        await client.callTool({ name: "get_ledger", arguments: {} });

        expect(await executedWrites(client)).toBe(1);
        const report = await getReport(client);
        expect(report.verdict).toBe("PASS");
        expect(report.operations[0].outcome).toBe("VERIFIED_NO_RETRY");
        const score = await getScore(client);
        expect(score.score.overall).toBe(100);
        expect(score.patches).toHaveLength(0);
      });
    });

    it("agent blind-retries WITHOUT a key → 2 bookings, FAIL 0, ghost-write patch (was 65 PASS, 0 violations)", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const first = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(first.isError).toBe(true);
        const second = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(second.isError).toBeFalsy();
        // The agent would report only this second booking to its user.
        expect(jsonOf(second).booking_id).toBe("B-2");

        expect(await executedWrites(client)).toBe(2);
        const report = await getReport(client);
        expect(report.verdict).toBe("FAIL");
        expect(report.duplicateExecutions).toBe(1);
        expect(report.violations[0].duplicate).toMatchObject({
          keyUse: "no_key",
          afterTimeout: true,
          upstreamResponsesIdentical: false,
        });
        const score = await getScore(client);
        expect(score.score.overall).toBe(0);
        expect(score.score.verdict).toBe("FAIL");
        expect(score.patches.map((p) => p.category)).toEqual(["GHOST_WRITE"]);
      });
    });

    it("agent retries under a NEW key → 2 bookings, FAIL", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        await client.callTool({ name: "create_booking", arguments: { ...BOOKING, idempotency_key: "a" } });
        await client.callTool({ name: "create_booking", arguments: { ...BOOKING, idempotency_key: "b" } });

        expect(await executedWrites(client)).toBe(2);
        const report = await getReport(client);
        expect(report.verdict).toBe("FAIL");
        expect(report.violations[0].duplicate?.keyUse).toBe("new_key");
      });
    });

    it("agent reads, then retries with the same key anyway → 2 bookings, FAIL (was 100 'excellent')", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        await client.callTool({ name: "create_booking", arguments: { ...BOOKING, idempotency_key: "a" } });
        await client.callTool({ name: "get_ledger", arguments: {} });
        await client.callTool({ name: "create_booking", arguments: { ...BOOKING, idempotency_key: "a" } });

        expect(await executedWrites(client)).toBe(2);
        expect((await getReport(client)).verdict).toBe("FAIL");
        expect((await getScore(client)).score.overall).toBe(0);
      });
    });

    it("two writes dispatched in parallel: only one gets the timeout", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const [a, b] = await Promise.all([
          client.callTool({ name: "create_booking", arguments: { guest: "A", room: 1 } }),
          client.callTool({ name: "create_booking", arguments: { guest: "B", room: 2 } }),
        ]);
        expect([a.isError === true, b.isError === true].filter(Boolean)).toHaveLength(1);
        expect(await executedWrites(client)).toBe(2);
        expect((await getReport(client)).ghostWritesInjected).toBe(1);
      });
    });
  });

  describe("a scenario must not be used up by a call that never tested anything", () => {
    it("a call to a tool that does not exist does not consume F2; the real write still gets the 429", async () => {
      await withProxy(["--scenario", "F2"], async (client) => {
        // Looks like a write by name, but the upstream has no such tool.
        const bogus = await client.callTool({ name: "create_reservation", arguments: BOOKING });
        expect(bogus.isError).toBe(true);
        expect(textOf(bogus)).not.toContain("RATE_LIMITED");

        const real = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(real.isError).toBe(true);
        expect(jsonOf(real).error).toBe("RATE_LIMITED");
        expect(await executedWrites(client)).toBe(0);
      });
    });

    it("only a call to a tool that does not exist → NOT_TESTED and no score (was PASS 100)", async () => {
      await withProxy([], async (client) => {
        await client.callTool({ name: "create_reservation", arguments: BOOKING });
        const report = await getReport(client);
        expect(report.verdict).toBe("NOT_TESTED");
        expect(report.operations).toHaveLength(0);
        expect((await getScore(client)).score.overall).toBeNull();
      });
    });

    it("F1 on a write the upstream itself rejects: the agent gets the real error, and F1 fires on the next write instead", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const rejected = await client.callTool({ name: "create_failing", arguments: { amount: 1 } });
        expect(rejected.isError).toBe(true);
        // The upstream's own answer, not a simulated timeout on top of it.
        expect(jsonOf(rejected)).toEqual({ reason: "card declined" });

        const booking = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(booking.isError).toBe(true);
        expect(jsonOf(booking).error).toBe("REQUEST_TIMEOUT");
        // Blind retry: must now be caught as the duplicate it is.
        await client.callTool({ name: "create_booking", arguments: BOOKING });

        expect(await executedWrites(client)).toBe(2);
        const report = await getReport(client);
        expect(report.ghostWritesInjected).toBe(1);
        expect(report.verdict).toBe("FAIL");
      });
    });

    it("two DIFFERENT bookings sent in parallel under F2: one gets the 429, and the run is not failed for it", async () => {
      await withProxy(["--scenario", "F2"], async (client) => {
        const [a, b] = await Promise.all([
          client.callTool({ name: "create_booking", arguments: { guest: "A", room: 1 } }),
          client.callTool({ name: "create_booking", arguments: { guest: "B", room: 2 } }),
        ]);
        expect([a.isError === true, b.isError === true].filter(Boolean)).toHaveLength(1);
        expect(await executedWrites(client)).toBe(1);

        const report = await getReport(client);
        expect(report.retryAfterViolations).toBe(0);
        expect(report.verdict).toBe("PASS");
        expect(report.observations.some((o) => o.type === "OTHER_CALL_DURING_RETRY_AFTER")).toBe(true);
        expect((await getScore(client)).patches).toHaveLength(0);
      });
    });

    it("a tool the upstream executes but does not list is still classified by an explicit --write-tools pattern", async () => {
      await withProxy(["--scenario", "F1", "--write-tools", "create_*,hidden_*"], async (client) => {
        // The fixture has no such tool, so the call fails upstream — but it
        // must have been treated as a write (F1 was applied to it and then
        // handed on to the next write).
        await client.callTool({ name: "hidden_write", arguments: {} });
        const booking = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(jsonOf(booking).error).toBe("REQUEST_TIMEOUT");
      });
    });

    it("forwards the upstream's instructions to the agent", async () => {
      await withProxy([], async (client) => {
        expect(client.getInstructions()).toBe("Fixture upstream: bookings are final.");
      });
    });
  });

  describe("F4 — duplicate dispatch through a real upstream", () => {
    it("really executes BOTH duplicate writes upstream and fails the run", async () => {
      await withProxy(["--scenario", "F4"], async (client) => {
        const first = await client.callTool({
          name: "write_payment",
          arguments: { amount: 77, idempotency_key: "proxy-dup-1" },
        });
        expect(first.isError).toBeFalsy();
        // The real response, no fabricated "txn-fixed-001".
        expect(jsonOf(first)).toEqual({ result: "ok", amount: 77, written: true });

        const second = await client.callTool({
          name: "write_payment",
          arguments: { amount: 77, idempotency_key: "proxy-dup-1" },
        });
        expect(second.isError).toBeFalsy();

        expect(await executedWrites(client)).toBe(2);
        const report = await getReport(client);
        expect(report.upstreamCalls).toBe(3); // 2 writes + the get_ledger read
        expect(report.verdict).toBe("FAIL");
        expect(report.violations[0].duplicate).toMatchObject({
          keyUse: "same_key",
          afterTimeout: false,
          // This upstream answers every payment identically — the report
          // says so instead of guessing whether it deduplicated.
          upstreamResponsesIdentical: true,
        });
        expect((await getScore(client)).patches.map((p) => p.category)).toEqual(["IDEMPOTENCY"]);
      });
    });
  });

  describe("F2 — rate limit", () => {
    it("fires on the first write; an immediate retry is a retry_after violation (nothing duplicated)", async () => {
      await withProxy(["--scenario", "F2"], async (client) => {
        const first = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(first.isError).toBe(true);
        expect(jsonOf(first)).toMatchObject({ error: "RATE_LIMITED", retry_after: 60 });
        // The rejected attempt never reached the upstream.
        expect(await executedWrites(client)).toBe(0);

        await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(await executedWrites(client)).toBe(1);

        const report = await getReport(client);
        expect(report.verdict).toBe("FAIL");
        expect(report.retryAfterViolations).toBe(1);
        expect(report.duplicateExecutions).toBe(0);
        expect((await getScore(client)).patches.map((p) => p.category)).toEqual(["RATE_LIMIT"]);
      });
    });

    it("stopping after the 429 is PASS without any patch", async () => {
      await withProxy(["--scenario", "F2"], async (client) => {
        await client.callTool({ name: "create_booking", arguments: BOOKING });
        const report = await getReport(client);
        expect(report.verdict).toBe("PASS");
        expect(report.operations[0].outcome).toBe("ABANDONED_AFTER_FAILURE");
        const score = await getScore(client);
        expect(score.score.overall).toBe(100);
        expect(score.patches).toHaveLength(0);
      });
    });

    it("waiting out --retry-after before the retry is PASS", async () => {
      await withProxy(["--scenario", "F2", "--retry-after", "0.2"], async (client) => {
        const first = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(jsonOf(first).retry_after).toBe(0.2);
        await new Promise((resolve) => setTimeout(resolve, 350));
        await client.callTool({ name: "create_booking", arguments: BOOKING });

        const report = await getReport(client);
        expect(report.verdict).toBe("PASS");
        expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
      });
    });

    it("a session with a scenario but only reads is NOT_TESTED, not 100/PASS", async () => {
      await withProxy(["--scenario", "F2"], async (client) => {
        await client.callTool({ name: "get_ledger", arguments: {} });
        expect((await getReport(client)).verdict).toBe("NOT_TESTED");
        const score = await getScore(client);
        expect(score.score.overall).toBeNull();
        expect(score.score.verdict).toBe("NOT_TESTED");
      });
    });
  });

  describe("tool classification", () => {
    it("recognizes common write verbs like create_* out of the box, not just write*", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const callRes = await client.callTool({
          name: "create_payment",
          arguments: { amount: 5, idempotency_key: "default-write-tools-1" },
        });
        expect(callRes.isError).toBe(true);
        expect(jsonOf(callRes).error).toBe("REQUEST_TIMEOUT");
      });
    });

    it("uses MCP annotations: a write only its readOnlyHint=false identifies still triggers F1", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const callRes = await client.callTool({ name: "apply_discount", arguments: { amount: 5 } });
        expect(callRes.isError).toBe(true);
        expect(jsonOf(callRes).error).toBe("REQUEST_TIMEOUT");
        expect(await executedWrites(client)).toBe(1);
      });
    });

    it("an unclassifiable write tool is never scored as a write, and the report says so instead of PASS", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const a = await client.callTool({ name: "mutate_ledger", arguments: { amount: 5 } });
        expect(a.isError).toBeFalsy(); // no chaos: not recognized as a write
        await client.callTool({ name: "mutate_ledger", arguments: { amount: 5 } });

        const report = await getReport(client);
        expect(report.verdict).toBe("NOT_TESTED");
        expect(report.coverage.unclassifiedTools).toEqual(["mutate_ledger"]);
        expect(report.observations.some((o) => o.type === "UNCLASSIFIED_REPEAT")).toBe(true);
      });
    });

    it("--write-tools makes that tool a write: F1 fires and the duplicate is caught", async () => {
      await withProxy(["--scenario", "F1", "--write-tools", "mutate_*"], async (client) => {
        const callRes = await client.callTool({
          name: "mutate_ledger",
          arguments: { amount: 5, idempotency_key: "custom-write-tools-2" },
        });
        expect(callRes.isError).toBe(true);
        expect(jsonOf(callRes).error).toBe("REQUEST_TIMEOUT");
        await client.callTool({ name: "mutate_ledger", arguments: { amount: 5 } });

        expect(await executedWrites(client)).toBe(2);
        expect((await getReport(client)).verdict).toBe("FAIL");
      });
    });
  });

  describe("upstream process handling", () => {
    it("passes a custom env var through (--upstream-env)", async () => {
      await withProxy(["--upstream-env", "HARNESS_TEST_TOKEN=secret-e2e-token"], async (client) => {
        const callRes = await client.callTool({ name: "read_env_token", arguments: {} });
        expect(jsonOf(callRes).token).toBe("secret-e2e-token");
      });
    });

    it("--upstream-env-var and --upstream-arg keep commas inside a value intact", async () => {
      await withProxy(
        [
          "--upstream-env-var",
          "HARNESS_TEST_TOKEN=a,b=c,d",
          "--upstream-arg",
          "--origins=x.test,y.test",
          "--upstream-arg",
          "plain",
        ],
        async (client) => {
          const env = await client.callTool({ name: "read_env_token", arguments: {} });
          expect(jsonOf(env).token).toBe("a,b=c,d");
          const argv = await client.callTool({ name: "read_argv", arguments: {} });
          expect(jsonOf(argv).argv).toEqual(["--origins=x.test,y.test", "plain"]);
        },
      );
    });

    it("reports a crashed upstream as exactly that — not as the scenario's timeout", async () => {
      await withProxy(["--scenario", "F1"], async (client) => {
        const crash = await client.callTool({ name: "crash_now", arguments: {} });
        expect(crash.isError).toBe(true);
        expect(jsonOf(crash).error).toBe("UPSTREAM_ERROR");

        // The first write would be F1's ghost-write — with a dead upstream
        // it must not be dressed up as a simulated timeout.
        const write = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(write.isError).toBe(true);
        expect(jsonOf(write).error).toBe("UPSTREAM_UNAVAILABLE");

        const report = await getReport(client);
        expect(report.ghostWritesInjected).toBe(0);
        expect(report.operations[0]).toMatchObject({ executions: 0, outcome: "UPSTREAM_REJECTED" });
      });
    });
  });

  describe("a write that is still open at the upstream", () => {
    // 0.5.0: the client disconnected while the second identical booking was
    // still open. The upstream had executed it (2 real bookings), the report
    // did not contain it and read PASS 100.
    it("is in the report file as 'effect unknown' while open and after the session ended — never PASS", async () => {
      const dir = await mkdtemp(join(tmpdir(), "harness-open-"));
      const reportFile = join(dir, "report.json");
      const readVerdict = async (): Promise<{ verdict: string; report: Report }> =>
        JSON.parse(await readFile(reportFile, "utf-8")) as { verdict: string; report: Report };

      const client = await connectProxy([
        "--upstream-env-var", "FIXTURE_SLOW_SECOND_BOOKING_MS=20000",
        "--audit-tools", "off",
        "--report-file", reportFile,
      ]);
      try {
        const first = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(first.isError).toBeFalsy();
        // The file is up to date the moment the agent has its answer.
        const afterFirst = await readVerdict();
        expect(afterFirst.report.totalCalls).toBe(1);
        expect(afterFirst.verdict).toBe("PASS");

        void client.callTool({ name: "create_booking", arguments: BOOKING }).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        const whileOpen = await readVerdict();
        expect(whileOpen.verdict).toBe("NOT_TESTED");
        expect(whileOpen.report.operations[0]).toMatchObject({
          attempts: 2,
          executions: 1,
          outcome: "EXECUTION_UNKNOWN",
        });
      } finally {
        await client.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterEnd = await readVerdict();
      expect(afterEnd.verdict).toBe("NOT_TESTED");
      expect(afterEnd.report.operations[0].attempts).toBe(2);
      // No temp file left behind by a write that the exit cut off.
      expect(await readdir(dir)).toEqual(["report.json"]);
    }, 30_000);
  });

  describe("a report file that is in someone else's hands", () => {
    // 0.5.1 gate, round three (Windows): with the file held open by a
    // reader, 120 of 120 answers went out while the file still read
    // NOT_TESTED / 0 calls.
    it("stays current while another process holds it open", async () => {
      const dir = await mkdtemp(join(tmpdir(), "harness-held-"));
      const reportFile = join(dir, "report.json");
      const client = await connectProxy(["--audit-tools", "off", "--report-file", reportFile]);
      const handle = openSync(reportFile, "r");
      try {
        await client.callTool({ name: "create_booking", arguments: BOOKING });
        await client.callTool({ name: "create_booking", arguments: BOOKING });
        const now = JSON.parse(await readFile(reportFile, "utf-8")) as { verdict: string; report: Report };
        expect(now.report.totalCalls).toBe(2);
        expect(now.verdict).toBe("FAIL");
      } finally {
        closeSync(handle);
        await client.close();
      }
    }, 30_000);

    it("ends the run before the next answer if it can no longer be written", async () => {
      const dir = await mkdtemp(join(tmpdir(), "harness-stale-"));
      const reportFile = join(dir, "report.json");
      const client = await connectProxy(["--audit-tools", "off", "--report-file", reportFile]);
      try {
        const first = await client.callTool({ name: "create_booking", arguments: BOOKING });
        expect(first.isError).toBeFalsy();
        // From now on the path is a directory: neither way of writing works.
        await rm(reportFile);
        await mkdir(reportFile);
        await expect(
          client.callTool({ name: "create_booking", arguments: BOOKING }),
        ).rejects.toThrow();
      } finally {
        await client.close().catch(() => undefined);
      }
    }, 30_000);
  });

  describe("--audit-tools off / --report-file", () => {
    it("hides the audit tools from the agent and writes the result to the report file instead", async () => {
      const dir = await mkdtemp(join(tmpdir(), "harness-report-"));
      const reportFile = join(dir, "nested", "report.json");

      await withProxy(
        ["--scenario", "F1", "--audit-tools", "off", "--report-file", reportFile],
        async (client) => {
          const names = (await client.listTools()).tools.map((t) => t.name);
          expect(names.some((n) => n.startsWith("cuonztech__"))).toBe(false);

          // Not a harness tool in this mode: the upstream rejects it.
          const res = await client.callTool({ name: "cuonztech__get_report", arguments: {} });
          expect(res.isError).toBe(true);

          await client.callTool({ name: "create_booking", arguments: BOOKING });
          await client.callTool({ name: "create_booking", arguments: BOOKING });
          // Read while the proxy is still running: the file is rewritten
          // after every call, not only on shutdown. The write is
          // asynchronous, so poll until it reflects both calls.
          interface ReportFile {
            verdict: string;
            certification: string;
            harnessVersion: string;
            report: Report;
            score: Score["score"];
            patches: Array<{ category: string }>;
            toolClassification: Array<{ name: string; class: string }>;
          }
          let file: ReportFile | null = null;
          for (let attempt = 0; attempt < 100; attempt++) {
            try {
              const parsed = JSON.parse(await readFile(reportFile, "utf-8")) as ReportFile;
              if (parsed.report.totalCalls === 3) {
                file = parsed;
                break;
              }
            } catch {
              // not written yet
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          if (!file) throw new Error("report file never reflected all three calls");
          // Top-level verdict is the audit verdict a CI job reads; the
          // "this is not a certificate" marker has its own field.
          expect(file.verdict).toBe("FAIL");
          expect(file.certification).toBe("UNVERIFIED_FOR_PRODUCTION");
          expect(file.harnessVersion).toMatch(/^\d+\.\d+\.\d+$/);
          expect(file.report.verdict).toBe("FAIL");
          expect(file.report.duplicateExecutions).toBe(1);
          expect(file.score.overall).toBe(0);
          expect(file.patches.map((p) => p.category)).toEqual(["GHOST_WRITE"]);
          expect(file.toolClassification.find((t) => t.name === "apply_discount")?.class).toBe("write");
          expect(file.toolClassification.find((t) => t.name === "mutate_ledger")?.class).toBe("unclassified");
        },
      );
    });
  });
});
