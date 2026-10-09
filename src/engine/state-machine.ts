import { randomUUID } from "node:crypto";

export type KeyState = "PENDING" | "FAILED_DOWNSTREAM" | "COMMITTED" | "GHOST_COMMITTED";

export interface KeyTracking {
  state: KeyState;
  firstCallNumber: number;
  lastCallNumber: number;
  lastError: string | null;
  readBeforeRetry: boolean;
  writeCalls: number;
  ghostCommitted: boolean;
}

export interface SessionState {
  sessionId: string;
  callCount: number;
  scenarioId: string | null;
  mode: "deterministic" | "chaos";
  errorRate: number;
  history: CallRecord[];
  keyStates: Map<string, KeyTracking>;
  createdAt: number;
}

export interface CallRecord {
  callNumber: number;
  toolName: string;
  args: Record<string, unknown>;
  injectedError: string | null;
  response: string;
  upstreamExecuted: boolean;
  timestamp: number;
  // True for a cache-replay of an already-COMMITTED idempotency key: no new
  // write happened, so it must not bump writeCalls or affect key-state —
  // otherwise the audit engine misclassifies the dedup hit itself as a
  // REDUNDANT_CALL violation.
  deduplicated?: boolean;
}

const sessions = new Map<string, SessionState>();

export function createSession(
  scenarioId: string | null = null,
  mode: "deterministic" | "chaos" = "deterministic",
  errorRate = 0.0,
): SessionState {
  const session: SessionState = {
    sessionId: randomUUID(),
    callCount: 0,
    scenarioId,
    mode,
    errorRate,
    history: [],
    keyStates: new Map(),
    createdAt: Date.now(),
  };
  sessions.set(session.sessionId, session);
  return session;
}

export function getSession(sessionId: string): SessionState | undefined {
  return sessions.get(sessionId);
}

export function incrementCall(sessionId: string): number {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session.callCount += 1;
  return session.callCount;
}

export function addRecord(sessionId: string, record: CallRecord): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session.history.push(record);

  // Cache replay of an already-committed key: stays in history for the call
  // count, but is a no-op for key-tracking — nothing new was written.
  if (record.deduplicated) return;

  const key = record.args["idempotency_key"] as string | undefined;
  if (!key) return;

  const isWrite = isWriteTool(record.toolName);
  const hasInjectedError =
    record.injectedError !== null && !record.injectedError.includes("SUCCESS");
  const hasResponseError =
    typeof record.response === "string" && record.response.includes('"error"');
  const isError = hasInjectedError || hasResponseError;
  const existing = session.keyStates.get(key);

  if (!existing) {
    session.keyStates.set(key, {
      state: isError
        ? "FAILED_DOWNSTREAM"
        : isWrite
          ? "COMMITTED"
          : "PENDING",
      firstCallNumber: record.callNumber,
      lastCallNumber: record.callNumber,
      lastError: record.injectedError,
      readBeforeRetry: false,
      writeCalls: isWrite ? 1 : 0,
      ghostCommitted: false,
    });
  } else {
    existing.lastCallNumber = record.callNumber;
    existing.lastError = record.injectedError ?? existing.lastError;

    if (isWrite) {
      existing.writeCalls += 1;
    }

    // Track read-before-retry: any read call between first error and this retry
    if ((existing.state === "FAILED_DOWNSTREAM" || existing.state === "GHOST_COMMITTED") && !isError) {
      const hasReadBetween = session.history.some(
        (r) =>
          r.callNumber > existing.firstCallNumber &&
          r.callNumber < record.callNumber &&
          isReadTool(r.toolName),
      );
      existing.readBeforeRetry = hasReadBetween;
    }

    // Update state
    if (isError) {
      existing.state = "FAILED_DOWNSTREAM";
    } else if (isWrite && !existing.ghostCommitted) {
      existing.state = "COMMITTED";
    }
  }
}

export function markGhostCommitted(
  sessionId: string,
  key: string,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const tracking = session.keyStates.get(key);
  if (tracking) {
    tracking.state = "GHOST_COMMITTED";
    tracking.ghostCommitted = true;
  } else {
    session.keyStates.set(key, {
      state: "GHOST_COMMITTED",
      firstCallNumber: session.callCount,
      lastCallNumber: session.callCount,
      lastError: null,
      readBeforeRetry: false,
      writeCalls: 1,
      ghostCommitted: true,
    });
  }
}

export function resetSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  session.callCount = 0;
  session.history = [];
  session.keyStates = new Map();
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

export function isWriteTool(toolName: string): boolean {
  return toolName.startsWith("write");
}

export function isReadTool(toolName: string): boolean {
  const prefixes = [
    "read",
    "get",
    "list",
    "check",
    "verify",
    "query",
    "execute_query",
    "fetch",
    "inspect",
    "status",
  ];
  const lower = toolName.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p));
}