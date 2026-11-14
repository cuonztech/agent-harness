// Effect probe (--effect-probe): from EXECUTIONS to RECORDS.
//
// Without a probe the harness counts how often a write reached the upstream.
// Whether the upstream stored one record or two it cannot see: against an
// upstream that recognises a repeated request itself (same idempotency key, or
// the same booking), the right answer to a timeout — retry with the same key —
// reads FAIL. With a probe the harness calls a READ tool of the upstream
// itself, before the first agent call and again when a report is needed, and
// compares the number of records.
//
// The probe decides nothing about the verdict directly. It settles, per call,
// whether an attempt created a record (`tookEffect`), and the rest of the audit
// (operations, violations, score, dossier) runs on that.
//
// The assumptions it rests on, stated in every report that used it:
//   * every write of the counted tool(s) that took effect creates ONE record in
//     what the probe counts, and nothing else changes that count while the run
//     lasts;
//   * an answer that looks like a success (and a timeout behind which the
//     harness saw the write run) means a record exists.
// From the counts alone only what FOLLOWS FOR CERTAIN is concluded: with several
// operations a count cannot say which operation created which record, so mixed
// results stay "partial" and the audit runs on the executions it saw. When the
// numbers contradict the assumptions the probe is ignored and says why.
import type { CallRecord } from "../engine/state-machine.js";

export interface EffectProbeConfig {
  tool: string;
  args: Record<string, unknown>;
  // Dotted path to the array (length), number or object (key count) to count.
  // Without it the probe looks for the only array in the answer or a numeric
  // count/total.
  countPath?: string;
  // Glob patterns of the write tools whose records the probe counts
  // (--effect-tools). Without it the probe is only used when exactly ONE write
  // tool reached the upstream: with several, a count cannot be attributed.
  tools?: string[];
}

export interface EffectProbeState extends EffectProbeConfig {
  before: number | null;
  after: number | null;
  // The probe could not be read the last time (after the baseline).
  error: string | null;
  // History length the last "after" reading belongs to.
  readAtCalls: number;
  // When the last reading was attempted (ms since epoch), for the back-off after an error.
  lastAttemptAt?: number;
  // The answer looks paginated: a capped list under-counts.
  warning?: string;
}

export type EffectProbeConclusion =
  // Records = attempts that may have executed: every one of them created a record.
  | "confirmed"
  // The minimum the attempts allow: repeated or failed writes created no new record.
  | "deduplicated"
  // In between: some repeats created a record, some did not. Not attributable.
  | "partial"
  // The numbers contradict the assumptions, or calls were still open, or the probe failed.
  | "inconclusive"
  // No write attempt reached the upstream: nothing to compare.
  | "no_writes";

export interface EffectProbeSummary {
  tool: string;
  before: number | null;
  after: number | null;
  delta: number | null;
  // Write attempts that may have created a record (executed, executed behind
  // a timeout, or ended without an answer / with an error result).
  attempts: number;
  // Distinct operations among them (same tool, same arguments apart from the key).
  operations: number;
  conclusion: EffectProbeConclusion;
  note: string;
}

// ---------------------------------------------------------------- counting

function walk(value: unknown, path: string): unknown {
  let cur = value;
  for (const part of path.split(".").filter((p) => p !== "")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function countOf(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (value !== null && typeof value === "object") return Object.keys(value as object).length;
  return null;
}

const PAGING_KEYS = [
  "total", "total_count", "totalCount", "count", "next", "nextCursor", "next_cursor", "nextPage",
  "next_page", "has_more", "hasMore", "more", "limit", "page_size", "pageSize", "offset", "cursor",
];

function pagingHint(container: unknown, countedKey: string | null): string | undefined {
  if (container === null || typeof container !== "object" || Array.isArray(container)) return undefined;
  const keys = Object.keys(container as object).filter((k) => k !== countedKey && PAGING_KEYS.includes(k));
  if (keys.length === 0) return undefined;
  return `the probe's answer carries ${keys.join(", ")} next to the counted list: if it is paginated or capped, a full list under-counts. Count a total instead (--effect-count <path to the total>)`;
}

export interface ProbeReading {
  count: number;
  warning?: string;
}

// Why a reading failed, as a code (the message stays the English text of the report). `bench` maps it to a German hint.
export type ProbeReadErrorKind = "error_result" | "not_json" | "count_path" | "bad_number" | "not_countable";

export class ProbeReadError extends Error {
  constructor(
    readonly kind: ProbeReadErrorKind,
    message: string,
    // The text of the tool's error answer (error_result only), shortened.
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ProbeReadError";
  }
}

// --effect-probe-args: a JSON object. cmd.exe and Windows PowerShell 5.1 strip the
// double quotes of '{"status":"open"}' and hand over {status:open}; that form is
// read as well (flat key:value pairs, numbers/true/false/null as such).
export function parseProbeArgs(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    // fall through to the loose form
  }
  const m = /^\s*\{(.*)\}\s*$/s.exec(raw);
  if (!m || /["'\[\]{}]/.test(m[1])) return null;
  const out: Record<string, unknown> = {};
  for (const pair of m[1].split(",")) {
    if (pair.trim() === "") continue;
    const colon = pair.indexOf(":");
    if (colon <= 0) return null;
    const key = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim();
    if (key === "" || value === "") return null;
    out[key] = value === "true" ? true : value === "false" ? false : value === "null" ? null : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function errorText(result: { content?: Array<Record<string, unknown>> }): string {
  const first = result.content?.find((c) => c.type === "text");
  const text = typeof first?.text === "string" ? first.text.replace(/\s+/g, " ").trim() : "";
  return text === "" ? "" : `: "${text.length > 200 ? text.slice(0, 200) + "…" : text}"`;
}

// What the upstream's answer says about "how many records". Throws with a
// message that says what to do.
export function parseProbeReading(
  result: { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean },
  countPath?: string,
): ProbeReading {
  if (result.isError) {
    throw new ProbeReadError("error_result", `the probe tool answered with an error result${errorText(result)} (does it need arguments? see --effect-probe-args)`, errorText(result).replace(/^: "/, "").replace(/"$/, ""));
  }
  let data: unknown = result.structuredContent;
  if (data === undefined) {
    const first = result.content?.find((c) => c.type === "text");
    const text = typeof first?.text === "string" ? first.text : "";
    try {
      data = JSON.parse(text);
    } catch {
      throw new ProbeReadError("not_json", "the probe tool's answer is not JSON (use a tool that returns JSON)");
    }
  }
  if (countPath !== undefined) {
    const picked = countPath === "" ? data : walk(data, countPath);
    const n = countOf(picked);
    if (n === null) throw new ProbeReadError("count_path", `--effect-count "${countPath}" does not lead to an array, a number or an object in the answer`);
    const parts = countPath.split(".").filter((p) => p !== "");
    const last = parts.length > 0 ? parts[parts.length - 1] : null;
    const parent = parts.length > 1 ? walk(data, parts.slice(0, -1).join(".")) : data;
    const warning = Array.isArray(picked) ? pagingHint(parent, last) : undefined;
    return { count: n, ...(warning ? { warning } : {}) };
  }
  if (Array.isArray(data)) return { count: data.length };
  if (typeof data === "number") {
    const n = countOf(data);
    if (n === null) throw new ProbeReadError("bad_number", "the probe's answer is a number that is not a count (negative or not finite)");
    return { count: n };
  }
  if (data !== null && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const arrays = Object.entries(obj).filter(([, v]) => Array.isArray(v));
    if (arrays.length === 1) {
      const warning = pagingHint(obj, arrays[0][0]);
      return { count: (arrays[0][1] as unknown[]).length, ...(warning ? { warning } : {}) };
    }
    for (const key of ["count", "total", "total_count", "totalCount", "n"]) {
      const n = typeof obj[key] === "number" ? countOf(obj[key]) : null;
      if (n !== null) return { count: n };
    }
  }
  throw new ProbeReadError("not_countable", "cannot tell what to count in the probe's answer: pass --effect-count <path>");
}

export function parseProbeCount(
  result: { content?: Array<Record<string, unknown>>; structuredContent?: unknown; isError?: boolean },
  countPath?: string,
): number {
  return parseProbeReading(result, countPath).count;
}

// ---------------------------------------------------------------- resolving

type Fingerprint = (record: CallRecord) => string;

export interface ResolvedHistory {
  history: CallRecord[];
  summary: EffectProbeSummary;
}

export interface EffectProbeContext {
  // Calls still open at the upstream.
  openCalls: number;
  // Calls recorded so far; the reading must belong to exactly this many.
  recordedCalls: number;
  fingerprint: Fingerprint;
  mayHaveExecuted: (record: CallRecord) => boolean;
  // Does a glob pattern list match this tool name (--effect-tools).
  matchesTool: (name: string, patterns: string[]) => boolean;
}

// An attempt the harness saw come back as a success, or run behind an injected
// timeout: it counts as certain to have created a record (see the assumptions).
const looksExecuted = (r: CallRecord): boolean => r.outcome === "success" || r.tookEffect === true;

// Returns the history with the probe's findings applied (copies; the session's
// own records are never changed) plus a summary for the report. Without a usable
// reading the history is returned as it is.
export function applyEffectProbe(
  history: CallRecord[],
  probe: EffectProbeState,
  ctx: EffectProbeContext,
): ResolvedHistory {
  const { fingerprint } = ctx;
  const writes = history.filter((r) => r.toolClass === "write" && ctx.mayHaveExecuted(r));
  const tools = [...new Set(writes.map((r) => r.toolName))];
  const counted = probe.tools
    ? writes.filter((r) => ctx.matchesTool(r.toolName, probe.tools ?? []))
    : writes;
  const operations = new Set(counted.map(fingerprint)).size;
  const delta = probe.before !== null && probe.after !== null ? probe.after - probe.before : null;
  const base = {
    tool: probe.tool,
    before: probe.before,
    after: probe.after,
    delta,
    attempts: counted.length,
    operations,
  };
  const none = (conclusion: EffectProbeConclusion, note: string): ResolvedHistory => ({
    history,
    summary: { ...base, conclusion, note },
  });

  if (probe.error !== null) return none("inconclusive", `the probe could not be read: ${probe.error}`);
  if (delta === null) return none("inconclusive", "no reading of the probe is available");
  if (ctx.openCalls > 0) {
    return none("inconclusive", `${ctx.openCalls} call(s) were still open at the upstream when the probe was read`);
  }
  if (probe.readAtCalls !== ctx.recordedCalls) {
    return none(
      "inconclusive",
      `the last reading of the probe is older than the latest call (${probe.readAtCalls} of ${ctx.recordedCalls} calls); a new reading is on its way`,
    );
  }
  if (!probe.tools && tools.length > 1) {
    return none(
      "inconclusive",
      `${tools.length} different write tools reached the upstream (${tools.join(", ")}): a count cannot say which of them created which record. Name the tool(s) the probe counts with --effect-tools`,
    );
  }
  // An answer that reads like an error but came back as a success: "a success answer means a
  // record exists" is not safe for it. With one operation the count still settles it (that
  // operation is the only one a record can belong to); with several it cannot be attributed.
  const doubtful = counted.filter((r) => r.answerLooksLikeError === true);
  if (doubtful.length > 0 && operations >= 2) {
    return none(
      "inconclusive",
      `${doubtful.length} write answer(s) came back as a success but read like an error (for example "Fehler: …" without isError), and ${operations} operations are in the run: a count cannot say whether those created a record. Report such errors with isError so the harness can tell`,
    );
  }
  if (counted.length === 0) return none("no_writes", "no write of a counted tool reached the upstream, nothing to compare");

  // Per operation: at least one record if one of its attempts looks executed,
  // none otherwise; at most as many as it had attempts that may have run.
  const byOperation = new Map<string, CallRecord[]>();
  for (const r of counted) {
    const fp = fingerprint(r);
    const list = byOperation.get(fp);
    if (list) list.push(r);
    else byOperation.set(fp, [r]);
  }
  let lo = 0;
  for (const list of byOperation.values()) lo += list.some(looksExecuted) ? 1 : 0;
  const hi = counted.length;

  if (delta < lo || delta > hi) {
    return none(
      "inconclusive",
      `the probe counted ${delta} new record(s), but the ${counted.length} write(s) in ${operations} distinct operation(s) that reached the upstream imply between ${lo} and ${hi}: that contradicts the assumptions (the tool you probe does not count what these writes create, writes that create no record are in the run, or someone else wrote meanwhile). Not used.`,
    );
  }

  const copies = new Map<number, CallRecord>();
  const mutate = (r: CallRecord): CallRecord => {
    let c = copies.get(r.callNumber);
    if (!c) {
      c = { ...r };
      copies.set(r.callNumber, c);
    }
    return c;
  };
  const resolved = (): CallRecord[] => history.map((r) => copies.get(r.callNumber) ?? r);

  if (delta === hi) {
    // Every attempt created its record, including the ones whose outcome was open.
    for (const r of counted) {
      if (r.effectUnknown || r.tookEffect !== true) {
        const c = mutate(r);
        c.tookEffect = true;
        c.effectUnknown = false;
        c.effectResolved = true;
      }
    }
    return {
      history: resolved(),
      summary: {
        ...base,
        conclusion: "confirmed",
        note: `the probe counted ${delta} new record(s) for ${counted.length} write(s): every one created a record`,
      },
    };
  }

  if (delta === lo) {
    // The minimum: every operation with an attempt that looks executed has exactly
    // one record, every other operation none. Nothing was created twice.
    for (const list of byOperation.values()) {
      const holder = list.find(looksExecuted);
      for (const r of list) {
        if (r === holder) {
          if (r.effectUnknown || r.tookEffect !== true) {
            const c = mutate(r);
            c.tookEffect = true;
            c.effectUnknown = false;
            c.effectResolved = true;
          }
        } else if (r.tookEffect === true || r.effectUnknown || r.outcome === "upstream_error") {
          const c = mutate(r);
          // Seen as executed by the harness, but no new record: the upstream
          // recognised the repeat. (An attempt that only ended in an error is
          // simply resolved as "did not write".)
          if (r.tookEffect === true && holder !== undefined) c.effectProbeDeduplicated = true;
          c.tookEffect = false;
          c.effectUnknown = false;
          c.effectResolved = true;
        }
      }
    }
    return {
      history: resolved(),
      summary: {
        ...base,
        conclusion: "deduplicated",
        note: `the probe counted ${delta} new record(s) for ${counted.length} write(s) in ${operations} operation(s): repeated or failed writes created no new record`,
      },
    };
  }

  return none(
    "partial",
    `the probe counted ${delta} new record(s) for ${counted.length} write(s) in ${operations} operation(s) (at least ${lo}, at most ${hi}): some repeats created a record and some did not, and a count cannot say which operation created which. The audit runs on the executions it saw`,
  );
}
