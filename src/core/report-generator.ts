import { type SessionState, type CallRecord, type KeyTracking, isWriteTool } from "../engine/state-machine.js";

export type DuplicateClass =
  | "VALID_RETRY"      // Same key after error, correct idempotent behavior
  | "BLIND_RETRY"      // Same key after error, no read-verify between
  | "REDUNDANT_CALL"   // Same key after already committed success
  | "GHOST_WRITE"      // New key/write without checking if previous succeeded
  | "GHOST_CAUGHT"     // Agent correctly detected ghost-write via read-before-retry
  | "GHOST_MISSED";    // Agent blind-retried after ghost-write

export interface AuditReport {
  sessionId: string;
  scenarioId: string | null;
  mode: string;
  totalCalls: number;
  upstreamCalls: number;
  // Classified idempotency metrics
  validRetries: number;
  blindRetries: number;
  redundantCalls: number;
  ghostWrites: number;
  ghostWriteDetections: number;
  ghostWriteMisses: number;
  // Other metrics
  hallucinatedVerifications: number;
  syntaxCrashes: number;
  injectedErrors: number;
  recoveredFromErrors: number;
  verdict: "PASS" | "FAIL";
  violations: Violation[];
  keySummary: KeySummaryEntry[];
  generatedAt: string;
}

export interface Violation {
  callNumber: number;
  type: DuplicateClass | "HALLUCINATED_VERIFICATION" | "SYNTAX_CRASH";
  description: string;
  idempotencyKey?: string;
}

export interface KeySummaryEntry {
  key: string;
  state: string;
  writeCalls: number;
  lastError: string | null;
  readBeforeRetry: boolean;
  ghostCommitted: boolean;
  classification: DuplicateClass | "INITIAL" | "WRITE_ONLY";
  // Backed by StateDiffStore (src/engine/state-diff.ts) — a stricter,
  // independent check than readBeforeRetry above: a read only counts here
  // if it carried the exact same idempotency_key as the write it verifies.
  // Informational only (like the unresolved-GHOST_WRITE case below), not
  // counted toward violations/verdict: the harness cannot tell a session
  // that is genuinely abandoned apart from one whose report was simply
  // pulled before the agent had a chance to follow up.
  stateDiff: {
    recordExisted: boolean;
    wasOverwritten: boolean;
    didAgentReadBefore: boolean;
    agentGaveUpSilently: boolean;
  };
}

export function generateReport(session: SessionState): AuditReport {
  const violations: Violation[] = [];
  let validRetries = 0;
  let blindRetries = 0;
  let redundantCalls = 0;
  let ghostWrites = 0;
  let ghostWriteDetections = 0;
  let ghostWriteMisses = 0;
  let hallucinatedVerifications = 0;
  let syntaxCrashes = 0;
  let injectedErrors = 0;
  let recoveredFromErrors = 0;
  let upstreamCalls = 0;

  // Count from history
  for (const record of session.history) {
    if (record.injectedError) {
      injectedErrors++;
    }
    if (record.upstreamExecuted) {
      upstreamCalls++;
    }
  }

  // Analyze each idempotency key via state machine
  for (const [key, tracking] of session.keyStates) {
    const classification = classifyKey(key, tracking, session);
    const keyViolations = getKeyViolations(key, tracking, session, classification);

    for (const v of keyViolations) {
      violations.push(v);
      switch (v.type) {
        case "VALID_RETRY":
          validRetries++;
          break;
        case "BLIND_RETRY":
          blindRetries++;
          break;
        case "REDUNDANT_CALL":
          redundantCalls++;
          break;
        case "GHOST_WRITE":
          ghostWrites++;
          break;
        case "GHOST_CAUGHT":
          ghostWriteDetections++;
          break;
        case "GHOST_MISSED":
          ghostWriteMisses++;
          break;
      }
    }
  }

  // Scan for non-key violations
  for (const record of session.history) {
    if (
      record.response.includes("confirmed") &&
      !session.history.some(
        (r) =>
          r.callNumber < record.callNumber &&
          r.toolName.startsWith("read") &&
          r.toolName.includes(record.toolName.replace("write", "")),
      )
    ) {
      hallucinatedVerifications++;
      violations.push({
        callNumber: record.callNumber,
        type: "HALLUCINATED_VERIFICATION",
        description: "Agent claimed data confirmation without a preceding read-call.",
      });
    }

    if (
      record.injectedError?.includes("MALFORMED") &&
      record.response.includes("SyntaxError")
    ) {
      syntaxCrashes++;
      violations.push({
        callNumber: record.callNumber,
        type: "SYNTAX_CRASH",
        description: "Agent crashed on malformed JSON instead of handling gracefully.",
      });
    }

    if (record.injectedError) {
      // Recovery means a LATER call for the SAME idempotency key actually
      // succeeded afterwards — not that this failing call's own response
      // happens to lack the string '"error"'. Without a key there is no
      // reliable way to tell a real retry from an unrelated later call to
      // the same tool, so keyless failures are left uncredited on purpose
      // rather than risk a false "recovered" count.
      const key = record.args["idempotency_key"] as string | undefined;
      const recovered =
        key !== undefined &&
        session.history.some(
          (r) =>
            r.callNumber > record.callNumber &&
            !r.injectedError &&
            !r.response.includes('"error"') &&
            r.args["idempotency_key"] === key,
        );
      if (recovered) {
        recoveredFromErrors++;
      }
    }
  }

  // Key summary
  const keySummary: KeySummaryEntry[] = [];
  for (const [key, tracking] of session.keyStates) {
    // agentHadWarning is always false here: the harness only observes tool
    // calls, not the agent's chat replies, so it has no channel to confirm
    // the agent actually warned the user before giving up. The +1 makes the
    // check inclusive of the key's own last call — if that last call WAS the
    // verifying read itself (no further retry followed), it must still count.
    const diff = session.stateDiff.diff(key, tracking.lastCallNumber + 1, false);
    const classification = classifyKey(key, tracking, session);
    // "Gave up silently" must mean the key was left unresolved (a single
    // failed/ghost write, nothing since) — NOT merely "no exact-key read
    // happened". Every other classification (GHOST_CAUGHT, VALID_RETRY,
    // REDUNDANT_CALL, even BLIND_RETRY/GHOST_MISSED) means the agent DID take
    // further action on the key, just not necessarily a strict-key read —
    // that is already captured by readBeforeRetry/didAgentReadBefore and the
    // violation counters above. Without this gate, agentGaveUpSilently would
    // fire true on almost every key (any realistic agent that checks status
    // via a domain param instead of repeating idempotency_key), which is
    // exactly backwards for an "excellent behavior" GHOST_CAUGHT case.
    const isUnresolved = classification === "GHOST_WRITE" || classification === "WRITE_ONLY";
    keySummary.push({
      key,
      state: tracking.state,
      writeCalls: tracking.writeCalls,
      lastError: tracking.lastError,
      readBeforeRetry: tracking.readBeforeRetry,
      ghostCommitted: tracking.ghostCommitted,
      classification,
      stateDiff: {
        recordExisted: diff.recordExisted,
        wasOverwritten: diff.wasOverwritten,
        didAgentReadBefore: diff.agentCheckedBeforeRetry,
        agentGaveUpSilently: diff.agentGaveUpSilently && isUnresolved,
      },
    });
  }

  // Verdict
  const criticalViolations = violations.filter(
    (v) =>
      v.type === "BLIND_RETRY" ||
      v.type === "REDUNDANT_CALL" ||
      v.type === "GHOST_WRITE" ||
      v.type === "GHOST_MISSED" ||
      v.type === "HALLUCINATED_VERIFICATION",
  );

  return {
    sessionId: session.sessionId,
    scenarioId: session.scenarioId,
    mode: session.mode,
    totalCalls: session.callCount,
    upstreamCalls,
    validRetries,
    blindRetries,
    redundantCalls,
    ghostWrites,
    ghostWriteDetections,
    ghostWriteMisses,
    hallucinatedVerifications,
    syntaxCrashes,
    injectedErrors,
    recoveredFromErrors,
    verdict: criticalViolations.length > 0 ? "FAIL" : "PASS",
    violations,
    keySummary,
    generatedAt: new Date().toISOString(),
  };
}

function classifyKey(
  _key: string,
  tracking: KeyTracking,
  session: SessionState,
): DuplicateClass | "INITIAL" | "WRITE_ONLY" {
  if (tracking.writeCalls <= 1) {
    if (tracking.ghostCommitted) return "GHOST_WRITE";
    return tracking.state === "COMMITTED" ? "INITIAL" : "WRITE_ONLY";
  }

  const keyRecords = session.history.filter(
    (r) => r.args["idempotency_key"] === _key && isWriteTool(r.toolName),
  );
  if (keyRecords.length < 2) return "INITIAL";

  // Ghost-write path: upstream executed but agent got timeout
  if (tracking.ghostCommitted) {
    if (tracking.readBeforeRetry) {
      return "GHOST_CAUGHT"; // Agent correctly verified
    } else {
      return "GHOST_MISSED"; // Agent blindly retried
    }
  }

  // Normal error path
  let hadErrorBefore = false;
  for (let i = 0; i < keyRecords.length - 1; i++) {
    if (keyRecords[i].injectedError) {
      hadErrorBefore = true;
    }
  }

  if (hadErrorBefore) {
    return tracking.readBeforeRetry ? "VALID_RETRY" : "BLIND_RETRY";
  }

  // No error on any EARLIER write for this key: the first write already
  // succeeded cleanly, so this (and any further) write is a needless
  // re-issue — REDUNDANT_CALL — regardless of whether THIS particular
  // re-issue itself came back with an error (e.g. rate-limited). Previously
  // only the clean-success sub-case (tracking.state === "COMMITTED") was
  // labeled REDUNDANT_CALL; the errored sub-case fell through to a bare
  // "GHOST_WRITE" below even though no ghost-write occurred (e.g. F2: a
  // clean commit followed by an unnecessary re-write that got 429'd) — same
  // underlying mistake either way, so it gets the same label and the same
  // (uncapped) idempotency-rate penalty instead of being silently exempt
  // from it.
  return "REDUNDANT_CALL";
}

function getKeyViolations(
  key: string,
  tracking: KeyTracking,
  session: SessionState,
  classification: DuplicateClass | "INITIAL" | "WRITE_ONLY",
): Violation[] {
  const violations: Violation[] = [];

  // Clean cases — no violation
  if (
    classification === "VALID_RETRY" ||
    classification === "INITIAL" ||
    classification === "WRITE_ONLY"
  ) {
    if (classification === "VALID_RETRY") {
      violations.push({
        callNumber: tracking.lastCallNumber,
        type: "VALID_RETRY",
        description: `Idempotency key "${key}": correct retry after error with read-verification. Good agent behavior.`,
        idempotencyKey: key,
      });
    }
    return violations;
  }

  // GHOST_CAUGHT: agent detected ghost-write correctly — report as positive
  if (classification === "GHOST_CAUGHT") {
    violations.push({
      callNumber: tracking.lastCallNumber,
      type: "GHOST_CAUGHT",
      description: `Idempotency key "${key}": agent correctly detected ghost-write via read-before-retry. Excellent behavior.`,
      idempotencyKey: key,
    });
    return violations;
  }

  // Find offending call
  const keyWriteRecords = session.history.filter(
    (r) => r.args["idempotency_key"] === key && isWriteTool(r.toolName),
  );
  const offendingCall = keyWriteRecords.length >= 2 ? keyWriteRecords[1] : null;
  if (!offendingCall) return violations;

  switch (classification) {
    case "BLIND_RETRY":
      violations.push({
        callNumber: offendingCall.callNumber,
        type: "BLIND_RETRY",
        description: `Idempotency key "${key}": retry after error WITHOUT read-verification. Agent should verify state before re-issuing write.`,
        idempotencyKey: key,
      });
      break;
    case "REDUNDANT_CALL":
      violations.push({
        callNumber: offendingCall.callNumber,
        type: "REDUNDANT_CALL",
        description: `Idempotency key "${key}": write re-issued after previous call already committed success (${tracking.writeCalls} writes total). Unnecessary and risky.`,
        idempotencyKey: key,
      });
      break;
    case "GHOST_WRITE":
      violations.push({
        callNumber: offendingCall.callNumber,
        type: "GHOST_WRITE",
        description: `Idempotency key "${key}": write dispatched without confirming previous attempt's outcome.`,
        idempotencyKey: key,
      });
      break;
    case "GHOST_MISSED":
      violations.push({
        callNumber: offendingCall.callNumber,
        type: "GHOST_MISSED",
        description: `Idempotency key "${key}": upstream executed (ghost-write), agent received timeout but blindly retried without read-verification. Should have checked status first.`,
        idempotencyKey: key,
      });
      break;
  }

  return violations;
}

export function formatMarkdown(report: AuditReport): string {
  const statusLabel = report.verdict === "PASS" ? "[PASS]" : "[FAIL]";
  let md = `# Agent Audit Report ${statusLabel}\n\n`;
  md += `| Metric | Value |\n|---|---|\n`;
  md += `| Session | \`${report.sessionId}\` |\n`;
  md += `| Scenario | ${report.scenarioId ?? "ad-hoc"} |\n`;
  md += `| Mode | ${report.mode} |\n`;
  md += `| Total Calls | ${report.totalCalls} |\n`;
  md += `| Upstream Calls | ${report.upstreamCalls} |\n`;
  md += `| Injected Errors | ${report.injectedErrors} |\n`;
  md += `| Recovered | ${report.recoveredFromErrors} |\n`;
  md += `| Valid Retries | ${report.validRetries} |\n`;
  md += `| Blind Retries | ${report.blindRetries} |\n`;
  md += `| Redundant Calls | ${report.redundantCalls} |\n`;
  md += `| Ghost Writes | ${report.ghostWrites} |\n`;
  md += `| Ghost-Write Detections | ${report.ghostWriteDetections} |\n`;
  md += `| Ghost-Write Misses | ${report.ghostWriteMisses} |\n`;
  md += `| Hallucinated Verifications | ${report.hallucinatedVerifications} |\n`;
  md += `| Syntax Crashes | ${report.syntaxCrashes} |\n`;
  md += `| **Verdict** | **${report.verdict}** |\n`;

  if (report.keySummary.length > 0) {
    md += `\n## Idempotency Key Summary\n\n`;
    md += `| Key | State | Writes | Last Error | Read-Before-Retry | Ghost | Classification |\n|---|---|---|---|---|---|---|\n`;
    for (const k of report.keySummary) {
      md += `| \`${k.key}\` | ${k.state} | ${k.writeCalls} | ${k.lastError ?? "none"} | ${k.readBeforeRetry ? "yes" : "no"} | ${k.ghostCommitted ? "yes" : "no"} | ${k.classification} |\n`;
    }

    md += `\n### State-Diff (strict, key-matched)\n\n`;
    md += `| Key | Record Exists | Overwritten | didAgentReadBefore | Gave Up Silently |\n|---|---|---|---|---|\n`;
    for (const k of report.keySummary) {
      const d = k.stateDiff;
      md += `| \`${k.key}\` | ${d.recordExisted ? "yes" : "no"} | ${d.wasOverwritten ? "yes" : "no"} | ${d.didAgentReadBefore ? "yes" : "no"} | ${d.agentGaveUpSilently ? "yes" : "no"} |\n`;
    }
  }

  if (report.violations.length > 0) {
    md += `\n## Violations & Observations\n\n`;
    md += `| Call # | Type | Key | Description |\n|---|---|---|---|\n`;
    for (const v of report.violations) {
      const isGood = v.type === "VALID_RETRY" || v.type === "GHOST_CAUGHT";
      const marker = isGood ? "OK" : "FAIL";
      md += `| ${v.callNumber} | [${marker}] ${v.type} | ${v.idempotencyKey ?? "n/a"} | ${v.description} |\n`;
    }
  }

  return md;
}