// Builds the MCP server exposed in `proxy` CLI mode: a transparent gateway
// that advertises the upstream server's real tools (unchanged, discovered
// via ProxyInterceptor) plus a handful of the harness's own audit tools
// scoped to the proxy's single session. Uses the low-level Server class
// instead of McpServer because upstream tool schemas arrive as raw JSON
// Schema (from the upstream's own `listTools()`), not Zod — McpServer's
// `registerTool` only accepts a Zod raw shape.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ProxyInterceptor } from "./interceptor.js";
import {
  GetReportSchema,
  GetScoreSchema,
  ListScenariosSchema,
  ResetSessionSchema,
  DeleteSessionSchema,
} from "../tools/schemas.js";
import {
  handleGetReport,
  handleGetScore,
  handleListScenarios,
  handleResetSession,
  handleDeleteSession,
} from "../tools/handlers.js";

// session_id is required in the shared schemas (used by the multi-session
// stdio server), but a proxy only ever has one session — its own. This
// override makes it optional so the proxy's CallTool handler can default it
// to `interceptor.sessionId` without touching the shared schemas.
function optionalSessionId(
  schema: Record<string, z.ZodTypeAny>,
): Record<string, z.ZodTypeAny> {
  return { ...schema, session_id: schema.session_id.optional() };
}

const OWN_TOOLS = {
  get_report: {
    title: "Get Audit Report",
    description:
      "Generates the audit report for this proxy session. Returns markdown (chat-friendly) or JSON.",
    schema: optionalSessionId(GetReportSchema),
  },
  get_score: {
    title: "Get Resilience Score",
    description:
      "Scores this proxy session's own audit report (0-100) and generates system-prompt hardening patches for whatever violations the connected agent actually produced.",
    schema: optionalSessionId(GetScoreSchema),
  },
  list_scenarios: {
    title: "List Available Scenarios",
    description:
      "Returns all available deterministic failure scenarios (F1–F5) with descriptions and audit metrics.",
    schema: ListScenariosSchema,
  },
  reset_session: {
    title: "Reset Session",
    description:
      "Resets this proxy session's call counter and history without deleting it.",
    schema: optionalSessionId(ResetSessionSchema),
  },
  delete_session: {
    title: "Delete Session",
    description: "Permanently deletes this proxy session's state.",
    schema: optionalSessionId(DeleteSessionSchema),
  },
} as const;

type OwnToolName = keyof typeof OWN_TOOLS;

function isOwnTool(name: string): name is OwnToolName {
  return name in OWN_TOOLS;
}

export function createProxyServer(interceptor: ProxyInterceptor): Server {
  const server = new Server(
    { name: "cuonztech-agent-harness-proxy", version: "0.3.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstreamDefs = interceptor.getUpstreamTools();
    const ownDefs = (Object.keys(OWN_TOOLS) as OwnToolName[]).map((name) => {
      const tool = OWN_TOOLS[name];
      return {
        name,
        title: tool.title,
        description: tool.description,
        inputSchema: z.toJSONSchema(z.object(tool.schema)),
      };
    });
    return { tools: [...upstreamDefs, ...ownDefs] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const toolArgs = (rawArgs ?? {}) as Record<string, unknown>;

    if (isOwnTool(name)) {
      const withSession = {
        session_id: interceptor.sessionId,
        ...toolArgs,
      };
      switch (name) {
        case "get_report":
          return handleGetReport(withSession as Parameters<typeof handleGetReport>[0]);
        case "get_score":
          return handleGetScore(withSession as Parameters<typeof handleGetScore>[0]);
        case "list_scenarios":
          return handleListScenarios();
        case "reset_session":
          return handleResetSession(withSession as Parameters<typeof handleResetSession>[0]);
        case "delete_session":
          return handleDeleteSession(withSession as Parameters<typeof handleDeleteSession>[0]);
      }
    }

    return interceptor.interceptToolCall(name, toolArgs);
  });

  return server;
}
