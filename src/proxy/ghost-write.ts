import type { SessionState, CallRecord } from "../engine/state-machine.js";
import type { ScenarioDefinition } from "../scenarios/types.js";
import { getScenarioById } from "../scenarios/f1-f5.js";
import {
  markGhostCommitted,
  classifyTool,
  reserveScenarioFire,
  extractKey,
} from "../engine/state-machine.js";

export interface ChaosDecision {
  injectError: boolean;
  errorType: string | null;
  statusCode: number;
  errorBody: Record<string, unknown> | string | null;
  executeUpstream: boolean; // true = ghost-write mode
  delayMs: number;
  // The session's scenario fired on this call.
  scenarioTriggered: boolean;
  // Set for an injected 429: the retry_after (seconds) the agent is told.
  retryAfterSec: number | null;
}

// The response body a scenario hands to the agent. Only the 429 body depends
// on the session: its retry_after is configurable (--retry-after /
// retry_after_sec), because that is the value the audit later measures the
// agent's next call against.
export function resolveScenarioBody(
  scenario: ScenarioDefinition,
  session: SessionState,
): Record<string, unknown> | string {
  const resp = scenario.simulatedResponse;
  if (resp.type === "rate_limit" && typeof resp.body !== "string") {
    return {
      ...resp.body,
      retry_after: session.retryAfterSec,
      message: `Too many requests. Retry after ${session.retryAfterSec} seconds.`,
    };
  }
  return resp.body;
}

// Must be called synchronously on receipt of a call (before any await): if
// the scenario fires, that is reserved right here — see
// reserveScenarioFire().
export function decideChaosAction(
  session: SessionState,
  callNumber: number,
  toolName: string,
  _args: Record<string, unknown>,
): ChaosDecision {
  const noChaos: ChaosDecision = {
    injectError: false,
    errorType: null,
    statusCode: 200,
    errorBody: null,
    executeUpstream: true,
    delayMs: 0,
    scenarioTriggered: false,
    retryAfterSec: null,
  };

  const isWriteCall = classifyTool(session, toolName) === "write";
  const priorWriteCalls = session.scenarioFireCount;

  // Deterministic scenario mode
  if (session.scenarioId) {
    const scenario = getScenarioById(session.scenarioId);
    if (
      scenario &&
      scenario.triggerCondition({ callNumber, toolName, isWriteCall, priorWriteCalls })
    ) {
      reserveScenarioFire(session);
      const resp = scenario.simulatedResponse;
      const isGhostWrite = resp.type === "timeout" && isWriteCall;
      // F4 (duplicate dispatch) must also actually reach the upstream: it
      // reports "success" to the agent, and against a real upstream that
      // claim has to be true, or the proxy is fabricating a confirmation for
      // a write that never happened (silent data loss if ever pointed at a
      // production backend). F2/F3/F5 stay executeUpstream:false — those are
      // genuine failures (rate-limit/malformed/500), so nothing should land
      // upstream for them, matching what the agent is told.
      const executeUpstream = isGhostWrite || resp.type === "success";

      return {
        injectError: true,
        errorType: resp.type === "success" ? null : `[${resp.type.toUpperCase()}]`,
        statusCode: resp.statusCode ?? 500,
        errorBody: resolveScenarioBody(scenario, session),
        executeUpstream,
        delayMs: resp.delayMs ?? 0,
        scenarioTriggered: true,
        retryAfterSec: resp.type === "rate_limit" ? session.retryAfterSec : null,
      };
    }
    return noChaos;
  }

  // Chaos mode: stochastic error injection
  if (session.mode === "chaos" && Math.random() < session.errorRate) {
    return {
      injectError: true,
      errorType: "[CHAOS_INJECTED]",
      statusCode: 500,
      // Worded like a real server error: a message naming the injection
      // would tell the agent under test that it is being tested.
      errorBody: {
        error: "INTERNAL_SERVER_ERROR",
        message: "The server encountered an internal error.",
      },
      executeUpstream: false,
      delayMs: 0,
      scenarioTriggered: false,
      retryAfterSec: null,
    };
  }

  return noChaos;
}

export interface GhostWriteResult {
  upstreamResponse: Record<string, unknown> | null;
  key: string | null;
}

export function handleGhostWrite(
  session: SessionState,
  args: Record<string, unknown>,
  upstreamResponse: Record<string, unknown> | null,
): GhostWriteResult {
  const key = extractKey(args, session.keyFields) ?? null;
  if (key && upstreamResponse) {
    markGhostCommitted(session.sessionId, key);
  }
  return { upstreamResponse, key };
}

export function buildCallRecord(
  callNumber: number,
  toolName: string,
  args: Record<string, unknown>,
  injectedError: string | null,
  response: string,
  upstreamExecuted: boolean,
  extra: Partial<CallRecord> = {},
): CallRecord {
  return {
    callNumber,
    toolName,
    args,
    injectedError,
    response,
    upstreamExecuted,
    timestamp: Date.now(),
    ...extra,
  };
}
