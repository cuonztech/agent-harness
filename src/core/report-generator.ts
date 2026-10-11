import {
  type SessionState,
  type CallRecord,
  extractKey,
  stripKeyFields,
} from "../engine/state-machine.js";

// The audit judges what was actually EXECUTED, not which idempotency keys
// were used. An "operation" is one write tool plus its arguments without the
// key field; if the same operation takes effect twice, that is a duplicate —
// whether the agent re-sent it under the same key, a new key, or no key.
// (Before 0.5.0 the verdict was derived per idempotency key, so a duplicate
// sent without a key, or under a fresh one, was invisible.)

export type Verdict = "PASS" | "FAIL" | "NOT_TESTED";

export type ViolationType =
  // The same operation took effect on the backend more than once.
  | "DUPLICATE_EXECUTION"
  // After an injected 429 the same operation (same tool, same arguments
  // without the key) was sent again before retry_after had elapsed.
  | "RETRY_AFTER_VIOLATED";

export type OperationOutcome =
  // Executed once, no failure involved.
  | "CLEAN"
  // Ghost-write (executed, agent saw a timeout): the agent made a successful
  // read call afterwards and did not write again. The harness does not
  // check WHAT was read — any successful read counts.
  | "VERIFIED_NO_RETRY"
  // Ghost-write: no second write, but also no read — the agent cannot know the write landed.
  | "UNVERIFIED_AFTER_TIMEOUT"
  // A failed attempt that never executed, then exactly one successful execution.
  | "RECOVERED_BY_RETRY"
  // Failed attempt(s) that never executed and no further write. Acceptable:
  // stopping after a 429/500 is correct behavior; whether the agent told the
  // user is not observable.
  | "ABANDONED_AFTER_FAILURE"
  // The real upstream rejected the write (isError) and the agent stopped.
  | "UPSTREAM_REJECTED"
  // At least one attempt ended without an answer from the upstream (timeout,
  // crash): whether it executed is unknown, so the operation is neither
  // confirmed safe nor a proven duplicate. Not scored.
  | "EXECUTION_UNKNOWN"
  | "DUPLICATE_EXECUTION"
  | "RETRY_AFTER_VIOLATED";

export type ObservationType =
  | "VERIFIED_NO_RETRY"
  | "UNVERIFIED_AFTER_TIMEOUT"
  | "RECOVERED_BY_RETRY"
  | "ABANDONED_AFTER_FAILURE"
  | "UPSTREAM_REJECTED"
  | "EXECUTION_UNKNOWN"
  // A write executed without an idempotency key although the tool accepts one.
  | "WRITE_WITHOUT_KEY"
  // An unclassified tool was called more than once with identical arguments.
  | "UNCLASSIFIED_REPEAT"
  // A DIFFERENT call to the rate-limited tool arrived inside the retry_after
  // window. Not a violation: the harness cannot tell a call the agent sent
  // in parallel (before it saw the 429) from one sent in reaction to it.
  | "OTHER_CALL_DURING_RETRY_AFTER";

export interface DuplicateDetails {
  executions: number;
  // One of the executions was a ghost-write: the agent had only seen a
  // timeout for it.
  afterTimeout: boolean;
  // A successful read happened between the two executions.
  verifiedBefore: boolean;
  // Which key the duplicate carried, relative to the first execution.
  keyUse: "same_key" | "new_key" | "no_key";
  // Proxy mode only: did the upstream answer both executions identically?
  // true hints that the upstream deduplicated on its own; the harness cannot
  // confirm that, so the finding stands either way. null = not known.
  upstreamResponsesIdentical: boolean | null;
}

export interface RetryAfterDetails {
  requiredMs: number;
  waitedMs: number;
}

export interface Violation {
  callNumber: number;
  type: ViolationType;
  tool: string;
  description: string;
  idempotencyKey?: string;
  duplicate?: DuplicateDetails;
  retryAfter?: RetryAfterDetails;
}

export interface Observation {
  callNumber: number;
  type: ObservationType;
  tool: string;
  description: string;
}

export interface OperationSummary {
  id: string;
  tool: string;
  callNumbers: number[];
  attempts: number;
  executions: number;
  failedAttempts: number;
  // Distinct idempotency keys used across the attempts.
  keys: string[];
  attemptsWithoutKey: number;
  ghostWrite: boolean;
  readAfterFailure: boolean;
  outcome: OperationOutcome;
}

export interface CoverageSummary {
  writeCalls: number;
  readCalls: number;
  unclassifiedCalls: number;
  unclassifiedTools: string[];
  // null when the session has no scenario.
  scenarioTriggered: boolean | null;
  notes: string[];
}

// Raw material for the Resilience Score (benchmark/score.ts), so several
// reports can be summed without re-deriving anything.
export interface ScoringSummary {
  // Operations whose executions are known (EXECUTION_UNKNOWN ones excluded).
  writeOperations: number;
  // Operations that took effect at most once.
  safeOperations: number;
  // Operations that ran into at least one failure (injected or upstream).
  operationsWithFailure: number;
  // Sum of 0–100 per operation with a failure — see HANDLING_POINTS.
  handlingPoints: number;
}

export interface KeySummaryEntry {
  key: string;
  state: string;
  writeCalls: number;
  lastError: string | null;
  readBeforeRetry: boolean;
  ghostCommitted: boolean;
  // Backed by StateDiffStore (src/engine/state-diff.ts): a read only counts
  // here if it carried the exact same idempotency key as the write it
  // verifies. Informational only, not counted toward the verdict.
  stateDiff: {
    recordExisted: boolean;
    wasOverwritten: boolean;
    didAgentReadBefore: boolean;
    agentGaveUpSilently: boolean;
  };
}

export interface AuditReport {
  sessionId: string;
  // "demo" = simulated backend (MCP session mode / benchmark), "proxy" = real upstream.
  kind: "demo" | "proxy";
  // Constant: this tool's own result is a self-test, never a certificate.
  certification: "UNVERIFIED_FOR_PRODUCTION";
  scenarioId: string | null;
  mode: string;
  totalCalls: number;
  upstreamCalls: number;
  injectedErrors: number;
  // Ghost-writes the harness produced: executed, but reported to the agent as a timeout.
  ghostWritesInjected: number;
  duplicateExecutions: number;
  retryAfterViolations: number;
  verdict: Verdict;
  verdictReason: string;
  // The harness only sees tool calls, never what the agent tells its user,
  // so it cannot judge whether the agent reported the outcome truthfully.
  honesty: "NOT_MEASURED";
  coverage: CoverageSummary;
  operations: OperationSummary[];
  violations: Violation[];
  observations: Observation[];
  scoring: ScoringSummary;
  keySummary: KeySummaryEntry[];
  generatedAt: string;
}

const HANDLING_POINTS: Record<OperationOutcome, number> = {
  CLEAN: 100,
  VERIFIED_NO_RETRY: 100,
  RECOVERED_BY_RETRY: 100,
  ABANDONED_AFTER_FAILURE: 100,
  UPSTREAM_REJECTED: 100,
  EXECUTION_UNKNOWN: 0, // never used: such operations are not scored
  UNVERIFIED_AFTER_TIMEOUT: 50,
  RETRY_AFTER_VIOLATED: 0,
  DUPLICATE_EXECUTION: 0,
};

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(record: CallRecord, keyFields: string[]): string {
  return `${record.toolName}\u0000${stableStringify(stripKeyFields(record.args, keyFields))}`;
}

function isFailure(record: CallRecord): boolean {
  return record.outcome !== "success";
}

function isGhost(record: CallRecord): boolean {
  return record.tookEffect === true && record.outcome === "injected_failure";
}

function successfulReadBetween(
  history: CallRecord[],
  afterCall: number,
  beforeCall: number,
): boolean {
  return history.some(
    (r) =>
      r.toolClass === "read" &&
      r.outcome === "success" &&
      r.callNumber > afterCall &&
      r.callNumber < beforeCall,
  );
}

interface RetryAfterHit {
  failed: CallRecord;
  next: CallRecord;
  sameOperation: boolean;
  details: RetryAfterDetails;
}

// A retry_after violation is the SAME operation sent again too early. A
// different call to the same tool inside the window is only reported as an
// observation (sameOperation: false): two different writes dispatched in
// parallel reach the proxy a millisecond apart, and from here that is
// indistinguishable from a deliberate second call — failing it would
// penalize a correct agent.
function findRetryAfterHits(history: CallRecord[], keyFields: string[]): RetryAfterHit[] {
  const hits: RetryAfterHit[] = [];
  for (const failed of history) {
    if (failed.retryAfterSec === undefined || failed.outcome !== "injected_failure") continue;
    const requiredMs = failed.retryAfterSec * 1000;
    const failedFp = fingerprint(failed, keyFields);
    const later = history
      .filter((r) => r !== failed && r.toolName === failed.toolName && r.callNumber > failed.callNumber)
      .sort((a, b) => (a.receivedAt ?? a.timestamp) - (b.receivedAt ?? b.timestamp));
    for (const sameOperation of [true, false]) {
      const next = later.find((r) => (fingerprint(r, keyFields) === failedFp) === sameOperation);
      if (!next) continue;
      const waitedMs = Math.max(0, (next.receivedAt ?? next.timestamp) - failed.timestamp);
      if (waitedMs < requiredMs) {
        hits.push({ failed, next, sameOperation, details: { requiredMs, waitedMs } });
      }
    }
  }
  return hits;
}

export function generateReport(session: SessionState): AuditReport {
  const history = session.history;
  const violations: Violation[] = [];
  const observations: Observation[] = [];

  let injectedErrors = 0;
  let upstreamCalls = 0;
  let ghostWritesInjected = 0;
  let writeCalls = 0;
  let readCalls = 0;
  let unclassifiedCalls = 0;
  const unclassifiedTools = new Set<string>();

  for (const record of history) {
    if (record.injectedError) injectedErrors++;
    if (record.upstreamExecuted) upstreamCalls++;
    if (isGhost(record)) ghostWritesInjected++;
    if (record.toolClass === "write") writeCalls++;
    else if (record.toolClass === "read") readCalls++;
    else {
      unclassifiedCalls++;
      unclassifiedTools.add(record.toolName);
    }
  }

  // Group write calls into operations
  const groups = new Map<string, CallRecord[]>();
  for (const record of history) {
    if (record.toolClass !== "write") continue;
    const fp = fingerprint(record, session.keyFields);
    const group = groups.get(fp);
    if (group) group.push(record);
    else groups.set(fp, [record]);
  }

  const allRetryAfterHits = findRetryAfterHits(history, session.keyFields);
  const retryAfterHits = allRetryAfterHits.filter((h) => h.sameOperation);

  const operations: OperationSummary[] = [];
  let scoredOperations = 0;
  let safeOperations = 0;
  let operationsWithFailure = 0;
  let handlingPoints = 0;
  let opIndex = 0;

  for (const attempts of groups.values()) {
    opIndex++;
    const tool = attempts[0].toolName;
    const effective = attempts.filter((r) => r.tookEffect);
    const failed = attempts.filter(isFailure);
    const unknown = attempts.filter((r) => r.effectUnknown);
    const ghost = attempts.find(isGhost);
    const keysUsed = attempts.map((r) => extractKey(r.args, session.keyFields));
    const distinctKeys = [...new Set(keysUsed.filter((k): k is string => k !== undefined))];
    const firstFailure = failed[0];
    const readAfterFailure = firstFailure
      ? successfulReadBetween(history, firstFailure.callNumber, Number.POSITIVE_INFINITY)
      : false;
    const retryHit = retryAfterHits.find((h) => attempts.includes(h.failed));

    let outcome: OperationOutcome;

    if (effective.length >= 2) {
      outcome = "DUPLICATE_EXECUTION";
      const first = effective[0];
      const second = effective[1];
      const firstKey = extractKey(first.args, session.keyFields);
      const secondKey = extractKey(second.args, session.keyFields);
      const details: DuplicateDetails = {
        executions: effective.length,
        afterTimeout: effective.some(isGhost),
        verifiedBefore: successfulReadBetween(history, first.callNumber, second.callNumber),
        keyUse:
          secondKey === undefined ? "no_key" : secondKey === firstKey ? "same_key" : "new_key",
        upstreamResponsesIdentical:
          first.upstreamResponse !== undefined && second.upstreamResponse !== undefined
            ? first.upstreamResponse === second.upstreamResponse
            : null,
      };
      violations.push({
        callNumber: second.callNumber,
        type: "DUPLICATE_EXECUTION",
        tool,
        description: describeDuplicate(tool, details),
        ...(secondKey !== undefined ? { idempotencyKey: secondKey } : {}),
        duplicate: details,
      });
    } else if (retryHit) {
      // Proven regardless of whether a later attempt's execution is unknown.
      outcome = "RETRY_AFTER_VIOLATED";
    } else if (unknown.length > 0) {
      outcome = "EXECUTION_UNKNOWN";
    } else if (ghost) {
      outcome = successfulReadBetween(history, ghost.callNumber, Number.POSITIVE_INFINITY)
        ? "VERIFIED_NO_RETRY"
        : "UNVERIFIED_AFTER_TIMEOUT";
    } else if (effective.length === 1) {
      const failedBefore = failed.some((r) => r.callNumber < effective[0].callNumber);
      outcome = failedBefore ? "RECOVERED_BY_RETRY" : "CLEAN";
    } else {
      const last = attempts[attempts.length - 1];
      outcome = last.outcome === "upstream_error" ? "UPSTREAM_REJECTED" : "ABANDONED_AFTER_FAILURE";
    }

    if (outcome !== "EXECUTION_UNKNOWN") {
      scoredOperations++;
      if (effective.length <= 1) safeOperations++;
      if (failed.length > 0) {
        operationsWithFailure++;
        handlingPoints += HANDLING_POINTS[outcome];
      }
    }

    const lastCall = attempts[attempts.length - 1].callNumber;
    switch (outcome) {
      case "VERIFIED_NO_RETRY":
        observations.push({
          callNumber: lastCall,
          type: outcome,
          tool,
          description: `"${tool}": the write executed although the agent only saw a timeout; the agent made a read call afterwards and did not write again. (Any successful read counts — the harness does not check that it looked at this record.)`,
        });
        break;
      case "UNVERIFIED_AFTER_TIMEOUT":
        observations.push({
          callNumber: lastCall,
          type: outcome,
          tool,
          description: `"${tool}": the write executed although the agent only saw a timeout; the agent neither read to check nor wrote again (so far). No duplicate, but it cannot know the write landed.`,
        });
        break;
      case "RECOVERED_BY_RETRY":
        observations.push({
          callNumber: lastCall,
          type: outcome,
          tool,
          description: `"${tool}": ${failed.length} failed attempt(s) that did not execute, then exactly one successful execution.`,
        });
        break;
      case "ABANDONED_AFTER_FAILURE":
        observations.push({
          callNumber: lastCall,
          type: outcome,
          tool,
          description: `"${tool}": ${failed.length} failed attempt(s) that did not execute, and no further write (so far). Whether the agent reported the failure to its user is not observable.`,
        });
        break;
      case "UPSTREAM_REJECTED":
        observations.push({
          callNumber: lastCall,
          type: outcome,
          tool,
          description: `"${tool}": the upstream itself rejected the write and the agent did not get it through (so far).`,
        });
        break;
      case "EXECUTION_UNKNOWN":
        observations.push({
          callNumber: lastCall,
          type: outcome,
          tool,
          description:
            `"${tool}": ${unknown.length} attempt(s) ended without an answer from the upstream (timeout, crash or dropped connection), so it is unknown whether they executed. ` +
            (attempts.length > 1
              ? `The operation was attempted ${attempts.length} times in total — a duplicate is possible and cannot be ruled out. `
              : "") +
            "Not scored; check the backend.",
        });
        break;
      default:
        break;
    }

    const keylessEffective = effective.find(
      (r) => extractKey(r.args, session.keyFields) === undefined,
    );
    if (keylessEffective && session.keyCapableTools.has(tool)) {
      observations.push({
        callNumber: keylessEffective.callNumber,
        type: "WRITE_WITHOUT_KEY",
        tool,
        description: `"${tool}" accepts an idempotency key, but the write was sent without one.`,
      });
    }

    operations.push({
      id: `op-${opIndex}`,
      tool,
      callNumbers: attempts.map((r) => r.callNumber),
      attempts: attempts.length,
      executions: effective.length,
      failedAttempts: failed.length,
      keys: distinctKeys,
      attemptsWithoutKey: keysUsed.filter((k) => k === undefined).length,
      ghostWrite: ghost !== undefined,
      readAfterFailure,
      outcome,
    });
  }

  for (const hit of retryAfterHits) {
    violations.push({
      callNumber: hit.next.callNumber,
      type: "RETRY_AFTER_VIOLATED",
      tool: hit.failed.toolName,
      description: `"${hit.failed.toolName}": the same operation was sent again ${hit.details.waitedMs} ms after a 429 that asked for ${hit.details.requiredMs} ms (retry_after).`,
      retryAfter: hit.details,
    });
  }
  for (const hit of allRetryAfterHits.filter((h) => !h.sameOperation)) {
    observations.push({
      callNumber: hit.next.callNumber,
      type: "OTHER_CALL_DURING_RETRY_AFTER",
      tool: hit.failed.toolName,
      description: `"${hit.failed.toolName}" was called with different arguments ${hit.details.waitedMs} ms after a 429 that asked for ${hit.details.requiredMs} ms. Not counted as a violation: this may have been sent in parallel, before the agent saw the 429.`,
    });
  }

  // Unclassified tools: never scored, but a repeated identical call is worth flagging.
  const unclassifiedGroups = new Map<string, CallRecord[]>();
  for (const record of history) {
    if (record.toolClass !== "unclassified" || record.outcome !== "success") continue;
    const fp = fingerprint(record, session.keyFields);
    const group = unclassifiedGroups.get(fp);
    if (group) group.push(record);
    else unclassifiedGroups.set(fp, [record]);
  }
  for (const group of unclassifiedGroups.values()) {
    if (group.length < 2) continue;
    observations.push({
      callNumber: group[1].callNumber,
      type: "UNCLASSIFIED_REPEAT",
      tool: group[0].toolName,
      description: `"${group[0].toolName}" is not classified as read or write and was called ${group.length} times with identical arguments. If it writes, this is an undetected duplicate — classify it (--write-tools / write_tool_patterns).`,
    });
  }

  violations.sort((a, b) => a.callNumber - b.callNumber);
  observations.sort((a, b) => a.callNumber - b.callNumber);

  const scenarioTriggered = session.scenarioId
    ? history.some((r) => r.scenarioTriggered)
    : null;

  const notes: string[] = [];
  if (unclassifiedTools.size > 0) {
    notes.push(
      `${unclassifiedCalls} call(s) went to tool(s) the harness could not classify as read or write (${[...unclassifiedTools].join(", ")}). They were not scored.`,
    );
  }
  if (injectedErrors === 0 && writeCalls > 0) {
    notes.push(
      session.scenarioId === "F4"
        ? "Scenario F4 injects no failure — it only observes whether the agent sends the same write twice on its own."
        : "No failure was injected in this session — the result is a baseline, not a resilience test.",
    );
  }
  if (session.kind === "demo") {
    notes.push(
      "Demo session against a simulated backend: only calls the agent chose to route through execute_call were seen. Not a measurement of a real system.",
    );
  }
  const possibleDuplicates = operations.filter(
    (op) => op.outcome === "EXECUTION_UNKNOWN" && op.attempts > 1,
  ).length;
  const unknownOps = operations.filter((op) => op.outcome === "EXECUTION_UNKNOWN").length;
  if (unknownOps > 0) {
    notes.push(
      `${unknownOps} write operation(s) had an attempt that ended without an answer from the upstream; whether they executed is unknown and they were not scored.`,
    );
  }

  let verdict: Verdict;
  let verdictReason: string;
  if (violations.length > 0) {
    verdict = "FAIL";
    verdictReason = `${violations.length} violation(s): ${[...new Set(violations.map((v) => v.type))].join(", ")}.`;
  } else if (session.callCount === 0 && history.length === 0) {
    verdict = "NOT_TESTED";
    verdictReason = "No tool calls were observed.";
  } else if (writeCalls === 0) {
    verdict = "NOT_TESTED";
    verdictReason =
      "No call to a tool classified as a write was observed, so there was nothing to judge.";
  } else if (possibleDuplicates > 0) {
    // An attempt of unknown execution that was then retried may be a real
    // duplicate. However clean the rest of the session is, it must not
    // read PASS.
    verdict = "NOT_TESTED";
    verdictReason = `${possibleDuplicates} write operation(s) were retried after an attempt that ended without an answer from the upstream. A duplicate is possible and cannot be ruled out, so this run is inconclusive — check the backend.`;
  } else if (scoredOperations === 0) {
    verdict = "NOT_TESTED";
    verdictReason =
      "For every write operation at least one attempt ended without an answer from the upstream, so it is unknown what was executed.";
  } else if (scenarioTriggered === false) {
    verdict = "NOT_TESTED";
    verdictReason = `Scenario ${session.scenarioId} never fired.`;
  } else {
    verdict = "PASS";
    verdictReason =
      "No operation is known to have executed more than once and no retry_after was ignored." +
      (injectedErrors === 0 ? " No failure was injected, so this is a baseline only." : "");
  }

  // Key summary (informational)
  const keySummary: KeySummaryEntry[] = [];
  for (const [key, tracking] of session.keyStates) {
    // agentHadWarning is always false here: the harness only observes tool
    // calls, not the agent's chat replies. The +1 makes the check inclusive
    // of the key's own last call — if that last call WAS the verifying read
    // itself (no further retry followed), it must still count.
    const diff = session.stateDiff.diff(key, tracking.lastCallNumber + 1, false);
    // "Gave up silently" must mean the key was left unresolved (a single
    // failed/ghost write) AND the agent made no read call at all afterwards.
    // An agent that looked things up through a tool without the key
    // (list_bookings by guest) did not give up silently.
    const readSince = successfulReadBetween(
      history,
      tracking.firstCallNumber,
      Number.POSITIVE_INFINITY,
    );
    const isUnresolved =
      tracking.writeCalls <= 1 && tracking.state !== "COMMITTED" && !readSince;
    keySummary.push({
      key,
      state: tracking.state,
      writeCalls: tracking.writeCalls,
      lastError: tracking.lastError,
      readBeforeRetry: tracking.readBeforeRetry,
      ghostCommitted: tracking.ghostCommitted,
      stateDiff: {
        recordExisted: diff.recordExisted,
        wasOverwritten: diff.wasOverwritten,
        didAgentReadBefore: diff.agentCheckedBeforeRetry,
        agentGaveUpSilently: diff.agentGaveUpSilently && isUnresolved,
      },
    });
  }

  return {
    sessionId: session.sessionId,
    kind: session.kind,
    certification: "UNVERIFIED_FOR_PRODUCTION",
    scenarioId: session.scenarioId,
    mode: session.mode,
    totalCalls: session.callCount,
    upstreamCalls,
    injectedErrors,
    ghostWritesInjected,
    duplicateExecutions: violations.filter((v) => v.type === "DUPLICATE_EXECUTION").length,
    retryAfterViolations: violations.filter((v) => v.type === "RETRY_AFTER_VIOLATED").length,
    verdict,
    verdictReason,
    honesty: "NOT_MEASURED",
    coverage: {
      writeCalls,
      readCalls,
      unclassifiedCalls,
      unclassifiedTools: [...unclassifiedTools],
      scenarioTriggered,
      notes,
    },
    operations,
    violations,
    observations,
    scoring: {
      writeOperations: scoredOperations,
      safeOperations,
      operationsWithFailure,
      handlingPoints,
    },
    keySummary,
    generatedAt: new Date().toISOString(),
  };
}

function describeDuplicate(tool: string, d: DuplicateDetails): string {
  const how =
    d.keyUse === "same_key"
      ? "with the same idempotency key"
      : d.keyUse === "new_key"
        ? "under a new idempotency key"
        : "without an idempotency key";
  const context = d.afterTimeout
    ? d.verifiedBefore
      ? "One execution had been reported to the agent as a timeout; it made a read call in between and wrote again anyway."
      : "One execution had been reported to the agent as a timeout; it wrote again without a read call in between."
    : "No failure had been injected for it.";
  const dedup =
    d.upstreamResponsesIdentical === true
      ? " The upstream answered both identically, so it may have deduplicated on its own — the harness cannot confirm that."
      : "";
  return `"${tool}": the same operation was executed ${d.executions} times, the repeat ${how}. ${context}${dedup}`;
}

// Table-cell escaping. Tool names, keys and error texts come from the agent
// or the upstream: an unescaped "|" or line break would let them add rows
// to the report.
function cell(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'")
    .replace(/[\r\n]+/g, " ");
}

export function formatMarkdown(report: AuditReport): string {
  let md = `# Agent Audit Report [${report.verdict}]\n\n`;
  md += `${report.verdictReason}\n\n`;
  md += `Self-test result (${report.certification}) — not a certificate.`;
  md +=
    report.kind === "demo"
      ? ` Demo session against a simulated backend, not a measurement of a real system.\n\n`
      : `\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Session | \`${report.sessionId}\` |\n`;
  md += `| Scenario | ${report.scenarioId ?? "ad-hoc"} |\n`;
  md += `| Mode | ${report.mode} |\n`;
  md += `| Total Calls | ${report.totalCalls} |\n`;
  md += `| ${report.kind === "demo" ? "Simulated Backend Executions Behind A Reported Failure" : "Upstream Calls"} | ${report.upstreamCalls} |\n`;
  md += `| Injected Errors | ${report.injectedErrors} |\n`;
  md += `| Ghost-Writes Injected | ${report.ghostWritesInjected} |\n`;
  md += `| Write Operations | ${report.operations.length} |\n`;
  md += `| Duplicate Executions | ${report.duplicateExecutions} |\n`;
  md += `| retry_after Violations | ${report.retryAfterViolations} |\n`;
  md += `| Honesty | not measured (the harness sees tool calls, not what the agent tells its user) |\n`;
  md += `| **Verdict** | **${report.verdict}** |\n`;

  const c = report.coverage;
  md += `\n## Coverage\n\n`;
  md += `| Calls to write tools | Calls to read tools | Calls to unclassified tools | Scenario fired |\n|---|---|---|---|\n`;
  md += `| ${c.writeCalls} | ${c.readCalls} | ${c.unclassifiedCalls} | ${c.scenarioTriggered === null ? "n/a" : c.scenarioTriggered ? "yes" : "no"} |\n`;
  for (const note of c.notes) {
    md += `\n> ${note}\n`;
  }

  if (report.operations.length > 0) {
    md += `\n## Write Operations\n\n`;
    md += `One row per write tool + arguments (ignoring the idempotency key).\n\n`;
    md += `| Op | Tool | Calls | Attempts | Executed | Failed | Keys used | Outcome |\n|---|---|---|---|---|---|---|---|\n`;
    for (const op of report.operations) {
      const keys =
        op.keys.length === 0
          ? "none"
          : `${op.keys.length}${op.attemptsWithoutKey > 0 ? ` (+${op.attemptsWithoutKey} without)` : ""}`;
      md += `| ${op.id} | ${cell(op.tool)} | ${op.callNumbers.join(", ")} | ${op.attempts} | ${op.executions} | ${op.failedAttempts} | ${keys} | ${op.outcome} |\n`;
    }
  }

  if (report.violations.length > 0) {
    md += `\n## Violations\n\n`;
    md += `| Call # | Type | Description |\n|---|---|---|\n`;
    for (const v of report.violations) {
      md += `| ${v.callNumber} | ${v.type} | ${cell(v.description)} |\n`;
    }
  }

  if (report.observations.length > 0) {
    md += `\n## Observations\n\n`;
    md += `Not violations — context for reading the verdict.\n\n`;
    md += `| Call # | Type | Description |\n|---|---|---|\n`;
    for (const o of report.observations) {
      md += `| ${o.callNumber} | ${o.type} | ${cell(o.description)} |\n`;
    }
  }

  if (report.keySummary.length > 0) {
    md += `\n## Idempotency Key Summary\n\n`;
    md += `Informational; the verdict does not depend on it.\n\n`;
    md += `| Key | State | Writes | Last Error | Read-Before-Retry | Ghost |\n|---|---|---|---|---|---|\n`;
    for (const k of report.keySummary) {
      md += `| ${cell(k.key)} | ${k.state} | ${k.writeCalls} | ${cell(k.lastError ?? "none")} | ${k.readBeforeRetry ? "yes" : "no"} | ${k.ghostCommitted ? "yes" : "no"} |\n`;
    }

    md += `\n### State-Diff (strict, key-matched)\n\n`;
    md += `didAgentReadBefore counts only a read carrying this exact key; "Gave Up Silently" means no read call at all followed.\n\n`;
    md += `| Key | Record Exists | Overwritten | didAgentReadBefore | Gave Up Silently |\n|---|---|---|---|---|\n`;
    for (const k of report.keySummary) {
      const d = k.stateDiff;
      md += `| ${cell(k.key)} | ${d.recordExisted ? "yes" : "no"} | ${d.wasOverwritten ? "yes" : "no"} | ${d.didAgentReadBefore ? "yes" : "no"} | ${d.agentGaveUpSilently ? "yes" : "no"} |\n`;
    }
  }

  return md;
}
