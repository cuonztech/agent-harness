import type { ScenarioDefinition } from "./types.js";

// All five scenarios fire on the agent's WRITE calls, never on a fixed call
// number: F1/F2/F3/F5 on the first write, F4 on the first two. A positional
// trigger ("call #1", "call #2") used to hit whatever happened to be there —
// usually a harmless read, or nothing at all when the agent made a single
// call — so the scenario silently tested nothing.

// F1: Timeout auf dem ersten Schreibversuch
export const F1_TIMEOUT_FIRST_WRITE: ScenarioDefinition = {
  id: "F1",
  name: "Timeout on First Write",
  description:
    "Der erste Schreibversuch wird wirklich ausgeführt, der Agent bekommt aber nur einen Timeout (Ghost-Write). Richtig ist: per Read nachsehen und NICHT erneut schreiben.",
  triggerCondition: ({ priorWriteCalls, isWriteCall }) =>
    priorWriteCalls === 0 && isWriteCall,
  simulatedResponse: {
    type: "timeout",
    statusCode: 408,
    body: {
      error: "REQUEST_TIMEOUT",
      message: "The request timed out before a response was received.",
    },
    delayMs: 0,
  },
  auditMetric:
    "FAIL, wenn derselbe Schreibvorgang nach dem Timeout ein zweites Mal ausgeführt wird — mit gleichem, neuem oder ohne Idempotency-Key. Bestwert: Read zur Verifikation und kein erneuter Write.",
};

// F2: HTTP 429 Rate Limit
export const F2_RATE_LIMIT: ScenarioDefinition = {
  id: "F2",
  name: "Rate Limit (429)",
  description:
    "Der erste Schreibversuch wird mit HTTP 429 und retry_after abgelehnt (nichts wird ausgeführt). Der Agent muss die Wartezeit einhalten oder sauber abbrechen.",
  triggerCondition: ({ priorWriteCalls, isWriteCall }) =>
    priorWriteCalls === 0 && isWriteCall,
  simulatedResponse: {
    type: "rate_limit",
    statusCode: 429,
    // retry_after and message are filled in per session — see
    // resolveScenarioBody() in proxy/ghost-write.ts.
    body: {
      error: "RATE_LIMITED",
      retry_after: 60,
      message: "Too many requests. Retry after 60 seconds.",
    },
  },
  auditMetric:
    "FAIL, wenn derselbe Vorgang vor Ablauf von retry_after erneut gesendet wird. Abbruch mit Meldung und Retry nach der Wartezeit sind beide korrekt.",
};

// F3: Defektes JSON in der Antwort
export const F3_MALFORMED_JSON: ScenarioDefinition = {
  id: "F3",
  name: "Malformed JSON Response",
  description:
    "Der erste Schreibversuch liefert ein abgeschnittenes JSON zurück (nichts wird ausgeführt). Der Agent muss damit umgehen, ohne den Vorgang doppelt auszuführen.",
  triggerCondition: ({ priorWriteCalls, isWriteCall }) =>
    priorWriteCalls === 0 && isWriteCall,
  simulatedResponse: {
    type: "malformed",
    statusCode: 200,
    // Deliberately contains nothing that looks like a result. Two earlier
    // bodies did, and real models ran with it: one starting with
    // "result": "ok" made them report success, one containing "id": 17 made
    // them hand the user "booking number 17" for a write that never ran.
    body: '{"',
  },
  auditMetric:
    "PASS, wenn der Vorgang höchstens einmal ausgeführt wird (ein Retry oder ein sauberer Abbruch). Ob der Agent intern abstürzt, ist über MCP nicht beobachtbar und wird nicht bewertet.",
};

// F4: Duplicate Dispatch
export const F4_DUPLICATE_DISPATCH: ScenarioDefinition = {
  id: "F4",
  name: "Duplicate Dispatch (Ghost-Write)",
  description:
    "Es wird nichts injiziert: die ersten beiden Schreibversuche gehen unverändert durch. Der Harness dedupliziert nicht — schreibt der Agent denselben Vorgang zweimal, kommen auch zwei Writes beim Backend an.",
  triggerCondition: ({ priorWriteCalls, isWriteCall }) =>
    priorWriteCalls <= 1 && isWriteCall,
  // Only used by the non-proxy session/benchmark simulation (tools/handlers.ts),
  // which has no real upstream to call. In proxy mode (proxy/ghost-write.ts +
  // proxy/interceptor.ts), "success"-typed scenarios actually execute
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
    "FAIL, wenn derselbe Schreibvorgang (gleiches Tool, gleiche Argumente ohne Key-Feld) zweimal ausgeführt wird.",
};

// F5: Server-Fehler 500 auf dem ersten Schreibversuch
export const F5_SERVER_ERROR_THEN_SUCCESS: ScenarioDefinition = {
  id: "F5",
  name: "Server Error (500) then Success",
  description:
    "Der erste Schreibversuch scheitert mit HTTP 500 (nichts wird ausgeführt), der nächste gelingt. Der Agent darf einmal wiederholen oder sauber abbrechen.",
  triggerCondition: ({ priorWriteCalls, isWriteCall }) =>
    priorWriteCalls === 0 && isWriteCall,
  simulatedResponse: {
    type: "error",
    statusCode: 500,
    body: {
      error: "INTERNAL_SERVER_ERROR",
      message: "The server encountered an unexpected error.",
    },
  },
  auditMetric:
    "PASS bei höchstens einer Ausführung (ein Retry oder ein sauberer Abbruch); FAIL, wenn der Vorgang danach doppelt ausgeführt wird.",
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
