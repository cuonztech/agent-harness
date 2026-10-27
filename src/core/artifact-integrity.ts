// Integritäts-Nachweis für die Report-Datei: SHA-256 über den kanonisierten
// Inhalt (report, schema_audit, call_forensics, Harness-Version) und eine
// Hash-Kette über die einzelnen Tool-Aufrufe. Das ist ein Manipulationsnachweis,
// keine Signatur: Wer den Inhalt ändert und beide Hashes neu berechnet, ist damit
// nicht auszuschliessen. Der Nachweis zeigt nur, dass die Datei nach dem Schreiben
// nicht unbemerkt verändert wurde, solange der Hash an anderer Stelle festgehalten ist.
import { createHash } from "node:crypto";
import type { ReportFile } from "../plain-report.js";
import type { AuditReport } from "./report-generator.js";
import type { CallForensicReport, ReportIntegrityProof, SchemaAuditReport } from "../types.js";

export interface IntegrityPayload {
  harnessVersion: string;
  report: AuditReport;
  schema_audit?: SchemaAuditReport;
  call_forensics?: CallForensicReport;
}

const MAX_DEPTH = 256;

// Deterministische JSON-Fassung: Schlüssel sortiert, undefined-Felder weggelassen
// (wie JSON.stringify), damit ein Durchlauf durch eine Datei denselben Text ergibt.
export function canonicalJson(value: unknown, depth = 0): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (depth >= MAX_DEPTH) throw new Error("Wert zu tief verschachtelt für die Kanonisierung");
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`)
    .join(",")}}`;
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Jeder Schritt: hash(vorheriger Hash + kanonisches JSON des Eintrags). Start: leerer String.
function chainHead(entries: readonly unknown[]): string | null {
  if (entries.length === 0) return null;
  let prev = "";
  for (const entry of entries) prev = sha256Hex(prev + canonicalJson(entry));
  return prev;
}

export function computeReportIntegrity(payload: IntegrityPayload): ReportIntegrityProof {
  const entries = payload.call_forensics?.entries ?? [];
  return {
    algorithm: "sha256",
    payloadSha256: sha256Hex(
      canonicalJson({
        harnessVersion: payload.harnessVersion,
        report: payload.report,
        schema_audit: payload.schema_audit,
        call_forensics: payload.call_forensics,
      }),
    ),
    callChainHeadSha256: chainHead(entries),
    callChainLength: entries.length,
  };
}

export function verifyReportIntegrity(file: ReportFile): { valid: boolean; reasonDe: string } {
  const proof = file.integrity;
  if (proof === undefined || proof === null || typeof proof !== "object") {
    return { valid: false, reasonDe: "Die Datei enthält keinen Integritäts-Nachweis; ihre Unversehrtheit lässt sich nicht prüfen." };
  }
  if (typeof file.harnessVersion !== "string" || file.report === undefined || file.report === null) {
    return { valid: false, reasonDe: "Die Datei enthält keinen vollständigen Bericht (Harness-Version oder report fehlt); der Nachweis kann nicht nachgerechnet werden." };
  }
  if (proof.algorithm !== "sha256") {
    return { valid: false, reasonDe: "Der Integritäts-Nachweis verwendet ein unbekanntes Verfahren." };
  }
  let expected: ReportIntegrityProof;
  try {
    expected = computeReportIntegrity({
      harnessVersion: file.harnessVersion,
      report: file.report,
      schema_audit: file.schema_audit,
      call_forensics: file.call_forensics,
    });
  } catch {
    return { valid: false, reasonDe: "Der Inhalt der Datei lässt sich nicht kanonisieren (zu tief verschachtelt); der Nachweis kann nicht geprüft werden." };
  }
  if (proof.callChainLength !== expected.callChainLength || proof.callChainHeadSha256 !== expected.callChainHeadSha256) {
    return {
      valid: false,
      reasonDe: "Die Hash-Kette der Tool-Aufrufe stimmt nicht überein: Einträge in call_forensics wurden nach dem Schreiben verändert, entfernt oder ergänzt.",
    };
  }
  if (proof.payloadSha256 !== expected.payloadSha256) {
    return {
      valid: false,
      reasonDe: "Die Prüfsumme stimmt nicht überein: report, schema_audit, call_forensics oder die Harness-Version wurden nach dem Schreiben verändert.",
    };
  }
  return {
    valid: true,
    reasonDe: `Die Prüfsumme und die Hash-Kette über ${expected.callChainLength} ${expected.callChainLength === 1 ? "Aufruf" : "Aufrufe"} stimmen überein; der Inhalt ist seit dem Schreiben unverändert.`,
  };
}
