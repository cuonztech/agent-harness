// Builds the MCP server exposed in `proxy` CLI mode: a transparent gateway
// that advertises the upstream server's real tools (unchanged, discovered
// via ProxyInterceptor) plus — unless switched off — two read-only audit
// tools scoped to the proxy's single session. Uses the low-level Server
// class instead of McpServer because upstream tool schemas arrive as raw
// JSON Schema (from the upstream's own `listTools()`), not Zod.
//
// Only the `tools` capability is proxied. Resources, prompts and
// notifications of the upstream are NOT forwarded (documented limitation).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.js";
import type { ProxyInterceptor } from "./interceptor.js";
import { handleGetReport, handleGetScore } from "../tools/handlers.js";

// Namespaced so they cannot shadow an upstream tool that happens to be
// called get_report/get_score. Deliberately read-only: the agent under test
// shares this tool list, and a reset/delete tool would let it erase its own
// violations. Hide them completely with --audit-tools off and read the
// result from --report-file instead.
export const AUDIT_TOOL_PREFIX = "cuonztech__";

// Written out by hand instead of generated from the shared Zod schemas:
// those mark `format` as required (it has a default) and add a session_id
// with a UUID `pattern` that has no meaning in a single-session proxy.
const FORMAT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    format: {
      type: "string",
      enum: ["markdown", "json"],
      default: "markdown",
      description: "Output format: markdown (default) or json.",
    },
  },
  additionalProperties: false,
};

const OWN_TOOLS = {
  [`${AUDIT_TOOL_PREFIX}get_report`]: {
    title: "Get Audit Report",
    description:
      "CuonzTech Agent-Harness audit tool (not part of the upstream server): returns the audit report for this proxy session as markdown or JSON.",
  },
  [`${AUDIT_TOOL_PREFIX}get_score`]: {
    title: "Get Resilience Score",
    description:
      "CuonzTech Agent-Harness audit tool (not part of the upstream server): scores this proxy session (0-100, or n/a when nothing was tested) and lists system-prompt hardening patches for the violations actually observed.",
  },
} as const;

type OwnToolName = keyof typeof OWN_TOOLS;

function isOwnTool(name: string): name is OwnToolName {
  return Object.prototype.hasOwnProperty.call(OWN_TOOLS, name);
}

// Upstream tools whose name equals one of the harness's own audit tools.
// The proxy refuses to start on a collision rather than silently answering
// such calls itself.
export function findToolNameCollisions(upstreamTools: Tool[]): string[] {
  return upstreamTools.map((t) => t.name).filter((name) => isOwnTool(name));
}

export interface ProxyServerOptions {
  // false = advertise only the upstream's tools (--audit-tools off).
  auditTools?: boolean;
}

export function createProxyServer(
  interceptor: ProxyInterceptor,
  options: ProxyServerOptions = {},
): Server {
  const auditTools = options.auditTools ?? true;
  const instructions = interceptor.getUpstreamInstructions();
  const server = new Server(
    { name: "cuonztech-agent-harness-proxy", version: VERSION },
    { capabilities: { tools: {} }, ...(instructions ? { instructions } : {}) },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const upstreamDefs = interceptor.getUpstreamTools();
    if (!auditTools) return { tools: upstreamDefs };
    const ownDefs = (Object.keys(OWN_TOOLS) as OwnToolName[]).map((name) => ({
      name,
      title: OWN_TOOLS[name].title,
      description: OWN_TOOLS[name].description,
      inputSchema: FORMAT_INPUT_SCHEMA,
      annotations: { readOnlyHint: true },
    }));
    return { tools: [...upstreamDefs, ...ownDefs] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const toolArgs = (rawArgs ?? {}) as Record<string, unknown>;

    if (auditTools && isOwnTool(name)) {
      const rawFormat = toolArgs["format"] ?? "markdown";
      const format = typeof rawFormat === "string" ? rawFormat.toLowerCase() : rawFormat;
      if (format !== "markdown" && format !== "json") {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: format must be "markdown" or "json".`,
            },
          ],
          isError: true,
        };
      }
      const withSession = { session_id: interceptor.sessionId, format } as const;
      if (name === `${AUDIT_TOOL_PREFIX}get_report`) {
        return handleGetReport(withSession, { persist: false });
      }
      return handleGetScore(withSession);
    }

    return interceptor.interceptToolCall(name, toolArgs);
  });

  return server;
}
