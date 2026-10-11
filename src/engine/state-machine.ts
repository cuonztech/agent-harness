import { randomUUID } from "node:crypto";
import { StateDiffStore } from "./state-diff.js";

export type KeyState = "PENDING" | "FAILED_DOWNSTREAM" | "COMMITTED" | "GHOST_COMMITTED";

// How the harness treats a tool for scenario triggering and scoring.
// "unclassified" = neither an explicit override/annotation nor any name
// pattern says what it is; such calls are passed through but never scored as
// writes — the report and the proxy's startup output flag them instead of
// silently treating them as harmless.
export type ToolClass = "write" | "read" | "unclassified";

// What the AGENT saw for a call — a structured flag instead of searching the
// response text for the substring '"error"' (which misread any upstream
// payload containing `"error": null` as a failure, and missed real upstream
// failures whose text happened not to contain that substring).
export type CallOutcome =
  | "success" // the agent received a successful result
  | "injected_failure" // the harness simulated a failure (timeout/429/malformed/500/chaos)
  | "upstream_error"; // the real upstream returned isError, threw, or was unavailable

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
  // Real-value backing store, keyed by idempotency key: tracks what was
  // actually written and whether the agent actually read that exact key
  // back before retrying. Informational only — see report-generator.ts's
  // stateDiff fields. The verdict comes from operation tracking, not from here.
  stateDiff: StateDiffStore;
  // Glob patterns (e.g. "write*", "create_*", "send_*") deciding which tool
  // names count as writes for this session — see classifyTool().
  writeToolPatterns: string[];
  // Extra glob patterns counted as reads, on top of the built-in read
  // prefixes in isReadTool().
  readToolPatterns: string[];
  // Per-tool class decided up front (proxy mode: from MCP tool annotations
  // and explicit flags). Wins over every name pattern.
  toolClassOverrides: Map<string, ToolClass>;
  // Argument names that carry an idempotency key. Matched case-insensitively
  // and ignoring "-"/"_" (so "idempotency_key" also covers "idempotencyKey"
  // and "Idempotency-Key"). They are stripped before two write calls are
  // compared, so the same operation re-sent under a NEW key is still
  // recognized as the same operation.
  keyFields: string[];
  // Tools whose input schema declares one of keyFields (proxy mode only).
  keyCapableTools: Set<string>;
  // retry_after (seconds) announced by an injected 429 (scenario F2).
  retryAfterSec: number;
  // How many write calls the session's scenario has fired on so far.
  // Reserved at decision time (synchronously), not when the record lands in
  // history, so two writes dispatched in parallel cannot both be "the first
  // write" — and given back if the scenario could not be applied after all
  // (see releaseScenarioFire), so a call that never really reached the
  // backend does not use up the scenario.
  scenarioFireCount: number;
  // true (proxy mode): the set of real tools is known, so a call to a tool
  // that is not in toolClassOverrides is "unclassified" whatever its name
  // looks like. Otherwise a call to a tool that does not exist would count
  // as a write just because it is called create_something.
  knownToolsOnly: boolean;
  // "demo" = MCP session mode with a simulated backend; "proxy" = in front
  // of a real upstream. Shown in reports so a demo is not mistaken for a
  // measurement.
  kind: "demo" | "proxy";
  // Proxy mode: calls that were forwarded to the upstream and have not been
  // answered yet, by call number. A report written while one is open (the
  // session ended, the proxy was killed) must show it as "effect unknown"
  // instead of leaving it out — the upstream may well have executed it.
  pending?: Map<number, CallRecord>;
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
  // write happened, so it must not bump writeCalls or affect key-state.
  deduplicated?: boolean;
  // The fields below are filled in by addRecord() when a caller leaves them
  // out, so every record in session.history carries them.
  outcome?: CallOutcome;
  toolClass?: ToolClass;
  // The write really reached the (real or simulated) backend and was not
  // rejected there — regardless of what the agent was told. True for a clean
  // success and for a ghost-write (executed, but the agent saw a timeout);
  // false for every other injected failure, for an upstream isError, and
  // for a cache replay.
  tookEffect?: boolean;
  // Set on an injected 429: the retry_after (seconds) the agent was told.
  retryAfterSec?: number;
  // When the harness received the call (timestamp is when it answered).
  receivedAt?: number;
  // Proxy mode: the upstream's real response text when the call executed,
  // even if the agent was shown an injected failure instead.
  upstreamResponse?: string;
  // This call is the one the session's scenario fired on.
  scenarioTriggered?: boolean;
  // The call to the real upstream failed without an answer (timeout, crash,
  // dropped connection): the harness cannot tell whether the write was
  // executed. Such an attempt is neither counted as executed nor as "never
  // executed".
  effectUnknown?: boolean;
}

export interface SessionOptions {
  readToolPatterns?: string[];
  keyFields?: string[];
  retryAfterSec?: number;
}

const sessions = new Map<string, SessionState>();

// Upper bound on sessions kept in memory: a long-running server whose
// clients never call delete_session would otherwise grow without limit.
// The oldest session is dropped first.
const MAX_SESSIONS = 500;

// Heuristic only: a list of common write-verb prefixes can never be
// complete. Tools that match nothing here (and no read prefix) are reported
// as "unclassified" rather than silently treated as harmless — see
// classifyTool(). Callers with unusual naming pass their own patterns
// (--write-tools in proxy mode, start_session's write_tool_patterns); in
// proxy mode MCP tool annotations (readOnlyHint) take precedence over this
// list.
export const DEFAULT_WRITE_TOOL_PATTERNS: string[] = [
  "write*",
  "create_*",
  "send_*",
  "submit_*",
  "post_*",
  "update_*",
  "insert_*",
  "book_*",
  "pay_*",
  "charge_*",
  "cancel_*",
  "delete_*",
  "confirm_*",
  "place_*",
  "add_*",
  "register_*",
  "schedule_*",
  "transfer_*",
  "refund_*",
  "reserve_*",
  "issue_*",
  "remove_*",
  "withdraw_*",
  "deposit_*",
  "purchase_*",
  "approve_*",
];

export const DEFAULT_KEY_FIELDS: string[] = ["idempotency_key"];

export const DEFAULT_RETRY_AFTER_SEC = 60;

export function createSession(
  scenarioId: string | null = null,
  mode: "deterministic" | "chaos" = "deterministic",
  errorRate = 0.0,
  writeToolPatterns: string[] = DEFAULT_WRITE_TOOL_PATTERNS,
  options: SessionOptions = {},
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
      writeToolPatterns.length > 0 ? writeToolPatterns : DEFAULT_WRITE_TOOL_PATTERNS,
    readToolPatterns: options.readToolPatterns ?? [],
    toolClassOverrides: new Map(),
    keyFields:
      options.keyFields && options.keyFields.length > 0
        ? options.keyFields
        : DEFAULT_KEY_FIELDS,
    keyCapableTools: new Set(),
    retryAfterSec: options.retryAfterSec ?? DEFAULT_RETRY_AFTER_SEC,
    scenarioFireCount: 0,
    knownToolsOnly: false,
    kind: "demo",
  };
  sessions.set(session.sessionId, session);

  if (sessions.size > MAX_SESSIONS) {
    let oldest: SessionState | null = null;
    for (const s of sessions.values()) {
      if (s.sessionId === session.sessionId) continue;
      if (!oldest || s.createdAt < oldest.createdAt) oldest = s;
    }
    if (oldest) sessions.delete(oldest.sessionId);
  }

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

function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, "");
}

export function isKeyField(name: string, keyFields: string[]): boolean {
  const normalized = normalizeFieldName(name);
  return keyFields.some((f) => normalizeFieldName(f) === normalized);
}

// The idempotency key a call carries, if any. An empty string counts as
// "no key".
export function extractKey(
  args: Record<string, unknown>,
  keyFields: string[] = DEFAULT_KEY_FIELDS,
): string | undefined {
  for (const [name, value] of Object.entries(args)) {
    if (!isKeyField(name, keyFields)) continue;
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
}

export function stripKeyFields(
  args: Record<string, unknown>,
  keyFields: string[] = DEFAULT_KEY_FIELDS,
): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    if (!isKeyField(name, keyFields)) rest[name] = value;
  }
  return rest;
}

export function classifyTool(session: SessionState, toolName: string): ToolClass {
  const override = session.toolClassOverrides.get(toolName);
  if (override) return override;
  if (session.knownToolsOnly) return "unclassified";
  if (matchesAnyGlob(toolName, session.writeToolPatterns)) return "write";
  // The default patterns are snake_case; match camelCase names through
  // their snake_case form ("bookGoodsReceipt" → "book_goods_receipt").
  if (
    session.writeToolPatterns === DEFAULT_WRITE_TOOL_PATTERNS &&
    matchesAnyGlob(
      toolName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase(),
      DEFAULT_WRITE_TOOL_PATTERNS,
    )
  ) {
    return "write";
  }
  if (isReadTool(toolName) || matchesAnyGlob(toolName, session.readToolPatterns)) {
    return "read";
  }
  return "unclassified";
}

// Marks that the scenario fired on one more write. Deliberately synchronous:
// the caller must not await anything between receiving a call and deciding,
// or two parallel writes would both see "the scenario has not fired yet".
export function reserveScenarioFire(session: SessionState): void {
  session.scenarioFireCount += 1;
}

// Gives a reserved fire back: the scenario was meant for this call but could
// not be applied (the upstream call failed or was rejected), so the next
// write gets it instead.
export function releaseScenarioFire(session: SessionState): void {
  session.scenarioFireCount = Math.max(0, session.scenarioFireCount - 1);
}

export function addRecord(sessionId: string, record: CallRecord): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  record.upstreamExecuted = Boolean(record.upstreamExecuted);
  record.outcome ??= record.injectedError !== null ? "injected_failure" : "success";
  record.toolClass ??= classifyTool(session, record.toolName);
  record.tookEffect ??=
    !record.deduplicated &&
    record.toolClass === "write" &&
    (record.outcome === "success" ||
      (record.outcome === "injected_failure" && record.upstreamExecuted));

  session.history.push(record);

  // Cache replay of an already-committed key: stays in history for the call
  // count, but is a no-op for key-tracking — nothing new was written.
  if (record.deduplicated) return;

  const key = extractKey(record.args, session.keyFields);
  if (!key) return;

  const isWrite = record.toolClass === "write";
  const isError = record.outcome !== "success";

  // Real-value tracking, independent of the keyStates bookkeeping below.
  if (isWrite && record.tookEffect) {
    session.stateDiff.write(key, record.response, record.callNumber);
  } else if (record.toolClass === "read") {
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
          r.toolClass === "read",
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
  session.scenarioFireCount = 0;
  session.pending?.clear();
}

export function deleteSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

// Pattern-only check, without a session's overrides/annotations. Prefer
// classifyTool() wherever a session is at hand.
export function isWriteTool(
  toolName: string,
  patterns: string[] = DEFAULT_WRITE_TOOL_PATTERNS,
): boolean {
  return matchesAnyGlob(toolName, patterns);
}

// Minimal glob support (only "*" as a wildcard) so a write-tool pattern like
// "create_*" or "send_*" can be configured per session instead of hardcoding
// a single "write" prefix — see --write-tools (proxy mode) and
// start_session's write_tool_patterns (live sessions).
export function matchesAnyGlob(name: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesGlob(name, pattern));
}

// Without a regular expression: "*a*a*a*…" as a regex took exponential time
// on a name that almost matches (25 s for one tool name).
function matchesGlob(name: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return name === pattern;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (name.length < first.length + last.length) return false;
  if (!name.startsWith(first) || !name.endsWith(last)) return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const part of parts.slice(1, -1)) {
    if (part === "") continue;
    const found = name.indexOf(part, at);
    if (found === -1 || found + part.length > end) return false;
    at = found + part.length;
  }
  return true;
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
    "search",
    "find",
    "lookup",
    "describe",
    "show",
    "count",
    "view",
    "retrieve",
  ];
  // The prefix must be a whole word ("get_booking", "getBooking", "get"),
  // not just the first letters of a longer one — otherwise "checkout_cart"
  // (a write) would count as a read because it starts with "check".
  const lower = toolName.toLowerCase();
  return prefixes.some((p) => {
    if (!lower.startsWith(p)) return false;
    const rest = toolName.slice(p.length);
    return rest === "" || /^[_\-.A-Z0-9]/.test(rest);
  });
}
