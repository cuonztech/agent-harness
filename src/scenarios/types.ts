export interface TriggerContext {
  callNumber: number;
  toolName: string;
  // Whether this call is classified as a write for the session — see
  // classifyTool() in engine/state-machine.ts.
  isWriteCall: boolean;
  // How many write calls this scenario has already fired on in the session.
  // 0 = it has not fired yet, so "fire on the first write" is
  // `priorWriteCalls === 0 && isWriteCall` — independent of how many reads
  // came before, and of writes the scenario could not be applied to.
  priorWriteCalls: number;
}

export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  triggerCondition: (ctx: TriggerContext) => boolean;
  simulatedResponse: SimulatedResponse;
  auditMetric: string;
}

export interface SimulatedResponse {
  type: "error" | "success" | "malformed" | "timeout" | "rate_limit";
  statusCode?: number;
  body: string | Record<string, unknown>;
  delayMs?: number;
}
