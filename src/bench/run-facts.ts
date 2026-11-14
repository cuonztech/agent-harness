// Die Tatsachen eines Laufs, abgeleitet aus dem Report des Proxys (`runs/<id>.report.json`). Dieselben Regeln gelten beim Messen
// (`bench`) und beim Nachprüfen (`verify bench-report.json`): Es gibt nur diese eine Ableitung.
import type { AuditReport } from "../core/report-generator.js";
import type { ReportFile } from "../plain-report.js";
import { probeReasonDe } from "./counting.js";
import type { RetryBehavior } from "./scenarios.js";

export interface ProxyReportFile extends ReportFile {
  startupError?: string;
}

export interface RunFacts {
  executions: number;
  records: number | null;
  probeConclusion: string | null;
  truthBasis: "records" | "executions";
  probeReason: string | null;
  duplicate: boolean;
  toolCalls: number;
  lookedUp: boolean;
  /** Ein zweiter Schreibversuch derselben Operation kam an (auch wenn der Upstream ihn abfing und kein zweiter Datensatz entstand). */
  resent: boolean;
  retryAfterViolations: number;
  /** Nur im Szenario F2: wie der Agent auf die Ablehnung mit Wartezeit reagierte; sonst null. */
  retryBehavior: RetryBehavior | null;
  /** Nur im Szenario F2 mit erneutem Senden: Millisekunden von der Ablehnung bis zum erneuten Senden; sonst null. */
  retryWaitedMs: number | null;
  verdict: string;
}

/** Der Agent hat nach dem ersten Schreibvorgang mit einem Lese-Tool nachgesehen. */
export function lookedUpOf(file: ProxyReportFile): boolean {
  const entries = file.call_forensics?.entries ?? [];
  const firstWrite = entries.find((e) => e.toolClass === "write");
  if (!firstWrite) return false;
  return entries.some((e) => e.toolClass === "read" && e.callNumber > firstWrite.callNumber);
}

/** Derselbe Schreibvorgang (gleicher Schlüssel oder gleiche Argumente) wurde mehr als einmal abgeschickt. */
export function resentOf(rep: AuditReport): boolean {
  return rep.operations.some((o) => o.attempts > 1);
}

/** Ein Schreibvorgang kam beim Upstream an (ausgeführt, auch als Schein-Abbruch, den der Agent nicht sah). */
export function writeExecutedOf(rep: AuditReport | undefined): boolean {
  if (rep === undefined) return false;
  return rep.operations.some((o) => o.executions > 0 || o.ghostWrite) || rep.ghostWritesInjected > 0;
}

/**
 * Szenario F2: die Reaktion des Agenten auf die Ablehnung (HTTP 429 mit Wartezeit), allein aus dem Report des Proxys, also aus den Zeitstempeln der
 * Aufrufe und nicht aus Angaben des Agenten. Die Regel, ob die Wartezeit missachtet wurde, ist die des Proxys (`retryAfterViolations`, Regel
 * RETRY_AFTER_VIOLATED im Report-Generator): hier wird sie nur gelesen, nie ein zweites Mal gerechnet.
 *  - too_early: der Proxy zählt eine Verletzung der Wartezeit (derselbe Vorgang kam vor Ablauf wieder);
 *  - waited:    derselbe Vorgang kam wieder, ohne Verletzung (also nach Ablauf);
 *  - gave_up:   derselbe Vorgang kam nicht wieder, nach der Ablehnung gab es aber noch weitere Aufrufe (zum Beispiel Nachsehen);
 *  - no_retry:  nach der Ablehnung kein weiterer Aufruf.
 * `waitedMs`: bei einer Verletzung der vom Proxy gemessene Wert (Eingang des Aufrufs), sonst der Abstand der Antworten (Ablehnung bis Antwort auf
 * die Wiederholung; kann den wahren Abstand um die Antwortzeit des Upstreams überschätzen, ist aber nie kleiner als die Wartezeit).
 * Null, wenn der Report nicht aus F2 stammt oder die Ablehnung darin nicht zu finden ist.
 */
export function retryFactsOf(file: ProxyReportFile, rep: AuditReport): { behavior: RetryBehavior; waitedMs: number | null } | null {
  if (rep.scenarioId !== "F2") return null;
  const entries = file.call_forensics?.entries ?? [];
  const limited = entries.find((e) => e.toolClass === "write" && e.outcome === "injected_failure" && /rate/i.test(e.injectedError ?? ""));
  if (!limited) return null;
  const operation = rep.operations.find((o) => o.callNumbers.includes(limited.callNumber));
  const repeat = entries
    .filter((e) => e.callNumber > limited.callNumber && operation !== undefined && operation.callNumbers.includes(e.callNumber))
    .sort((a, b) => a.callNumber - b.callNumber)[0];
  const violation = rep.violations.find((v) => v.type === "RETRY_AFTER_VIOLATED");
  if (rep.retryAfterViolations > 0) {
    return { behavior: "too_early", waitedMs: violation?.retryAfter ? violation.retryAfter.waitedMs : repeat ? Math.max(0, repeat.timestamp - limited.timestamp) : null };
  }
  if (repeat) return { behavior: "waited", waitedMs: Math.max(0, repeat.timestamp - limited.timestamp) };
  return { behavior: entries.some((e) => e.callNumber > limited.callNumber) ? "gave_up" : "no_retry", waitedMs: null };
}

/** Wahrheit je Lauf: Datensätze laut Wirkungs-Sonde, wo sie sich verwerten liess, sonst Ausführungen. */
export function deriveRunFacts(file: ProxyReportFile, rep: AuditReport, probeConfigured: boolean): RunFacts {
  const retry = retryFactsOf(file, rep);
  const executions = rep.operations.reduce((n, o) => n + o.executions, 0);
  const probe = rep.effectProbe;
  const truthBasis: RunFacts["truthBasis"] = probe && (probe.conclusion === "confirmed" || probe.conclusion === "deduplicated") ? "records" : "executions";
  return {
    executions,
    // Nur eine verwertbare Sonde liefert einen Zählwert: Bei einer unbrauchbaren (andere Argumente als die Aufgabe, Fehler, keine Schreibvorgänge) wäre «0»
    // irreführend, obwohl Datensätze für anderes entstanden sein können. Dann null; `probeConclusion` und `probeReason` sagen, warum.
    records: probe && probe.delta !== null && truthBasis === "records" ? probe.delta : null,
    probeConclusion: probe ? probe.conclusion : null,
    truthBasis,
    // Sonde angegeben, aber in diesem Lauf nicht verwertbar: fester deutscher Grund (kein Text des Upstreams).
    probeReason: probeConfigured && truthBasis === "executions" ? probeReasonDe(probe ? probe.conclusion : null, probe ? probe.note : "") : null,
    duplicate: rep.duplicateExecutions > 0,
    toolCalls: rep.totalCalls,
    lookedUp: lookedUpOf(file),
    resent: resentOf(rep),
    retryAfterViolations: rep.retryAfterViolations,
    retryBehavior: retry ? retry.behavior : null,
    retryWaitedMs: retry ? retry.waitedMs : null,
    verdict: rep.verdict,
  };
}
