import { randomUUID } from "node:crypto";
import { StateDiffStore } from "./state-diff.js";

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
  // Real-value backing store, keyed by idempotency_key: tracks what was
  // actually written and whether the agent actually read that exact key
  // back before retrying. Independent of keyStates' tool-name-based
  // readBeforeRetry heuristic — see report-generator.ts's stateDiff fields.
  stateDiff: StateDiffStore;
  // Glob patterns (e.g. "write*", "create_*", "send_*") deciding which tool
  // names count as writes for this session — see isWriteTool(). Defaults to
  // ["write*"], i.e. the harness's original prefix-only behavior.
  writeToolPatterns: string[];
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
  writeToolPatterns: string[] = ["write*"],
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
    stateDiff: new StateDiffStore(),
    writeToolPatterns:
      writeToolPatterns.length > 0 ? writeToolPatterns : ["write*"],
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

  const isWrite = isWriteTool(record.toolName, session.writeToolPatterns);
  const hasInjectedError =
    record.injectedError !== null && !record.injectedError.includes("SUCCESS");
  const hasResponseError =
    typeof record.response === "string" && record.response.includes('"error"');
  const isError = hasInjectedError || hasResponseError;

  // Real-value tracking, independent of the keyStates classification below.
  // A write only actually lands in the backing store if it wasn't rejected
  // outright — either it succeeded cleanly, or (ghost-write) the upstream
  // executed it despite the agent seeing an error.
  if (isWrite && (!isError || record.upstreamExecuted)) {
    session.stateDiff.write(key, record.response, record.callNumber);
  } else if (isReadTool(record.toolName)) {
    session.stateDiff.read(key, record.callNumber);
  }

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
  session.stateDiff.reset();
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

// Default kept as ["write*"] for backward compatibility with every call site
// that doesn't (yet) thread a session's own writeToolPatterns through —
// identical behavior to the old hardcoded toolName.startsWith("write").
export function isWriteTool(
  toolName: string,
  patterns: string[] = ["write*"],
): boolean {
  return matchesAnyGlob(toolName, patterns);
}

// Minimal glob support (only "*" as a wildcard) so a write-tool pattern like
// "create_*" or "send_*" can be configured per session instead of hardcoding
// a single "write" prefix — see --write-tools (proxy mode) and
// start_session's write_tool_patterns (live sessions).
export function matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(name);
  });
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