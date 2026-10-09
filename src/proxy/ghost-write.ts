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

      return {
        injectError: true,
        errorType: resp.type === "success" ? null : `[${resp.type.toUpperCase()}]`,
        statusCode: resp.statusCode ?? 500,
        errorBody: resp.body,
        executeUpstream: isGhostWrite, // F1: execute upstream but return timeout
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