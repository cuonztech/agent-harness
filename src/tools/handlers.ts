import {
  createSession,
  getSession,
  incrementCall,
  addRecord,
  resetSession as resetSessionState,
  deleteSession as deleteSessionState,
  listSessions,
  isWriteTool,
  markGhostCommitted,
  type CallRecord,
  type SessionState,
} from "../core/state-engine.js";
import { generateReport, formatMarkdown } from "../core/report-generator.js";
import { computeScore, formatScoreReport } from "../benchmark/score.js";
import { generatePatches, formatPatchReport } from "../hardening/patch-generator.js";
import { getScenarioById, ALL_SCENARIOS } from "../scenarios/f1-f5.js";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AUDIT_REPORT_PATH = ".cuonztech/audit-report.json";

// Two calls are the "same request" for dedup purposes only if every argument
// besides idempotency_key itself also matches — otherwise a reused key with
// different arguments would silently replay the FIRST call's response while
// the new, different arguments get recorded in history (inconsistent audit
// trail, and a real anomaly worth letting through to normal classification
// instead of masking it as a clean cache hit).
function sameArgs(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const strip = (o: Record<string, unknown>) => {
    const { idempotency_key, ...rest } = o;
    return rest;
  };
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

// Ad-hoc, non-chaos mode only: a key that already committed a successful
// write must replay that exact result instead of generating a fresh one each
// time (real idempotency is enforced server-side, not just classified after
// the fact). Excluded on purpose:
// - Deterministic scenarios (F1–F5): their trigger conditions are positional
//   (by callNumber) and intentionally decide what a specific call number
//   returns regardless of key reuse (e.g. F2 must still 429 the 2nd call
//   even though it shares a key with the 1st).
// - Chaos mode: stochastic error_rate injection must keep applying to every
//   call attempt, including retries of a committed key — otherwise a key
//   that happened to commit early becomes permanently immune to chaos for
//   the rest of the session, defeating the configured error_rate.
function findCommittedResponse(
  session: SessionState,
  key: string,
  toolName: string,
  callArgs: Record<string, unknown>,
): CallRecord | null {
  const tracking = session.keyStates.get(key);
  if (!tracking || tracking.state !== "COMMITTED") return null;
  const committed = session.history.filter(
    (r) =>
      r.args["idempotency_key"] === key &&
      r.toolName === toolName &&
      !r.injectedError &&
      !r.response.includes('"error"') &&
      sameArgs(r.args, callArgs),
  );
  return committed.length > 0 ? committed[committed.length - 1] : null;
}

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

  if (args.idempotency_key && !session.scenarioId && session.mode !== "chaos") {
    const cached = findCommittedResponse(
      session,
      args.idempotency_key,
      args.tool_name,
      args.arguments,
    );
    if (cached) {
      const dedupArgs = { ...args.arguments, idempotency_key: args.idempotency_key };
      const record: CallRecord = {
        callNumber,
        toolName: args.tool_name,
        args: dedupArgs,
        injectedError: null,
        response: cached.response,
        upstreamExecuted: false,
        timestamp: Date.now(),
        deduplicated: true,
      };
      addRecord(args.session_id, record);

      let cachedBody: unknown;
      try {
        cachedBody = JSON.parse(cached.response);
      } catch {
        cachedBody = cached.response;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                callNumber,
                statusCode: 200,
                injectedError: null,
                response: cachedBody,
                deduplicated: true,
              },
              null,
              2,
            ),
          },
        ],
        isError: false,
      };
    }
  }

  // Inject idempotency key into args for tracking
  const mergedArgs = { ...args.arguments };
  if (args.idempotency_key) {
    mergedArgs["idempotency_key"] = args.idempotency_key;
  }

  // Determine if scenario triggers an error
  let injectedError: string | null = null;
  let responseBody: Record<string, unknown> | string;
  let statusCode = 200;
  // Ghost-write: the simulated upstream actually executed the write, but the
  // agent only sees a timeout — it must read-before-retry to find out. Mirrors
  // the same classification used by the (unwired) proxy's decideChaosAction,
  // so F1 produces a real GHOST_CAUGHT/GHOST_MISSED instead of a generic retry.
  let isGhostWrite = false;

  if (session.scenarioId) {
    const scenario = getScenarioById(session.scenarioId);
    if (scenario && scenario.triggerCondition(callNumber, args.tool_name)) {
      const resp = scenario.simulatedResponse;
      // Don't mark "success" type as injected error — F4 simulates successful duplicate dispatches
      injectedError = resp.type === "success" ? null : `[${resp.type.toUpperCase()}]`;
      statusCode = resp.statusCode ?? 500;
      responseBody = resp.body;
      isGhostWrite = resp.type === "timeout" && isWriteTool(args.tool_name);
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
    upstreamExecuted: isGhostWrite,
    timestamp: Date.now(),
  };
  addRecord(args.session_id, record);

  if (isGhostWrite && args.idempotency_key) {
    markGhostCommitted(args.session_id, args.idempotency_key);
  }

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

// Resilience Score + Hardening Patches for THIS session's own audit report —
// unlike `benchmark` mode (which scores a hardcoded scripted call sequence
// against itself), this scores whatever the connected agent actually did.
export function handleGetScore(args: { session_id: string; format?: "json" | "markdown" }) {
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
  const score = computeScore([report]);
  const patches = generatePatches([report], score);
  const format = args.format ?? "markdown";

  const output =
    format === "json"
      ? JSON.stringify({ score, patches }, null, 2)
      : [formatScoreReport(score), patches.length > 0 ? formatPatchReport(patches) : null]
          .filter(Boolean)
          .join("\n\n");

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