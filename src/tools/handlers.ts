import {
  createSession,
  getSession,
  incrementCall,
  addRecord,
  resetSession as resetSessionState,
  deleteSession as deleteSessionState,
  listSessions,
  type CallRecord,
} from "../core/state-engine.js";
import { generateReport, formatMarkdown } from "../core/report-generator.js";
import { getScenarioById, ALL_SCENARIOS } from "../scenarios/f1-f5.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AUDIT_REPORT_PATH = ".cuonztech/audit-report.json";

export function handleStartSession(args: {
  scenario_id?: string;
  mode?: "deterministic" | "chaos";
  error_rate?: number;
}) {
  const scenarioId = args.scenario_id ?? null;
  const mode = args.mode ?? "deterministic";
  const errorRate = args.error_rate ?? 0.0;

  if (scenarioId) {
    const scenario = getScenarioById(scenarioId);
    if (!scenario) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: Unknown scenario "${scenarioId}". Valid: F1–F5.`,
          },
        ],
        isError: true,
      };
    }
  }

  const session = createSession(scenarioId, mode, errorRate);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            sessionId: session.sessionId,
            scenarioId: session.scenarioId,
            mode: session.mode,
            errorRate: session.errorRate,
            message: "Session created. Use this sessionId for all subsequent calls.",
          },
          null,
          2,
        ),
      },
    ],
  };
}

export function handleExecuteCall(args: {
  session_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  idempotency_key?: string;
}) {
  const session = getSession(args.session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: Session "${args.session_id}" not found.`,
        },
      ],
      isError: true,
    };
  }

  const callNumber = incrementCall(args.session_id);

  // Inject idempotency key into args for tracking
  const mergedArgs = { ...args.arguments };
  if (args.idempotency_key) {
    mergedArgs["idempotency_key"] = args.idempotency_key;
  }

  // Determine if scenario triggers an error
  let injectedError: string | null = null;
  let responseBody: Record<string, unknown> | string;
  let statusCode = 200;

  if (session.scenarioId) {
    const scenario = getScenarioById(session.scenarioId);
    if (scenario && scenario.triggerCondition(callNumber, args.tool_name)) {
      const resp = scenario.simulatedResponse;
      // Don't mark "success" type as injected error — F4 simulates successful duplicate dispatches
      injectedError = resp.type === "success" ? null : `[${resp.type.toUpperCase()}]`;
      statusCode = resp.statusCode ?? 500;
      responseBody = resp.body;
    } else {
      responseBody = {
        result: "ok",
        callNumber,
        timestamp: new Date().toISOString(),
      };
    }
  } else if (session.mode === "chaos" && Math.random() < session.errorRate) {
    // Stochastic error injection
    injectedError = "[CHAOS_INJECTED]";
    statusCode = 500;
    responseBody = {
      error: "CHAOS_ERROR",
      message: "Stochastically injected failure.",
    };
  } else {
    responseBody = {
      result: "ok",
      callNumber,
      timestamp: new Date().toISOString(),
    };
  }

  const response =
    typeof responseBody === "string"
      ? responseBody
      : JSON.stringify(responseBody);

  const record: CallRecord = {
    callNumber,
    toolName: args.tool_name,
    args: mergedArgs,
    injectedError,
    response,
    upstreamExecuted: false,
    timestamp: Date.now(),
  };
  addRecord(args.session_id, record);

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            callNumber,
            statusCode,
            injectedError,
            response: responseBody,
          },
          null,
          2,
        ),
      },
    ],
    isError: statusCode >= 400,
  };
}

export async function handleGetReport(args: {
  session_id: string;
  format?: "json" | "markdown";
}) {
  const session = getSession(args.session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: Session "${args.session_id}" not found.`,
        },
      ],
      isError: true,
    };
  }

  const report = generateReport(session);
  const format = args.format ?? "markdown";

  // Persist JSON report atomically
  try {
    await mkdir(dirname(AUDIT_REPORT_PATH), { recursive: true });
    await writeFile(AUDIT_REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
  } catch {
    // Non-fatal: report still returned in chat
  }

  const output = format === "json" ? JSON.stringify(report, null, 2) : formatMarkdown(report);

  return {
    content: [
      {
        type: "text" as const,
        text: output,
      },
    ],
  };
}

export function handleListScenarios() {
  const list = ALL_SCENARIOS.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    auditMetric: s.auditMetric,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(list, null, 2),
      },
    ],
  };
}

export function handleResetSession(args: { session_id: string }) {
  const session = getSession(args.session_id);
  if (!session) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Error: Session "${args.session_id}" not found.`,
        },
      ],
      isError: true,
    };
  }

  resetSessionState(args.session_id);

  return {
    content: [
      {
        type: "text" as const,
        text: `Session "${args.session_id}" reset. Call counter and history cleared.`,
      },
    ],
  };
}

export function handleDeleteSession(args: { session_id: string }) {
  const deleted = deleteSessionState(args.session_id);
  return {
    content: [
      {
        type: "text" as const,
        text: deleted
          ? `Session "${args.session_id}" deleted.`
          : `Session "${args.session_id}" not found.`,
      },
    ],
    isError: !deleted,
  };
}