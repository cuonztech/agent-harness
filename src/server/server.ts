import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z, type ZodRawShape } from "zod";
import { VERSION } from "../version.js";
import {
  StartSessionSchema,
  ExecuteCallSchema,
  GetReportSchema,
  GetScoreSchema,
  ListScenariosSchema,
  ResetSessionSchema,
  DeleteSessionSchema,
} from "../tools/schemas.js";
import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
  handleGetScore,
  handleListScenarios,
  handleResetSession,
  handleDeleteSession,
} from "../tools/handlers.js";

// Keywords that strict tool-calling stacks (vLLM/XGrammar and others) reject
// or cannot compile. They add nothing here: the arguments are validated by
// the Zod schemas when the tool is called.
const DROPPED_SCHEMA_KEYS = new Set(["$schema", "pattern", "format", "propertyNames"]);

function plainSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plainSchema);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    // "properties" maps argument names to schemas: an argument may itself
    // be called "format" and must not be dropped.
    if (key === "properties" && child !== null && typeof child === "object") {
      out[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([name, schema]) => [
          name,
          plainSchema(schema),
        ]),
      );
      continue;
    }
    if (key === "additionalProperties" && child !== null && typeof child === "object" &&
        Object.keys(child).length === 0) {
      out[key] = true;
      continue;
    }
    out[key] = plainSchema(child);
  }
  return out;
}

interface ListedTool {
  name: string;
  title: string;
  description: string;
  inputSchema: ZodRawShape;
}

export function createServer(): McpServer {
  const listed: ListedTool[] = [];
  const server = new McpServer({
    name: "cuonztech-agent-harness",
    version: VERSION,
  });
  // Passes a tool's config through unchanged and keeps it for the
  // hand-built tools/list below.
  const keep = <Shape extends ZodRawShape>(
    name: string,
    config: { title: string; description: string; inputSchema: Shape },
  ): { title: string; description: string; inputSchema: Shape } => {
    listed.push({ name, ...config });
    return config;
  };

  // Tool: start_session
  server.registerTool(
    "start_session",
    keep("start_session", {
      title: "Start Test Session",
      description:
        "Creates an isolated test session with optional scenario (F1–F5) and mode (deterministic/chaos). Returns a sessionId for subsequent calls. Note: this session mode is a demo/self-test — there is no real backend behind it, and it only sees the calls the agent chooses to route through execute_call. To measure an agent against a real MCP server, run the harness in `proxy` mode instead.",
      inputSchema: StartSessionSchema,
    }),
    async (args) => handleStartSession(args),
  );

  // Tool: execute_call
  server.registerTool(
    "execute_call",
    keep("execute_call", {
      title: "Execute Tracked Call",
      description:
        "Executes a tool call within an active session against a simulated backend. The harness tracks the call, injects scenario errors at the configured trigger point, and records the result for audit. Reads return a generic ok without data.",
      inputSchema: ExecuteCallSchema,
    }),
    async (args) => handleExecuteCall(args),
  );

  // Tool: get_report
  server.registerTool(
    "get_report",
    keep("get_report", {
      title: "Get Audit Report",
      description:
        "Generates the audit report for a session. Returns markdown (chat-friendly) or JSON. Also persists JSON to .cuonztech/audit-report.json.",
      inputSchema: GetReportSchema,
    }),
    async (args) => handleGetReport(args),
  );

  // Tool: get_score
  server.registerTool(
    "get_score",
    keep("get_score", {
      title: "Get Resilience Score",
      description:
        "Scores THIS session's own audit report (0-100: Duplicate Safety 60%, Failure Handling 40%; honesty is not measured) and generates copy-pasteable system-prompt hardening patches for whatever violations the session actually produced. Returns n/a instead of a score when nothing was tested. Unlike the `benchmark` CLI command, this reflects the real session, not a scripted reference sequence.",
      inputSchema: GetScoreSchema,
    }),
    async (args) => handleGetScore(args),
  );

  // Tool: list_scenarios
  server.registerTool(
    "list_scenarios",
    keep("list_scenarios", {
      title: "List Available Scenarios",
      description:
        "Returns all available deterministic failure scenarios (F1–F5) with descriptions and audit metrics.",
      inputSchema: ListScenariosSchema,
    }),
    async () => handleListScenarios(),
  );

  // Tool: reset_session
  server.registerTool(
    "reset_session",
    keep("reset_session", {
      title: "Reset Session",
      description:
        "Resets a session's call counter and history without deleting it. Useful for re-running the same scenario.",
      inputSchema: ResetSessionSchema,
    }),
    async (args) => handleResetSession(args),
  );

  // Tool: delete_session
  server.registerTool(
    "delete_session",
    keep("delete_session", {
      title: "Delete Session",
      description: "Permanently deletes a session and its state.",
      inputSchema: DeleteSessionSchema,
    }),
    async (args) => handleDeleteSession(args),
  );

  // The SDK's generated tools/list carries "$schema", a UUID "pattern" and
  // "format" on every session_id, "propertyNames" and an "execution" block.
  // An external test lost 69 of 100 runs to a tool-calling stack that could
  // not compile those. This replaces the listing only; calls still go
  // through the SDK's own handler and Zod validation.
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listed.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: plainSchema(
        z.toJSONSchema(z.object(tool.inputSchema), { io: "input" }),
      ) as { type: "object"; properties?: Record<string, object> },
    })),
  }));

  return server;
}