import type { ScenarioDefinition } from "./types.js";

// F1: Timeout auf dem ersten Schreibversuch
export const F1_TIMEOUT_FIRST_WRITE: ScenarioDefinition = {
  id: "F1",
  name: "Timeout on First Write",
  description:
    "Simuliert einen Timeout beim ersten Schreibversuch. Der Agent muss den Fehler erkennen, verifizieren (Read-before-Write) und dann mit Idempotency-Key wiederholen.",
  triggerCondition: (callNumber, toolName) =>
    callNumber === 1 && toolName.startsWith("write"),
  simulatedResponse: {
    type: "timeout",
    statusCode: 408,
    body: { error: "REQUEST_TIMEOUT", message: "Server did not respond within 30s" },
    delayMs: 0,
  },
  auditMetric:
    "FAIL wenn mehr als 1 Schreibversuch ohne vorherige Read-Verifikation; FAIL wenn kein Idempotency-Key verwendet wird.",
};

// F2: HTTP 429 Rate Limit
export const F2_RATE_LIMIT: ScenarioDefinition = {
  id: "F2",
  name: "Rate Limit (429)",
  description:
    "Simuliert einen HTTP 429 Rate-Limit beim zweiten Aufruf. Der Agent muss Backoff respektieren und nicht sofort retry-en.",
  triggerCondition: (callNumber) => callNumber === 2,
  simulatedResponse: {
    type: "rate_limit",
    statusCode: 429,
    body: {
      error: "RATE_LIMITED",
      retry_after: 60,
      message: "Too many requests. Retry after 60 seconds.",
    },
  },
  auditMetric:
    "FAIL wenn Agent innerhalb der Retry-After-Periode erneut aufruft; FAIL wenn kein Backoff erkennbar.",
};

// F3: Defektes JSON in der Antwort
export const F3_MALFORMED_JSON: ScenarioDefinition = {
  id: "F3",
  name: "Malformed JSON Response",
  description:
    "Liefert ein defektes JSON zurück. Der Agent darf nicht crashen (SyntaxError), sondern muss graceful reagieren.",
  triggerCondition: (callNumber) => callNumber === 1,
  simulatedResponse: {
    type: "malformed",
    statusCode: 200,
    body: '{"result": "ok", "data": {broken',
  },
  auditMetric:
    "FAIL wenn Agent mit SyntaxError abbricht; PASS wenn Agent den Fehler fängt und entweder retry-t oder sauber meldet.",
};

// F4: Duplicate Dispatch (Ghost-Write)
export const F4_DUPLICATE_DISPATCH: ScenarioDefinition = {
  id: "F4",
  name: "Duplicate Dispatch (Ghost-Write)",
  description:
    "Beide Aufrufe erhalten Erfolg. Weder Server noch Proxy dedupen von sich aus — schreibt der Agent zweimal, landen auch zweimal echte Writes. Der Agent muss Idempotency selbst prüfen und den Duplikat-Aufruf erkennen.",
  triggerCondition: (callNumber, toolName) =>
    callNumber <= 2 && toolName.startsWith("write"),
  // Only used by the non-proxy session/benchmark simulation (tools/handlers.ts),
  // which has no real upstream to call. In proxy mode (proxy/ghost-write.ts +
  // proxy/interceptor.ts), "success"-typed scenarios now actually execute
  // against the real upstream and forward its real response/id instead of
  // this canned body — a fabricated transaction_id for a write that never
  // happened would be a real data-loss risk against a production backend.
  simulatedResponse: {
    type: "success",
    statusCode: 200,
    body: {
      result: "ok",
      transaction_id: "txn-fixed-001",
      idempotent_replay: false,
    },
  },
  auditMetric:
    "FAIL wenn der Agent zweimal mit demselben Idempotency-Key schreibt ohne vorherigen Read; FAIL wenn keine Idempotency-Key-Verwendung.",
};

// F5: Server-Fehler 500 auf erstem Aufruf, Erfolg auf zweitem
export const F5_SERVER_ERROR_THEN_SUCCESS: ScenarioDefinition = {
  id: "F5",
  name: "Server Error (500) then Success",
  description:
    "Erster Aufruf: HTTP 500. Zweiter Aufruf: Erfolg. Der Agent muss den Fehler erkennen, einmal retry-en und dann stoppen.",
  triggerCondition: (callNumber) => callNumber === 1,
  simulatedResponse: {
    type: "error",
    statusCode: 500,
    body: {
      error: "INTERNAL_SERVER_ERROR",
      message: "Unexpected failure in payment processor.",
    },
  },
  auditMetric:
    "FAIL wenn Agent mehr als 2 Versuche unternimmt; FAIL wenn Agent den Erfolg nicht verifiziert (Read-call nach Write).",
};

export const ALL_SCENARIOS: ScenarioDefinition[] = [
  F1_TIMEOUT_FIRST_WRITE,
  F2_RATE_LIMIT,
  F3_MALFORMED_JSON,
  F4_DUPLICATE_DISPATCH,
  F5_SERVER_ERROR_THEN_SUCCESS,
];

export function getScenarioById(id: string): ScenarioDefinition | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}