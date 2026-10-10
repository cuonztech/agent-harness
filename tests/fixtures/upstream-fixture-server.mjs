#!/usr/bin/env node
// Minimal real MCP server used as the "upstream" in proxy e2e tests. Plain
// JS (no build step) so ProxyInterceptor can spawn it directly via stdio,
// exactly like it would spawn a real production MCP server.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "fixture-upstream", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "write_payment",
      description: "Writes a payment (fixture upstream).",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
    },
    {
      name: "read_payment_status",
      description: "Reads payment status (fixture upstream).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "create_payment",
      description: "Writes a payment under a non-'write'-prefixed name (fixture upstream, for --write-tools tests).",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
    },
    {
      name: "read_env_token",
      description: "Echoes an env var (fixture upstream, for --upstream-env tests).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "mutate_ledger",
      description: "Writes under a name outside the default write-tool patterns (fixture upstream, for --write-tools tests).",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "write_payment" || name === "create_payment" || name === "mutate_ledger") {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ result: "ok", amount: args?.amount ?? null, written: true }),
        },
      ],
    };
  }

  if (name === "read_payment_status") {
    return {
      content: [{ type: "text", text: JSON.stringify({ status: "committed" }) }],
    };
  }

  if (name === "read_env_token") {
    return {
      content: [
        { type: "text", text: JSON.stringify({ token: process.env.HARNESS_TEST_TOKEN ?? null }) },
      ],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify({ error: "UNKNOWN_TOOL" }) }],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
