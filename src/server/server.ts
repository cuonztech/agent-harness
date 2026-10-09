import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StartSessionSchema,
  ExecuteCallSchema,
  GetReportSchema,
  ListScenariosSchema,
  ResetSessionSchema,
  DeleteSessionSchema,
} from "../tools/schemas.js";
import {
  handleStartSession,
  handleExecuteCall,
  handleGetReport,
  handleListScenarios,
  handleResetSession,
  handleDeleteSession,
} from "../tools/handlers.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "cuonztech-agent-harness",
    version: "0.1.0",
  });

  // Tool: start_session
  server.registerTool(
    "start_session",
    {
      title: "Start Test Session",
      description:
        "Creates an isolated test session with optional scenario (F1–F5) and mode (deterministic/chaos). Returns a sessionId for subsequent calls.",
      inputSchema: StartSessionSchema,
    },
    async (args) => handleStartSession(args),
  );

  // Tool: execute_call
  server.registerTool(
    "execute_call",
    {
      title: "Execute Tracked Call",
      description:
        "Executes a tool call within an active session. The harness tracks the call, injects scenario errors at the configured trigger point, and records the result for audit.",
      inputSchema: ExecuteCallSchema,
    },
    async (args) => handleExecuteCall(args),
  );

  // Tool: get_report
  server.registerTool(
    "get_report",
    {
      title: "Get Audit Report",
      description:
        "Generates the audit report for a session. Returns markdown (chat-friendly) or JSON. Also persists JSON to .cuonztech/audit-report.json.",
      inputSchema: GetReportSchema,
    },
    async (args) => handleGetReport(args),
  );

  // Tool: list_scenarios
  server.registerTool(
    "list_scenarios",
    {
      title: "List Available Scenarios",
      description:
        "Returns all available deterministic failure scenarios (F1–F5) with descriptions and audit metrics.",
      inputSchema: ListScenariosSchema,
    },
    async () => handleListScenarios(),
  );

  // Tool: reset_session
  server.registerTool(
    "reset_session",
    {
      title: "Reset Session",
      description:
        "Resets a session's call counter and history without deleting it. Useful for re-running the same scenario.",
      inputSchema: ResetSessionSchema,
    },
    async (args) => handleResetSession(args),
  );

  // Tool: delete_session
  server.registerTool(
    "delete_session",
    {
      title: "Delete Session",
      description: "Permanently deletes a session and its state.",
      inputSchema: DeleteSessionSchema,
    },
    async (args) => handleDeleteSession(args),
  );

  return server;
}