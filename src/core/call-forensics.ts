// Call-by-Call-Forensik: eine Zeitleiste aller Tool-Aufrufe einer Session mit
// exaktem Parameter-Diff, wenn ein Schreib-Tool mehrfach aufgerufen wurde. Sie
// beschreibt nur, was der Harness gesehen hat (Aufrufe und Antworten), nicht, was
// der Agent dem Nutzer gesagt hat.
import {
  classifyTool,
  extractKey,
  isKeyField,
  type CallRecord,
  type SessionState,
} from "../engine/state-machine.js";
import type { ArgumentDiffEntry, CallForensicEntry, CallForensicReport } from "../types.js";

const MAX_STRING_PREVIEW = 300;
// Tiefer verschachtelte Werte werden nicht weiter gekürzt: ein 5000-fach
// verschachteltes Argument hat an anderer Stelle schon den Stack gesprengt.
const MAX_PREVIEW_DEPTH = 64;

function truncated(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}…` : value;
  }
  if (value === null || typeof value !== "object" || depth >= MAX_PREVIEW_DEPTH) return value;
  if (Array.isArray(value)) return value.map((v) => truncated(v, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) copy[k] = truncated(v, depth + 1);
  return copy;
}

function previewArgs(args: Record<string, unknown>): Record<string, unknown> {
  return truncated(args) as Record<string, unknown>;
}

// Wörtlicher Vergleich (Schlüsselreihenfolge egal): "12" und 12 sind verschieden,
// denn genau so ein Wechsel soll im Diff sichtbar werden.
function canonical(value: unknown, depth = 0): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object" || depth >= MAX_PREVIEW_DEPTH) {
    try {
      return JSON.stringify(value) ?? "null";
    } catch {
      return '"<nicht vergleichbar>"';
    }
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v, depth + 1)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k], depth + 1)}`)
    .join(",")}}`;
}

function diffArguments(before: Record<string, unknown>, after: Record<string, unknown>): ArgumentDiffEntry[] {
  const diff: ArgumentDiffEntry[] = [];
  for (const field of Object.keys(before)) {
    if (!(field in after)) {
      diff.push({ field, kind: "removed", before: truncated(before[field]), after: undefined });
    } else if (canonical(before[field]) === canonical(after[field])) {
      diff.push({ field, kind: "unchanged", before: truncated(before[field]), after: truncated(after[field]) });
    } else {
      diff.push({ field, kind: "changed", before: truncated(before[field]), after: truncated(after[field]) });
    }
  }
  for (const field of Object.keys(after)) {
    if (!(field in before)) diff.push({ field, kind: "added", before: undefined, after: truncated(after[field]) });
  }
  return diff;
}

function describeRejection(record: CallRecord): string {
  const error = record.injectedError ?? "";
  if (record.retryAfterSec !== undefined || /429|rate/i.test(error)) {
    return "Abgelehnt mit HTTP 429 (Zu viele Anfragen)";
  }
  if (/500|internal|server/i.test(error)) return "Abgelehnt mit HTTP 500 (Serverfehler)";
  if (/malformed|garbled|json/i.test(error)) return "Mit einer defekten Antwort beantwortet";
  if (/timeout/i.test(error)) return "Mit einem Timeout beantwortet";
  return "Mit einem eingespielten Fehler beantwortet";
}

function summarize(
  record: CallRecord,
  toolClass: CallForensicEntry["toolClass"],
  previous: CallRecord | undefined,
): string {
  const effect = record.tookEffect === true;
  const unknown = record.effectUnknown === true;
  const prefix = previous ? `Wiederholung von Aufruf #${previous.callNumber}: ` : "";
  const lead = (text: string): string => `${prefix}${text}`;

  if (unknown) {
    return lead(
      "Ohne Antwort des Zielsystems geblieben (Timeout, Abbruch oder noch offen); ob der Aufruf ausgeführt wurde, ist unbekannt.",
    );
  }
  if (record.outcome === "injected_failure") {
    if (toolClass === "write" && effect) {
      const seen = /timeout/i.test(record.injectedError ?? "") ? "ein Timeout" : "ein Fehler";
      return lead(
        `Schreibbefehl im Zielsystem ausgeführt, dem Agenten wurde jedoch ${seen} gemeldet (Schein-Abbruch).`,
      );
    }
    return lead(`${describeRejection(record)}, nichts im Zielsystem ausgeführt.`);
  }
  if (record.outcome === "upstream_error") {
    return lead(
      record.upstreamExecuted
        ? "Das Zielsystem hat den Aufruf mit einem Fehlerergebnis beantwortet; ob dabei schon etwas geschrieben wurde, ist nicht sichtbar."
        : "Das Zielsystem war nicht erreichbar; nichts wurde ausgeführt.",
    );
  }
  if (toolClass === "read") return lead("Leseaufruf erfolgreich ausgeführt.");
  if (toolClass === "unclassified") return lead("Aufruf eines nicht eingeordneten Tools erfolgreich ausgeführt.");
  if (!effect) return lead("Erfolgreich beantwortet; im Zielsystem wurde nichts neu geschrieben (Wiederholung aus dem Zwischenspeicher).");
  if (!previous) return "Schreibbefehl erfolgreich im Zielsystem ausgeführt.";
  if (previous.tookEffect === true) {
    return `${prefix}erneut im Zielsystem ausgeführt (Doppelausführung).`;
  }
  if (previous.effectUnknown === true) {
    return `${prefix}im Zielsystem ausgeführt; ob der vorherige Versuch ebenfalls ausgeführt wurde, ist unbekannt (mögliche Doppelausführung).`;
  }
  return `${prefix}im Zielsystem ausgeführt; der vorherige Versuch hatte nichts bewirkt.`;
}

export function buildCallForensics(session: SessionState): CallForensicReport {
  // Noch offene Aufrufe zählen wie im Bericht als Versuche mit unbekannter Wirkung.
  const records =
    session.pending && session.pending.size > 0
      ? [...session.history, ...session.pending.values()]
      : [...session.history];
  records.sort((a, b) => a.callNumber - b.callNumber);

  const entries: CallForensicEntry[] = [];
  const lastWriteByTool = new Map<string, CallRecord>();
  const firstTimestamp = records.length > 0 ? records[0]!.timestamp : 0;
  let writeRetriesCount = 0;
  let mutationsOnRetryCount = 0;
  let keyChangesOnRetryCount = 0;

  for (const record of records) {
    const toolClass = record.toolClass ?? classifyTool(session, record.toolName);
    const previous = toolClass === "write" ? lastWriteByTool.get(record.toolName) : undefined;
    const argumentDiff = previous ? diffArguments(previous.args, record.args) : null;

    if (previous && argumentDiff) {
      writeRetriesCount++;
      const changed = argumentDiff.filter((d) => d.kind !== "unchanged");
      if (changed.some((d) => !isKeyField(d.field, session.keyFields))) mutationsOnRetryCount++;
      if (changed.some((d) => isKeyField(d.field, session.keyFields))) keyChangesOnRetryCount++;
    }

    entries.push({
      callNumber: record.callNumber,
      timestamp: record.timestamp,
      offsetMs: record.timestamp - firstTimestamp,
      toolName: record.toolName,
      toolClass,
      idempotencyKey: extractKey(record.args, session.keyFields) ?? null,
      argsPreview: previewArgs(record.args),
      injectedError: record.injectedError ?? null,
      upstreamExecuted: Boolean(record.upstreamExecuted),
      tookEffect: record.tookEffect === true,
      effectUnknown: record.effectUnknown === true,
      outcome: record.outcome,
      previousWriteCallNumber: previous ? previous.callNumber : null,
      argumentDiff,
      summaryDe: summarize(record, toolClass, previous),
    });

    if (toolClass === "write") lastWriteByTool.set(record.toolName, record);
  }

  return {
    totalCalls: entries.length,
    writeRetriesCount,
    mutationsOnRetryCount,
    keyChangesOnRetryCount,
    entries,
  };
}
