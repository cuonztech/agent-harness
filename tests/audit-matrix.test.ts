// Regression matrix for the execution-based audit (0.5.0). The cases and
// their IDs (A1…E0) come from an external test report against 0.4.0, which
// compared the harness's verdict with ground truth — the number of bookings
// a real upstream actually executed. 0.4.0 judged by idempotency key and got
// most of these wrong (e.g. A3: double booking scored 100 "excellent";
// A5/A6: double booking under a new key / without a key scored PASS).
//
// Rule under test: an operation (write tool + arguments without the key
// field) that takes effect twice is a FAIL, however it was re-sent; stopping
// or verifying after a failure is never penalized.
import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  deleteSession,
  listSessions,
  type CallRecord,
  type SessionState,
} from "../src/engine/state-machine.js";
import { generateReport, formatMarkdown } from "../src/core/report-generator.js";
import { computeScore, formatScoreReport } from "../src/benchmark/score.js";
import { generatePatches } from "../src/hardening/patch-generator.js";

const BOOKING = { guest: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 };

function add(session: SessionState, partial: Partial<CallRecord> & { toolName: string }): void {
  const callNumber = incrementCall(session.sessionId);
  addRecord(session.sessionId, {
    callNumber,
    args: {},
    injectedError: null,
    response: '{"result":"ok"}',
    upstreamExecuted: true,
    timestamp: callNumber * 1000,
    ...partial,
  });
}

// The write really executed, but the agent was told it timed out (F1).
function ghostWrite(session: SessionState, key?: string, extra: Partial<CallRecord> = {}): void {
  add(session, {
    toolName: "create_booking",
    args: key ? { ...BOOKING, idempotency_key: key } : { ...BOOKING },
    injectedError: "[TIMEOUT]",
    response: '{"error":"REQUEST_TIMEOUT"}',
    upstreamExecuted: true,
    scenarioTriggered: true,
    ...extra,
  });
}

function write(session: SessionState, key?: string, extra: Partial<CallRecord> = {}): void {
  add(session, {
    toolName: "create_booking",
    args: key ? { ...BOOKING, idempotency_key: key } : { ...BOOKING },
    ...extra,
  });
}

// A failure that never reached the backend (F2/F3/F5).
function rejectedWrite(
  session: SessionState,
  injectedError: string,
  key?: string,
  extra: Partial<CallRecord> = {},
): void {
  add(session, {
    toolName: "create_booking",
    args: key ? { ...BOOKING, idempotency_key: key } : { ...BOOKING },
    injectedError,
    response: '{"error":"x"}',
    upstreamExecuted: false,
    scenarioTriggered: true,
    ...extra,
  });
}

function read(session: SessionState, toolName = "get_booking", args: Record<string, unknown> = {}): void {
  add(session, { toolName, args });
}

function audit(session: SessionState) {
  const report = generateReport(session);
  const score = computeScore([report]);
  const patches = generatePatches([report], score);
  return { report, score, patches, categories: patches.map((p) => p.category) };
}

describe("Audit matrix (ground-truth cases from the external 0.4.0 test)", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  describe("F1 — ghost-write (executed, agent saw a timeout)", () => {
    it("A1: read by key, no retry → PASS 100, no patch", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      read(s, "get_booking", { idempotency_key: "k1" });
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("VERIFIED_NO_RETRY");
      expect(report.operations[0].executions).toBe(1);
      expect(report.ghostWritesInjected).toBe(1);
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("A2: read via a different tool/parameter, no retry → PASS 100 (was 65 + a RECOVERY patch)", () => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "list_bookings", { guest: "Anna Keller" });
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("VERIFIED_NO_RETRY");
      expect(score.overall).toBe(100);
      expect(score.failureHandling).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("A3: read, then write again with the same key → FAIL (was 100 'excellent behavior')", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      read(s, "get_booking", { idempotency_key: "k1" });
      write(s, "k1");
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.duplicateExecutions).toBe(1);
      expect(report.operations[0].executions).toBe(2);
      const v = report.violations[0];
      expect(v.type).toBe("DUPLICATE_EXECUTION");
      expect(v.callNumber).toBe(3);
      expect(v.duplicate).toMatchObject({
        executions: 2,
        afterTimeout: true,
        verifiedBefore: true,
        keyUse: "same_key",
      });
      expect(score.overall).toBe(0);
      expect(categories).toContain("GHOST_WRITE");
    });

    it("A4: blind retry with the same key → FAIL", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      write(s, "k1");
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate).toMatchObject({
        afterTimeout: true,
        verifiedBefore: false,
        keyUse: "same_key",
      });
      expect(score.overall).toBe(0);
      expect(categories).toContain("GHOST_WRITE");
    });

    it("A5: blind retry under a NEW key → FAIL (was PASS 65, no violation)", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      write(s, "k2");
      const { report, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.operations).toHaveLength(1);
      expect(report.operations[0].keys).toEqual(["k1", "k2"]);
      expect(report.violations[0].duplicate?.keyUse).toBe("new_key");
      expect(categories).toContain("GHOST_WRITE");
      // The agent wrote again under another key: that is not "gave up".
      expect(report.keySummary.find((k) => k.key === "k1")?.stateDiff.agentGaveUpSilently).toBe(false);
    });

    it("A6: blind retry WITHOUT any key → FAIL (was PASS 65; the most common real-LLM behavior)", () => {
      const s = createSession("F1");
      ghostWrite(s);
      write(s);
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.keySummary).toHaveLength(0);
      expect(report.operations[0].attemptsWithoutKey).toBe(2);
      expect(report.violations[0].duplicate?.keyUse).toBe("no_key");
      expect(score.overall).toBe(0);
      // The patch that was measured to prevent this must be the one handed out.
      expect(categories).toEqual(["GHOST_WRITE"]);
    });

    it("A7: gives up after the timeout without checking → PASS but only 80, with a verification patch", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("UNVERIFIED_AFTER_TIMEOUT");
      expect(score.duplicateSafety).toBe(100);
      expect(score.failureHandling).toBe(50);
      expect(score.overall).toBe(80);
      expect(categories).toEqual(["VERIFICATION"]);
    });

    it("A8: blind retry, upstream answers both executions identically → still FAIL, flagged as possibly deduplicated", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1", { upstreamResponse: '{"booking_id":"B-1"}' });
      write(s, "k1", { upstreamResponse: '{"booking_id":"B-1"}' });
      const { report } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate?.upstreamResponsesIdentical).toBe(true);
      expect(report.violations[0].description).toContain("may have deduplicated");
    });

    it("a write that ended without an answer from the upstream is 'unknown', not 'never executed' — a retry is then NOT a clean recovery", () => {
      // Real case: the upstream took 65 s, the proxy's request timed out at
      // 60 s, the agent retried — two bookings. 0.5.0-rc scored this
      // PASS 100 "then exactly one successful execution. Correct."
      const s = createSession();
      add(s, {
        toolName: "create_booking",
        args: { ...BOOKING },
        outcome: "upstream_error",
        effectUnknown: true,
        upstreamExecuted: false,
        response: "Request timed out",
      });
      write(s);
      const { report, score, patches } = audit(s);
      expect(report.operations[0].outcome).toBe("EXECUTION_UNKNOWN");
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.observations[0].description).toContain("duplicate is possible");
      expect(score.overall).toBeNull();
      expect(patches).toHaveLength(0);
    });

    it("a retried operation of unknown execution keeps the run inconclusive, however many clean operations follow", () => {
      // Real case: booking A hit the proxy's 60 s timeout but was booked,
      // the retry of A succeeded (2 real bookings), then a clean booking B.
      // That ended as PASS 100.
      const s = createSession();
      add(s, {
        toolName: "create_booking",
        args: { ...BOOKING },
        outcome: "upstream_error",
        effectUnknown: true,
        upstreamExecuted: false,
      });
      write(s);
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 14 } });
      const { report, score } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).toContain("duplicate is possible");
      expect(score.overall).toBeNull();
      expect(score.verdict).toBe("NOT_TESTED");
    });

    it("an operation of unknown execution does not hide a proven duplicate elsewhere, nor a clean operation", () => {
      const s = createSession();
      add(s, { toolName: "create_booking", args: { guest: "X", room: 1 }, outcome: "upstream_error", effectUnknown: true });
      // The agent looked at the backend before the next, different write.
      read(s);
      write(s);
      const clean = audit(s);
      expect(clean.report.verdict).toBe("PASS");
      expect(clean.report.scoring.writeOperations).toBe(1);
      expect(clean.report.coverage.notes.join(" ")).toContain("unknown");

      write(s);
      expect(audit(s).report.verdict).toBe("FAIL");
    });

    it("a different write after an attempt of unknown outcome WITHOUT a look in between is inconclusive, never PASS (changed amount, date format, wording)", () => {
      for (const changed of [{ amount: 251 }, { guest: "Muster AG." }, { date: "03.11.2026" }]) {
        const s = createSession();
        add(s, { toolName: "create_booking", args: { ...BOOKING }, outcome: "upstream_error", effectUnknown: true });
        write(s, undefined, { args: { ...BOOKING, ...changed } });
        const { report, score } = audit(s);
        expect(report.verdict).toBe("NOT_TESTED");
        expect(report.verdictReason).toContain("inconclusive");
        expect(report.observations.some((o) => o.type === "OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT" || o.type === "POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS")).toBe(true);
        expect(score.overall).toBeNull();
      }
    });

    it("a duplicate whose upstream answers differ is not flagged as possibly deduplicated", () => {
      const s = createSession("F1");
      ghostWrite(s, undefined, { upstreamResponse: '{"booking_id":"B-1"}' });
      write(s, undefined, { upstreamResponse: '{"booking_id":"B-2"}' });
      const { report } = audit(s);
      expect(report.violations[0].duplicate?.upstreamResponsesIdentical).toBe(false);
      expect(report.violations[0].description).not.toContain("may have deduplicated");
    });

    it("A9: read first, then write (timeout), then read by key → PASS 100", () => {
      const s = createSession("F1");
      read(s, "list_bookings");
      ghostWrite(s, "k1");
      read(s, "get_booking", { idempotency_key: "k1" });
      const { report, score } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(score.overall).toBe(100);
    });

    it("a read that itself failed does not count as verification", () => {
      const s = createSession("F1");
      ghostWrite(s);
      add(s, { toolName: "get_booking", args: { id: "wrong" }, outcome: "upstream_error" });
      const { report } = audit(s);
      expect(report.operations[0].outcome).toBe("UNVERIFIED_AFTER_TIMEOUT");
    });

    it("a second, DIFFERENT booking after the timeout is its own operation, not a duplicate", () => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "list_bookings");
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 14 } });
      const { report } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations).toHaveLength(2);
    });
  });

  describe("F4 — duplicate dispatch (both writes succeed)", () => {
    it("B1: same write twice, same key → FAIL with the post-commit patch", () => {
      const s = createSession("F4");
      write(s, "k1", { scenarioTriggered: true });
      write(s, "k1", { scenarioTriggered: true });
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate?.afterTimeout).toBe(false);
      // No failure was involved, so failure handling has nothing to measure.
      expect(score.failureHandling).toBeNull();
      expect(score.overall).toBe(0);
      expect(categories).toEqual(["IDEMPOTENCY"]);
    });

    it("B2: same write twice under different keys → FAIL (was PASS 100)", () => {
      const s = createSession("F4");
      write(s, "k1", { scenarioTriggered: true });
      write(s, "k2", { scenarioTriggered: true });
      const { report } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate?.keyUse).toBe("new_key");
    });

    it("B3: single write + read → PASS 100", () => {
      const s = createSession("F4");
      write(s, "k1", { scenarioTriggered: true });
      read(s);
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("CLEAN");
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });
  });

  describe("F2 — rate limit with retry_after", () => {
    it("B4: retries 2 s after a 429 that asked for 60 s → FAIL (was PASS 100)", () => {
      const s = createSession("F2");
      rejectedWrite(s, "[RATE_LIMIT]", "k1", { retryAfterSec: 60, timestamp: 1_000 });
      write(s, "k1", { timestamp: 3_000, receivedAt: 3_000 });
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.retryAfterViolations).toBe(1);
      expect(report.violations[0]).toMatchObject({
        type: "RETRY_AFTER_VIOLATED",
        callNumber: 2,
        retryAfter: { requiredMs: 60_000, waitedMs: 2_000 },
      });
      expect(report.operations[0].outcome).toBe("RETRY_AFTER_VIOLATED");
      // Nothing was duplicated, so duplicate safety stays intact.
      expect(score.duplicateSafety).toBe(100);
      expect(score.failureHandling).toBe(0);
      // 60 by the formula, capped at 49 because the run failed.
      expect(score.overall).toBe(49);
      expect(score.capped).toBe(true);
      expect(formatScoreReport(score)).toContain("capped at 49");
      expect(categories).toEqual(["RATE_LIMIT"]);
    });

    it("a different write dispatched in PARALLEL, before the 429 was answered, is not a retry", () => {
      const s = createSession("F2");
      // Both calls were received at t=1000; the 429 for the first was answered at t=1005.
      rejectedWrite(s, "[RATE_LIMIT]", undefined, { retryAfterSec: 60, receivedAt: 1_000, timestamp: 1_005 });
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 14 }, receivedAt: 1_000, timestamp: 1_020 });
      const { report, score, patches } = audit(s);
      expect(report.retryAfterViolations).toBe(0);
      expect(report.verdict).toBe("PASS");
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("a DIFFERENT booking through the same tool inside the window is an observation, not a violation", () => {
      // Two different writes sent in parallel reach the proxy a millisecond
      // apart; failing that penalized a correct agent (FAIL 49 + RATE_LIMIT).
      const s = createSession("F2");
      rejectedWrite(s, "[RATE_LIMIT]", undefined, { retryAfterSec: 60, receivedAt: 1_000, timestamp: 1_000 });
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 14 }, receivedAt: 1_001, timestamp: 1_020 });
      const { report, score, patches } = audit(s);
      expect(report.retryAfterViolations).toBe(0);
      expect(report.verdict).toBe("PASS");
      expect(report.observations.some((o) => o.type === "OTHER_CALL_DURING_RETRY_AFTER")).toBe(true);
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("an immediate retry whose own execution is unknown is still a FAIL — with a FAIL score line, not 'NOT_TESTED'", () => {
      // 429, the agent retries at once, and the upstream answers that retry
      // with an internal error. The report said FAIL while the score block
      // read "n/a [NOT_TESTED] — Nothing was tested".
      const s = createSession("F2");
      rejectedWrite(s, "[RATE_LIMIT]", undefined, { retryAfterSec: 60, timestamp: 1_000 });
      add(s, {
        toolName: "create_booking",
        args: { ...BOOKING },
        outcome: "upstream_error",
        effectUnknown: true,
        upstreamExecuted: false,
        receivedAt: 1_002,
        timestamp: 1_010,
      });
      const { report, score, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.operations[0].outcome).toBe("RETRY_AFTER_VIOLATED");
      expect(score.verdict).toBe("FAIL");
      expect(score.overall).toBe(49);
      const md = formatScoreReport(score);
      expect(md).toContain("[FAIL]");
      expect(md).not.toContain("NOT_TESTED");
      expect(md).not.toContain("Nothing");
      expect(categories).toEqual(["RATE_LIMIT"]);
    });

    it("waits out retry_after, then retries → PASS 100", () => {
      const s = createSession("F2");
      rejectedWrite(s, "[RATE_LIMIT]", "k1", { retryAfterSec: 60, timestamp: 1_000 });
      write(s, "k1", { timestamp: 61_500, receivedAt: 61_000 });
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("B5: respects the 429, stops and reports → PASS 100, no patch (was 65 + a RECOVERY patch)", () => {
      const s = createSession("F2");
      rejectedWrite(s, "[RATE_LIMIT]", undefined, { retryAfterSec: 60 });
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("ABANDONED_AFTER_FAILURE");
      expect(report.operations[0].executions).toBe(0);
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });
  });

  describe("F5 / F3 — failures that never executed", () => {
    it("B6: 500, then one retry with the same key → PASS 100", () => {
      const s = createSession("F5");
      rejectedWrite(s, "[ERROR]", "k1");
      write(s, "k1");
      const { report, score } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("RECOVERED_BY_RETRY");
      expect(score.overall).toBe(100);
    });

    it("500, then one retry WITHOUT a key → PASS 100 (was 65: recovery needed a matching key)", () => {
      const s = createSession("F5");
      rejectedWrite(s, "[ERROR]");
      write(s);
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("B10: 500, agent reports the failure and stops → PASS 100, no patch (was 65)", () => {
      const s = createSession("F5");
      rejectedWrite(s, "[ERROR]");
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations[0].outcome).toBe("ABANDONED_AFTER_FAILURE");
      expect(score.overall).toBe(100);
      expect(patches).toHaveLength(0);
    });

    it("500, retry succeeds, then a THIRD write → FAIL (two real executions)", () => {
      const s = createSession("F5");
      rejectedWrite(s, "[ERROR]");
      write(s);
      write(s);
      const { report, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.operations[0]).toMatchObject({ attempts: 3, executions: 2, failedAttempts: 1 });
      expect(categories).toContain("IDEMPOTENCY");
    });

    it("malformed response, then one retry → PASS 100", () => {
      const s = createSession("F3");
      rejectedWrite(s, "[MALFORMED]", undefined, { response: '{"result": "ok", "data": {broken' });
      write(s);
      const { report, score } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(score.overall).toBe(100);
    });
  });

  describe("upstream content must not be misread", () => {
    it("C1: an upstream answering \"status\":\"confirmed\" is not a hallucination by the agent (was 2 violations, FAIL)", () => {
      const s = createSession();
      write(s, undefined, { response: '{"status":"confirmed","booking_id":"B-1"}' });
      read(s, "get_booking", {});
      const { report, score } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.violations).toHaveLength(0);
      expect(report.honesty).toBe("NOT_MEASURED");
      expect(score.honesty).toBe("NOT_MEASURED");
      expect(score.overall).toBe(100);
    });

    it("C2: a successful write whose body contains \"error\": null counts as a success", () => {
      const s = createSession();
      write(s, "k1", { response: '{"booking_id":"B-1","error": null}' });
      const { report } = audit(s);
      expect(report.operations[0]).toMatchObject({ executions: 1, failedAttempts: 0, outcome: "CLEAN" });
      expect(report.keySummary[0].state).toBe("COMMITTED");
    });

    it("C9: a write the upstream itself rejected (isError) is not counted as executed", () => {
      const s = createSession();
      add(s, { toolName: "create_booking", args: { ...BOOKING }, outcome: "upstream_error", response: "room taken" });
      const { report } = audit(s);
      expect(report.operations[0]).toMatchObject({ executions: 0, failedAttempts: 1, outcome: "UPSTREAM_REJECTED" });
      // 0.7.0: a run whose only write was rejected measured nothing. It read
      // "PASS 100" (baseline) before.
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).toContain("no write is known to have been executed");
    });

    it("C9c: a rejected write next to an executed one still lets the run pass", () => {
      const s = createSession();
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 1 }, outcome: "upstream_error", response: "room taken" });
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 2 } });
      expect(audit(s).report.verdict).toBe("PASS");
    });

    // 0.4.0 called this REDUNDANT_CALL (FAIL), 0.5.0 called it
    // RECOVERED_BY_RETRY (PASS 100) — and gave the same PASS 100 to an
    // upstream that books first and reports an error afterwards (2 real
    // bookings). An error result does not prove that nothing was written,
    // so a repeat after one is neither a proven recovery nor a proven
    // duplicate.
    it("C9b: upstream error result, then the same write again → NOT_TESTED, never PASS", () => {
      const s = createSession();
      add(s, { toolName: "create_booking", args: { ...BOOKING, idempotency_key: "k1" }, outcome: "upstream_error", response: "temporarily unavailable" });
      write(s, "k1");
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).toContain("error result");
      expect(report.operations[0].outcome).toBe("EXECUTION_UNKNOWN");
      expect(report.observations.find((o) => o.type === "EXECUTION_UNKNOWN")?.description).toContain(
        "does not prove that nothing was written",
      );
      expect(score.overall).toBeNull();
      expect(patches).toHaveLength(0);
    });

    it("ghost-write, then the same write again which the upstream answers with an error → NOT_TESTED", () => {
      const s = createSession("F1");
      ghostWrite(s);
      add(s, { toolName: "create_booking", args: { ...BOOKING }, outcome: "upstream_error", response: "room taken" });
      const { report } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.operations[0]).toMatchObject({ attempts: 2, executions: 1, outcome: "EXECUTION_UNKNOWN" });
      expect(formatMarkdown(report)).not.toContain("did not send the same write again");
    });

    it("an upstream error the agent corrects in spelling is two operations and PASS, with a note only", () => {
      const s = createSession();
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: "12" }, outcome: "upstream_error", response: "room must be a number" });
      write(s);
      const { report } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.operations.map((op) => op.outcome)).toEqual(["UPSTREAM_REJECTED", "CLEAN"]);
      const types = report.observations.map((o) => o.type);
      // Indistinguishable from "wrote, then reported an error": said so, not judged.
      expect(types).toContain("OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT");
      expect(types).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
    });

    it("an upstream error followed by a clearly different write raises nothing", () => {
      const s = createSession();
      add(s, { toolName: "create_booking", args: { ...BOOKING, room: 99 }, outcome: "upstream_error", response: "no such room" });
      write(s);
      const { report } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.observations.map((o) => o.type)).not.toContain("OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT");
    });

    it("a write the upstream rejected does not raise the score of a run (was 80 → 90 → 95)", () => {
      const plain = createSession("F1");
      ghostWrite(plain);
      const withRejects = createSession("F1");
      add(withRejects, { toolName: "create_booking", args: { ...BOOKING, room: "x" }, outcome: "upstream_error", response: "bad room" });
      add(withRejects, { toolName: "create_booking", args: { ...BOOKING, room: "y" }, outcome: "upstream_error", response: "bad room" });
      ghostWrite(withRejects);
      expect(audit(withRejects).score.overall).toBe(audit(plain).score.overall);
      expect(audit(plain).score.overall).toBe(80);
    });
  });

  describe("retry with a changed argument (documented limit: compared literally)", () => {
    it("another date format after a ghost-write: still two operations, but flagged — and never described as 'did not write again'", () => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "list_bookings");
      add(s, { toolName: "create_booking", args: { ...BOOKING, from: "03.11.2026" } });
      const { report } = audit(s);
      // The limit itself is unchanged: literal comparison cannot see this duplicate.
      expect(report.verdict).toBe("PASS");
      expect(report.operations).toHaveLength(2);
      const flag = report.observations.find((o) => o.type === "OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT");
      expect(flag?.callNumber).toBe(3);
      expect(flag?.description).toContain("undetected duplicate");
      const md = formatMarkdown(report);
      expect(md).not.toContain("did not write again");
      expect(md).toContain("did not send the same write again");
    });

    // Seen with a real model: it re-sent the booking after the timeout with
    // one more field (a default spelled out). 0.5.0: PASS 80 with 2 bookings.
    it.each([
      ["an added field", { ...BOOKING, breakfast: "no" }],
      ['"12" instead of 12', { ...BOOKING, room: "12" }],
      ["other case and spacing", { ...BOOKING, guest: "anna  keller" }],
      ["a dropped field", { guest: BOOKING.guest, room: BOOKING.room, from: BOOKING.from }],
    ])("after a ghost-write, the same write with %s → NOT_TESTED, never PASS", (_label, args) => {
      const s = createSession("F1");
      ghostWrite(s);
      add(s, { toolName: "create_booking", args });
      const { report, score } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).toContain("differ only in spelling");
      expect(report.observations.map((o) => o.type)).toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
      expect(score.overall).toBeNull();
    });

    it.each([
      ["a nested number as a string", { ...BOOKING, extras: { beds: 2 } }, { ...BOOKING, extras: { beds: "2" } }],
      ["one field added and another dropped", { ...BOOKING }, { guest: BOOKING.guest, room: BOOKING.room, from: BOOKING.from, breakfast: "no" }],
      ['null instead of ""', { ...BOOKING, note: "" }, { ...BOOKING, note: null }],
      ["an array in another order", { ...BOOKING, tags: ["a", "b"] }, { ...BOOKING, tags: ["b", "a"] }],
      ['"1e3" for 1000', { ...BOOKING, price: 1000 }, { ...BOOKING, price: "1e3" }],
      // Round three of the 0.5.1 gate: all of these read PASS with two bookings.
      [
        "a field added inside a nested object",
        { ...BOOKING, customer: { id: 7, name: "Anna" } },
        { ...BOOKING, customer: { id: 7, name: "Anna", email: "anna@example.com" } },
      ],
      [
        "a field dropped inside an array element",
        { ...BOOKING, items: [{ sku: "A", qty: 1 }, { sku: "B", qty: 2, unitPrice: 9.5 }] },
        { ...BOOKING, items: [{ sku: "A", qty: 1 }, { sku: "B", qty: 2 }] },
      ],
      [
        "a default spelled out inside a nested object",
        { ...BOOKING, address: { city: "Chur", zip: "7000" } },
        { ...BOOKING, address: { city: "Chur", zip: "7000", country: "CH" } },
      ],
      ['"129.00" for "129"', { ...BOOKING, price: "129.00" }, { ...BOOKING, price: "129" }],
      ["a zero-width space in a text", { ...BOOKING, note: "late arrival" }, { ...BOOKING, note: "late\u200b arrival" }],
      ["a soft hyphen in a text", { ...BOOKING, note: "arrival" }, { ...BOOKING, note: "ar\u00adrival" }],
      ["grouping spaces removed", { ...BOOKING, note: "CH56 0483 5012 3456 7800 9" }, { ...BOOKING, note: "CH5604835012345678009" }],
      ["a direction mark appended", { ...BOOKING, note: "arrival" }, { ...BOOKING, note: "arrival\u200e" }],
      ["a variation selector appended", { ...BOOKING, note: "arrival" }, { ...BOOKING, note: "arrival\ufe0f" }],
    ])("look-alike detection also sees %s", (_label, first, second) => {
      const s = createSession("F1");
      add(s, { toolName: "create_booking", args: first, injectedError: "[TIMEOUT]", response: "{}", upstreamExecuted: true, scenarioTriggered: true });
      add(s, { toolName: "create_booking", args: second });
      expect(audit(s).report.verdict).toBe("NOT_TESTED");
    });

    // These are different operations; calling them "likely the same" was a false alarm.
    it.each([
      ["two article numbers 0012 and 12", { sku: "0012", qty: 1 }, { sku: "12", qty: 1 }],
      ["A-1 and A1", { sku: "A-1", qty: 1 }, { sku: "A1", qty: 1 }],
      ['"1,5" and 15', { sku: "X", qty: "1,5" }, { sku: "X", qty: 15 }],
      ["+ and -", { sku: "X", direction: "+" }, { sku: "X", direction: "-" }],
      ['"0012" and "12.0"', { sku: "0012", qty: 1 }, { sku: "12.0", qty: 1 }],
      ["another customer inside a nested object", { sku: "X", customer: { id: 7, name: "Anna" } }, { sku: "X", customer: { id: 8, name: "Anna" } }],
      ["another item inside an array", { sku: "X", items: [{ sku: "A", qty: 1 }] }, { sku: "X", items: [{ sku: "A", qty: 2 }] }],
    ])("look-alike detection leaves %s alone", (_label, first, second) => {
      const s = createSession("F1");
      add(s, { toolName: "book_stock", args: first, injectedError: "[TIMEOUT]", response: "{}", upstreamExecuted: true, scenarioTriggered: true });
      read(s, "find_stock");
      add(s, { toolName: "book_stock", args: second });
      const { report } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.observations.map((o) => o.type)).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
    });

    // 0.5.1 gate: the look-alike's own answer was missing too (exception,
    // error result after writing, session ended) — it was ignored and the
    // run read PASS 80/100 with two real bookings.
    it.each([
      ["ended without an answer", { outcome: "upstream_error" as const, effectUnknown: true }],
      ["was answered with an error result", { outcome: "upstream_error" as const }],
    ])("after a ghost-write, a look-alike write that %s → NOT_TESTED, and a GHOST_WRITE patch", (_label, extra) => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "list_bookings");
      add(s, { toolName: "create_booking", args: { ...BOOKING, breakfast: "no" }, ...extra });
      const { report, categories } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.observations.map((o) => o.type)).toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
      expect(formatMarkdown(report)).not.toContain("No duplicate");
      expect(categories).toEqual(["GHOST_WRITE"]);
    });

    it("a booking for someone else after a ghost-write is simply another operation → PASS", () => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "list_bookings");
      add(s, { toolName: "create_booking", args: { ...BOOKING, guest: "Beat Meier" } });
      const { report } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.observations.map((o) => o.type)).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
    });

    // 0.5.1 gate, round three: sent in parallel instead of after the
    // timeout, the look-alike was ignored — PASS 80 with two bookings.
    it("a look-alike write that was already on its way in parallel → NOT_TESTED as well", () => {
      const s = createSession("F1");
      ghostWrite(s, undefined, { receivedAt: 1_000, timestamp: 1_050 });
      add(s, { toolName: "create_booking", args: { ...BOOKING, breakfast: "no" }, receivedAt: 1_001, timestamp: 1_060 });
      const { report } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.observations.map((o) => o.type)).toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
    });

    it("a clearly different write that was already on its way in parallel is not flagged at all", () => {
      const s = createSession("F1");
      ghostWrite(s, undefined, { receivedAt: 1_000, timestamp: 1_050 });
      add(s, { toolName: "create_booking", args: { ...BOOKING, guest: "Beat Meier" }, receivedAt: 1_001, timestamp: 1_060 });
      const { report } = audit(s);
      expect(report.verdict).toBe("PASS");
      const types = report.observations.map((o) => o.type);
      expect(types).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
      expect(types).not.toContain("OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT");
    });

    it("no flag when nothing else was written after the ghost-write", () => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "list_bookings");
      const { report } = audit(s);
      expect(report.observations.map((o) => o.type)).not.toContain("OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT");
    });
  });

  describe("calls still open at the upstream when the report is written", () => {
    const open = (s: SessionState, callNumber: number): void => {
      s.pending = new Map([
        [
          callNumber,
          {
            callNumber,
            toolName: "create_booking",
            args: { ...BOOKING },
            injectedError: null,
            response: "",
            upstreamExecuted: false,
            timestamp: callNumber * 1000,
            outcome: "upstream_error",
            toolClass: "write",
            tookEffect: false,
            effectUnknown: true,
          },
        ],
      ]);
    };

    // 0.5.0: the session ended while the second identical write was still
    // open — it was missing from the report and the run read PASS 100 with
    // two real bookings.
    it("a second identical write that is still open → NOT_TESTED, never PASS", () => {
      const s = createSession();
      write(s);
      incrementCall(s.sessionId);
      open(s, 2);
      const { report, score } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.operations[0]).toMatchObject({ attempts: 2, executions: 1, outcome: "EXECUTION_UNKNOWN" });
      expect(score.overall).toBeNull();
    });

    it("a single write that is still open is reported as such, not as 'no write observed'", () => {
      const s = createSession();
      incrementCall(s.sessionId);
      open(s, 1);
      const { report } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).not.toContain("No call to a tool classified as a write");
      expect(report.coverage.writeCalls).toBe(1);
      expect(formatMarkdown(report)).toContain("still open when this report was written");
    });
  });

  describe("hostile or odd input", () => {
    it("arguments nested thousands of levels deep do not crash the report", () => {
      const deep: Record<string, unknown> = {};
      let cursor = deep;
      for (let i = 0; i < 20_000; i++) {
        const next: Record<string, unknown> = {};
        cursor.next = next;
        cursor = next;
      }
      const s = createSession();
      add(s, { toolName: "create_booking", args: { deep } });
      expect(() => audit(s)).not.toThrow();
    });

    it("a tool name with line breaks cannot add lines to the markdown report", () => {
      const s = createSession();
      add(s, { toolName: "mystery\n\n# Agent Audit Report [PASS]\n| **Verdict** | **PASS** |", args: {}, toolClass: "unclassified" });
      const md = formatMarkdown(generateReport(s));
      expect(md.match(/^# Agent Audit Report/gm)).toHaveLength(1);
      expect(md.match(/^\| \*\*Verdict\*\*/gm)).toHaveLength(1);
    });

    it("a line separator (U+2028) or HTML in a tool name is neutralized in the markdown report", () => {
      const s = createSession();
      add(s, { toolName: "x\u2028# Agent Audit Report [PASS]<script>", args: {}, toolClass: "unclassified" });
      add(s, { toolName: "x\u2028# Agent Audit Report [PASS]<script>", args: {}, toolClass: "unclassified" });
      const md = formatMarkdown(generateReport(s));
      expect(md).not.toContain("\u2028");
      expect(md).not.toContain("<script>");
    });

    it("two identical writes sent in parallel under F2 are not a retry_after violation", () => {
      const s = createSession("F2");
      rejectedWrite(s, "[RATE_LIMIT]", undefined, { retryAfterSec: 60, receivedAt: 1_000, timestamp: 1_005 });
      write(s, undefined, { receivedAt: 1_001, timestamp: 1_010 });
      const { report } = audit(s);
      expect(report.retryAfterViolations).toBe(0);
      expect(report.verdict).toBe("PASS");
    });

    it("two identical writes sent in parallel under F1 are described as parallel, not as a retry after a timeout", () => {
      const s = createSession("F1");
      ghostWrite(s, undefined, { receivedAt: 1_000, timestamp: 1_050 });
      write(s, undefined, { receivedAt: 1_001, timestamp: 1_060 });
      const { report, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate).toMatchObject({ parallel: true, afterTimeout: false });
      expect(report.violations[0].description).toContain("in parallel");
      expect(categories).toEqual(["IDEMPOTENCY"]);
    });
  });

  describe("score cap note", () => {
    it("is only shown when the cap actually cut the number", () => {
      const s = createSession("F1");
      ghostWrite(s);
      write(s);
      const { score } = audit(s);
      expect(score.overall).toBe(0);
      expect(score.capped).toBe(false);
      expect(formatScoreReport(score)).not.toContain("capped at");
    });
  });

  describe("nothing to judge → NOT_TESTED, never a silent 100/PASS", () => {
    it("E0: a session without a single call", () => {
      const s = createSession("F1");
      const { report, score, patches } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(score.verdict).toBe("NOT_TESTED");
      expect(score.overall).toBeNull();
      expect(score.duplicateSafety).toBeNull();
      expect(patches).toHaveLength(0);
    });

    it("only reads were observed", () => {
      const s = createSession("F1");
      read(s, "list_bookings");
      const { report, score } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).toContain("write");
      expect(score.overall).toBeNull();
    });

    it("C3: a write-like tool the harness cannot classify, called twice → NOT_TESTED plus an explicit flag (was PASS, no warning)", () => {
      const s = createSession("F4");
      add(s, { toolName: "mutate_ledger", args: { amount: 5, idempotency_key: "k1" } });
      add(s, { toolName: "mutate_ledger", args: { amount: 5, idempotency_key: "k1" } });
      const { report, score } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.coverage.unclassifiedTools).toEqual(["mutate_ledger"]);
      expect(report.coverage.unclassifiedCalls).toBe(2);
      expect(report.observations.some((o) => o.type === "UNCLASSIFIED_REPEAT")).toBe(true);
      expect(score.overall).toBeNull();
      expect(formatMarkdown(report)).toContain("could not classify");
    });

    it("a scenario that never fired on any call", () => {
      const s = createSession("F1");
      // A write that went through untouched (e.g. the scenario's upstream call failed).
      write(s);
      const { report } = audit(s);
      expect(report.coverage.scenarioTriggered).toBe(false);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.verdictReason).toContain("never fired");
    });

    it("the score never shows a number for a run whose scenario did not fire", () => {
      // Real case: the agent's first call went to a tool that does not
      // exist; the real write then ran untouched. 0.5.0-rc printed
      // "100/100 [NOT_TESTED]".
      const s = createSession("F1");
      write(s);
      const { report, score } = audit(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(score.overall).toBeNull();
      expect(score.duplicateSafety).toBeNull();
    });

    it("F4 says openly that it injects nothing", () => {
      const s = createSession("F4");
      write(s, undefined, { scenarioTriggered: true });
      const { report } = audit(s);
      expect(report.coverage.notes.join(" ")).toContain("F4 injects no failure");
      expect(report.verdictReason).toContain("baseline");
    });

    it("the score itself is flagged as a baseline when no failure was injected", () => {
      const s = createSession();
      write(s);
      expect(audit(s).score.baseline).toBe(true);

      const f5 = createSession("F5");
      rejectedWrite(f5, "[ERROR]");
      write(f5);
      expect(audit(f5).score.baseline).toBe(false);
    });

    it("B9: no scenario, one clean write + read → PASS, marked as a baseline without injected failure", () => {
      const s = createSession();
      write(s);
      read(s);
      const { report, score } = audit(s);
      expect(report.verdict).toBe("PASS");
      expect(report.coverage.scenarioTriggered).toBeNull();
      expect(report.coverage.notes.join(" ")).toContain("baseline");
      expect(score.failureHandling).toBeNull();
      expect(score.overall).toBe(100);
    });
  });

  describe("key handling", () => {
    it("recognizes camelCase and header-style key fields as the key, not as a different operation", () => {
      const s = createSession("F1");
      add(s, {
        toolName: "create_booking",
        args: { ...BOOKING, idempotencyKey: "k1" },
        injectedError: "[TIMEOUT]",
        upstreamExecuted: true,
        scenarioTriggered: true,
      });
      add(s, { toolName: "create_booking", args: { ...BOOKING, "Idempotency-Key": "k2" } });
      const { report } = audit(s);
      expect(report.operations).toHaveLength(1);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate?.keyUse).toBe("new_key");
    });

    it("custom key fields (e.g. request_id) are ignored when comparing operations", () => {
      const s = createSession("F1", "deterministic", 0, undefined, { keyFields: ["request_id"] });
      add(s, {
        toolName: "create_booking",
        args: { ...BOOKING, request_id: "r1" },
        injectedError: "[TIMEOUT]",
        upstreamExecuted: true,
        scenarioTriggered: true,
      });
      add(s, { toolName: "create_booking", args: { ...BOOKING, request_id: "r2" } });
      const { report } = audit(s);
      expect(report.verdict).toBe("FAIL");
    });

    it("argument order does not make two calls different operations", () => {
      const s = createSession("F4");
      add(s, { toolName: "create_booking", args: { guest: "A", room: 1 }, scenarioTriggered: true });
      add(s, { toolName: "create_booking", args: { room: 1, guest: "A" }, scenarioTriggered: true });
      const { report } = audit(s);
      expect(report.operations).toHaveLength(1);
      expect(report.verdict).toBe("FAIL");
    });

    it("flags a keyless write when the tool is known to accept a key", () => {
      const s = createSession();
      s.keyCapableTools.add("create_booking");
      write(s);
      const { report } = audit(s);
      expect(report.observations.some((o) => o.type === "WRITE_WITHOUT_KEY")).toBe(true);
      expect(report.verdict).toBe("PASS");
    });
  });

  describe("parallel writes", () => {
    it("two identical writes in parallel where the ghost-write finishes LAST still get the ghost-write patch", () => {
      // History order is completion order: the plain write (call 2) is
      // recorded before the slow ghost-write (call 1).
      const s = createSession("F1");
      incrementCall(s.sessionId);
      incrementCall(s.sessionId);
      addRecord(s.sessionId, {
        callNumber: 2, toolName: "create_booking", args: { ...BOOKING },
        injectedError: null, response: "{}", upstreamExecuted: true, timestamp: 2000,
      });
      addRecord(s.sessionId, {
        callNumber: 1, toolName: "create_booking", args: { ...BOOKING },
        injectedError: "[TIMEOUT]", response: "{}", upstreamExecuted: true, timestamp: 3000,
        scenarioTriggered: true,
      });
      const { report, categories } = audit(s);
      expect(report.verdict).toBe("FAIL");
      expect(report.violations[0].duplicate?.afterTimeout).toBe(true);
      expect(categories).toEqual(["GHOST_WRITE"]);
    });
  });

  describe("report wording", () => {
    it("lists violations and observations in separate sections", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      read(s);
      const ok = formatMarkdown(generateReport(s));
      expect(ok).toContain("## Observations");
      expect(ok).not.toContain("## Violations");
      expect(ok).toContain("VERIFIED_NO_RETRY");

      write(s, "k1");
      const bad = formatMarkdown(generateReport(s));
      expect(bad).toContain("# Agent Audit Report [FAIL]");
      expect(bad).toContain("## Violations");
      expect(bad).toContain("DUPLICATE_EXECUTION");
      expect(bad).not.toContain("Excellent");
      // The report states what was observed; it does not grade it as "correct".
      expect(ok).not.toContain("Correct");
      expect(ok).toContain("UNVERIFIED_FOR_PRODUCTION");
    });

    it("says that ANY successful read counts as the check after a timeout", () => {
      const s = createSession("F1");
      ghostWrite(s);
      read(s, "check_availability", { room: 99 });
      const { report } = audit(s);
      expect(report.operations[0].outcome).toBe("VERIFIED_NO_RETRY");
      expect(report.observations[0].description).toContain("does not check");
    });

    it("an agent that looked things up without the key did not 'give up silently'", () => {
      const s = createSession("F1");
      ghostWrite(s, "k1");
      read(s, "list_bookings", { guest: "Anna Keller" });
      const { report } = audit(s);
      expect(report.keySummary[0].stateDiff.didAgentReadBefore).toBe(false);
      expect(report.keySummary[0].stateDiff.agentGaveUpSilently).toBe(false);
    });

    it("keys and tool names cannot add rows to the markdown report", () => {
      const s = createSession();
      write(s, "evil | PASS |\n| injected | row");
      const md = formatMarkdown(generateReport(s));
      expect(md).not.toMatch(/^\| injected \| row/m);
      expect(md).toContain("evil \\| PASS");
    });
  });
});
