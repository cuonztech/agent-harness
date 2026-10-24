#!/usr/bin/env node
// Minimal real MCP server used as the "upstream" in proxy e2e tests. Plain
// JS (no build step) so ProxyInterceptor can spawn it directly via stdio,
// exactly like it would spawn a real production MCP server.
//
// It keeps GROUND TRUTH: every write that really executes is appended to a
// ledger, readable through get_ledger. Tests compare the harness's verdict
// with that ledger instead of trusting the harness's own bookkeeping. None
// of the write tools is idempotent — a repeated call is a second execution.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fixture-upstream", version: "0.0.1" },
  { capabilities: { tools: {} }, instructions: "Fixture upstream: bookings are final." },
);

const ledger = [];

const amountSchema = {
  type: "object",
  properties: { amount: { type: "number" } },
  required: ["amount"],
};

const tools = [
  {
    name: "write_payment",
    description: "Writes a payment (fixture upstream).",
    inputSchema: amountSchema,
  },
  {
    name: "read_payment_status",
    description: "Reads payment status (fixture upstream).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_payment",
    description: "Writes a payment under a non-'write'-prefixed name.",
    inputSchema: amountSchema,
  },
  {
    name: "create_booking",
    description: "Books a room and charges the card. Not idempotent. Accepts an optional idempotency_key (ignored).",
    inputSchema: {
      type: "object",
      properties: {
        guest: { type: "string" },
        room: { type: "number" },
        idempotency_key: { type: "string" },
      },
      required: ["guest", "room"],
    },
  },
  {
    name: "create_failing",
    description: "A write the upstream always rejects with isError.",
    inputSchema: amountSchema,
  },
  {
    name: "get_ledger",
    description: "Ground truth: every write this upstream really executed.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_env_token",
    description: "Echoes an env var (for --upstream-env tests).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_argv",
    description: "Echoes the arguments this process was started with.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mutate_ledger",
    description: "Writes under a name outside every default pattern, without annotations.",
    inputSchema: amountSchema,
  },
  {
    name: "apply_discount",
    description: "A write that only its MCP annotation identifies as one.",
    inputSchema: amountSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "compute_quote",
    description: "A read that only its MCP annotation identifies as one; returns structuredContent.",
    inputSchema: amountSchema,
    outputSchema: {
      type: "object",
      properties: { total: { type: "number" }, currency: { type: "string" } },
      required: ["total", "currency"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_report",
    description: "An upstream tool that happens to share a name with the harness's former audit tool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "crash_now",
    description: "Kills the upstream process.",
    inputSchema: { type: "object", properties: {} },
  },
];

if (process.env.FIXTURE_COLLIDE === "1") {
  tools.push({
    name: "cuonztech__get_score",
    description: "Collides with the harness's own audit tool.",
    inputSchema: { type: "object", properties: {} },
  });
}

// FIXTURE_PAGINATE=1: hand the tool list out two at a time, like a real
// server with many tools may.
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (process.env.FIXTURE_PAGINATE !== "1") return { tools };
  const start = request.params?.cursor ? Number(request.params.cursor) : 0;
  const end = start + 2;
  return {
    tools: tools.slice(start, end),
    ...(end < tools.length ? { nextCursor: String(end) } : {}),
  };
});

function text(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "write_payment":
    case "create_payment":
    case "mutate_ledger":
    case "apply_discount":
      ledger.push({ tool: name, args });
      return text({ result: "ok", amount: args?.amount ?? null, written: true });

    case "create_booking": {
      // FIXTURE_HOLD_BEFORE_WRITE_MS: the write waits this long before it is
      // executed. FIXTURE_HONOR_CANCEL=1: a call cancelled meanwhile is not
      // executed at all (MCP cancellation is a SHOULD, not a guarantee).
      const holdMs = Number(process.env.FIXTURE_HOLD_BEFORE_WRITE_MS ?? 0);
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      if (process.env.FIXTURE_HONOR_CANCEL === "1" && extra.signal.aborted) {
        throw new Error("cancelled before write");
      }
      ledger.push({ tool: name, args });
      const bookings = ledger.filter((e) => e.tool === "create_booking").length;
      // FIXTURE_SLOW_SECOND_BOOKING_MS: from the second booking on, the write
      // is executed at once but the answer is held back — a call that is
      // still open when the client goes away.
      const slowMs = Number(process.env.FIXTURE_SLOW_SECOND_BOOKING_MS ?? 0);
      if (slowMs > 0 && bookings >= 2) {
        await new Promise((resolve) => setTimeout(resolve, slowMs));
      }
      return text({ status: "confirmed", booking_id: `B-${bookings}`, error: null });
    }

    case "create_failing":
      return { ...text({ reason: "card declined" }), isError: true };

    case "get_ledger":
      return text({ executedWrites: ledger.length, ledger });

    case "read_payment_status":
      return text({ status: "committed" });

    case "read_env_token":
      return text({ token: process.env.HARNESS_TEST_TOKEN ?? null });

    case "read_argv":
      return text({ argv: process.argv.slice(2) });

    case "compute_quote": {
      const quote = { total: (args?.amount ?? 0) * 2, currency: "CHF" };
      return { ...text(quote), structuredContent: quote };
    }

    case "get_report":
      return text({ from: "upstream" });

    case "crash_now":
      process.stderr.write("fixture upstream: fatal: simulated crash\n");
      process.exit(3);
  }

  return { ...text({ error: "UNKNOWN_TOOL", name }), isError: true };
});

const transport = new StdioServerTransport();
await server.connect(transport);
