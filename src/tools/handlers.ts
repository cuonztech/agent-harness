import {
  createSession,
  getSession,
  incrementCall,
  addRecord,
  resetSession as resetSessionState,
  deleteSession as deleteSessionState,
  classifyTool,
  extractKey,
  stripKeyFields,
  reserveScenarioFire,
  markGhostCommitted,
  type CallRecord,
  type SessionState,
} from "../core/state-engine.js";
import { generateReport, formatMarkdown } from "../core/report-generator.js";
import { computeScore, formatScoreReport } from "../benchmark/score.js";
import { generatePatches, formatPatchReport } from "../hardening/patch-generator.js";
import { getScenarioById, ALL_SCENARIOS } from "../scenarios/f1-f5.js";
import { resolveScenarioBody } from "../proxy/ghost-write.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const AUDIT_REPORT_PATH = ".cuonztech/audit-report.json";

// Two calls are the "same request" for dedup purposes only if every argument
// besides idempotency_key itself also matches — otherwise a reused key with
// different arguments would silently replay the FIRST call's response while
// the new, different arguments get recorded in history (inconsistent audit
// trail, and a real anomaly worth letting through to normal classification
// instead of masking it as a clean cache hit).
function sameArgs(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  keyFields: string[],
): boolean {
  return (
    JSON.stringify(stripKeyFields(a, keyFields)) ===
    JSON.stringify(stripKeyFields(b, keyFields))
  );
}

// Ad-hoc, non-chaos mode only: a key that already committed a successful
// write must replay that exact result instead of generating a fresh one each
// time (real idempotency is enforced server-side, not just classified after
// the fact). Excluded on purpose:
// - Deterministic scenarios (F1–F5): their trigger conditions decide what a
//   specific write returns regardless of key reuse (e.g. F4 must let the
//   second write through as a real second execution even though it shares
//   a key with the first — that duplicate is exactly what F4 measures).
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
      extractKey(r.args, session.keyFields) === key &&
      r.toolName === toolName &&
      r.outcome === "success" &&
      !r.deduplicated &&
      sameArgs(r.args, callArgs, session.keyFields),
  );
  return committed.length > 0 ? committed[committed.length - 1] : null;
}

export function handleStartSession(args: {
  scenario_id?: string;
  mode?: "deterministic" | "chaos";
  error_rate?: number;
  write_tool_patterns?: string[];
  read_tool_patterns?: string[];
  key_fields?: string[];
  retry_after_sec?: number;
}) {
  const scenarioId = args.scenario_id ?? null;
  const mode = args.mode ?? "deterministic";
  const errorRate = args.error_rate ?? 0.0;

  const reject = (message: string) => ({
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  });
  // Combinations that would silently do nothing (same rules as the proxy CLI).
  if (scenarioId && mode === "chaos") {
    return reject(
      "scenario_id and mode \"chaos\" cannot be combined: with a scenario set, chaos mode never injects anything.",
    );
  }
  if (errorRate > 0 && mode !== "chaos") {
    return reject("error_rate only has an effect together with mode \"chaos\".");
  }

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

  const session = createSession(
    scenarioId,
    mode,
    errorRate,
    args.write_tool_patterns,
    {
      readToolPatterns: args.read_tool_patterns,
      keyFields: args.key_fields,
      retryAfterSec: args.retry_after_sec,
    },
  );

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

  const receivedAt = Date.now();
  const callNumber = incrementCall(args.session_id);

  // The key may arrive as the top-level idempotency_key parameter or inside
  // `arguments`; both must behave the same.
  const callKey =
    args.idempotency_key ?? extractKey(args.arguments, session.keyFields);
  if (callKey && !session.scenarioId && session.mode !== "chaos") {
    const cached = findCommittedResponse(
      session,
      callKey,
      args.tool_name,
      args.arguments,
    );
    if (cached) {
      const dedupArgs = args.idempotency_key
        ? { ...args.arguments, idempotency_key: args.idempotency_key }
        : { ...args.arguments };
      const record: CallRecord = {
        callNumber,
        toolName: args.tool_name,
        args: dedupArgs,
        injectedError: null,
        response: cached.response,
        upstreamExecuted: false,
        timestamp: Date.now(),
        receivedAt,
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
  // Ghost-write: the simulated backend actually executed the write, but the
  // agent only sees a timeout. Mirrors proxy/ghost-write.ts::decideChaosAction.
  let isGhostWrite = false;
  let scenarioTriggered = false;
  let retryAfterSec: number | undefined;
  const toolClass = classifyTool(session, args.tool_name);
  const isWriteCall = toolClass === "write";
  const priorWriteCalls = session.scenarioFireCount;

  if (session.scenarioId) {
    const scenario = getScenarioById(session.scenarioId);
    if (
      scenario &&
      scenario.triggerCondition({
        callNumber,
        toolName: args.tool_name,
        isWriteCall,
        priorWriteCalls,
      })
    ) {
      reserveScenarioFire(session);
      const resp = scenario.simulatedResponse;
      scenarioTriggered = true;
      // Don't mark "success" type as injected error — F4 simulates successful duplicate dispatches
      injectedError = resp.type === "success" ? null : `[${resp.type.toUpperCase()}]`;
      statusCode = resp.statusCode ?? 500;
      responseBody = resolveScenarioBody(scenario, session);
      isGhostWrite = resp.type === "timeout" && isWriteCall;
      if (resp.type === "rate_limit") retryAfterSec = session.retryAfterSec;
      // Note: resp.delayMs is NOT awaited on this synchronous path (unlike
      // proxy mode's interceptor.ts) — handleExecuteCall is called
      // synchronously from many call sites across the test suite and
      // benchmark runner. Use `proxy` mode if simulated latency matters.
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
      error: "INTERNAL_SERVER_ERROR",
      message: "The server encountered an internal error.",
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
    receivedAt,
    outcome: injectedError !== null ? "injected_failure" : "success",
    toolClass,
    // The simulated backend executes a write unless a failure was injected —
    // except for a ghost-write, which executes although the agent sees one.
    tookEffect: isWriteCall && (injectedError === null || isGhostWrite),
    scenarioTriggered,
    ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
  };
  addRecord(args.session_id, record);

  const ghostKey = isGhostWrite ? extractKey(mergedArgs, session.keyFields) : undefined;
  if (ghostKey) {
    markGhostCommitted(args.session_id, ghostKey);
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

// `persist` writes the JSON report to .cuonztech/audit-report.json in the
// current working directory (the session-mode get_report tool's documented
// behavior). Proxy mode passes false: its report file is opt-in via
// --report-file, because a proxy started by an MCP client has no predictable
// working directory.
export async function handleGetReport(
  args: {
    session_id: string;
    format?: "json" | "markdown";
  },
  options: { persist?: boolean } = {},
) {
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

  if (options.persist ?? true) {
    try {
      await mkdir(dirname(AUDIT_REPORT_PATH), { recursive: true });
      await writeFile(AUDIT_REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
    } catch {
      // Non-fatal: report still returned in chat
    }
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
// `patches: false` (Proxy ohne gültige Lizenz): Score und Urteil unverändert, die Härtungsvorschläge
// (Textbausteine) gehören zum Pro-Umfang und werden durch einen Hinweis ersetzt.
export function handleGetScore(args: { session_id: string; format?: "json" | "markdown" }, options: { patches?: boolean } = {}) {
  const withPatches = options.patches ?? true;
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
  const patches = withPatches ? generatePatches([report], score) : [];
  const format = args.format ?? "markdown";
  const lockedNote =
    "Keine gültige Lizenz: Die Härtungsvorschläge (Textbausteine) gehören zum Pro-Umfang. " +
    "Score und Urteil sind vollständig. Lizenz: https://cuonztech.ch/agent-harness.html#audit";

  const output =
    format === "json"
      ? JSON.stringify({ score, patches, ...(withPatches ? {} : { limitedByLicense: true, licenseNotice: lockedNote }) }, null, 2)
      : [formatScoreReport(score), withPatches ? (patches.length > 0 ? formatPatchReport(patches) : null) : lockedNote]
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