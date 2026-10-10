import type { SessionState, CallRecord } from "../engine/state-machine.js";
import { getScenarioById } from "../scenarios/f1-f5.js";
import { markGhostCommitted } from "../engine/state-machine.js";

export interface ChaosDecision {
  injectError: boolean;
  errorType: string | null;
  statusCode: number;
  errorBody: Record<string, unknown> | string | null;
  executeUpstream: boolean; // true = ghost-write mode
  delayMs: number;
}

export function decideChaosAction(
  session: SessionState,
  callNumber: number,
  toolName: string,
  args: Record<string, unknown>,
): ChaosDecision {
  const noChaos: ChaosDecision = {
    injectError: false,
    errorType: null,
    statusCode: 200,
    errorBody: null,
    executeUpstream: true,
    delayMs: 0,
  };

  // Deterministic scenario mode
  if (session.scenarioId) {
    const scenario = getScenarioById(session.scenarioId);
    if (scenario && scenario.triggerCondition(callNumber, toolName)) {
      const resp = scenario.simulatedResponse;
      const isGhostWrite = resp.type === "timeout" && toolName.startsWith("write");
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
        errorBody: resp.body,
        executeUpstream,
        delayMs: resp.delayMs ?? 0,
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
      errorBody: {
        error: "CHAOS_ERROR",
        message: "Stochastically injected failure.",
      },
      executeUpstream: false,
      delayMs: 0,
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
  const key = (args["idempotency_key"] as string) ?? null;
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
): CallRecord {
  return {
    callNumber,
    toolName,
    args,
    injectedError,
    response,
    upstreamExecuted,
    timestamp: Date.now(),
  };
}