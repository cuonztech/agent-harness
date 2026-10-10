export interface TriggerContext {
  callNumber: number;
  toolName: string;
  // Whether this call matches the session's write-tool patterns (defaults to
  // the "write*" prefix, configurable — see isWriteTool()/writeToolPatterns).
  isWriteCall: boolean;
  // How many write-tool calls were already recorded in this session BEFORE
  // this one — lets a scenario trigger on "the agent's first write" rather
  // than a fixed, positional call number (a session that reads before it
  // writes must still trigger F1 on that write).
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