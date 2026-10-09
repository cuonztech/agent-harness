export interface ScenarioDefinition {
  id: string;
  name: string;
  description: string;
  triggerCondition: (callNumber: number, toolName: string) => boolean;
  simulatedResponse: SimulatedResponse;
  auditMetric: string;
}

export interface SimulatedResponse {
  type: "error" | "success" | "malformed" | "timeout" | "rate_limit";
  statusCode?: number;
  body: string | Record<string, unknown>;
  delayMs?: number;
}