// Prüfsumme für die Report-Datei und das Dossier. Das ist ein Manipulationsnachweis,
// keine Signatur: Wer den Inhalt ändert UND die Prüfsumme neu berechnet, ist damit nicht
// auszuschliessen (der Algorithmus ist offen, siehe README, Abschnitt «Prüfsumme und verify»).
// Der Nachweis zeigt nur, dass die Datei nach dem Schreiben nicht unbemerkt verändert wurde,
// solange der Hash an anderer Stelle (getrennt von der Datei) festgehalten ist.
//
// Format 2 (ab 0.11.1): gehasht wird die GANZE Datei ausser `integrity` und `claim_check`
// (Urteil, Score, Szenario, Operationen, Zeitleiste, Einordnung, Lizenzstatus, Harness-Version,
// Zeitstempel ...). `claim_check` ist ausgenommen, weil der Befehl `report --agent-response` und die
// Oberfläche ihn nachträglich eintragen; er gehört nicht zur Messung. Format 1 (bis 0.11.0) deckte
// nur report, schema_audit, call_forensics und die Version ab und liess Urteil und Score frei.
import { createHash } from "node:crypto";
import type { ReportFile } from "../plain-report.js";
import type { CallForensicReport, ReportIntegrityProof } from "../types.js";

export const INTEGRITY_FORMAT = 2;
// Felder oberster Ebene, die nicht in die Prüfsumme eingehen.
const EXCLUDED_FIELDS: ReadonlySet<string> = new Set(["integrity", "claim_check"]);
export const INTEGRITY_SCOPE_DE = "die ganze Datei ausser integrity und claim_check";

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

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// Jeder Schritt: hash(vorheriger Hash + kanonisches JSON des Eintrags). Start: leerer String.
function chainHead(entries: readonly unknown[]): string | null {
  if (entries.length === 0) return null;
  let prev = "";
  for (const entry of entries) prev = sha256Hex(prev + canonicalJson(entry));
  return prev;
}

// Die Felder oberster Ebene, die in die Prüfsumme eingehen, so wie sie in der Datei stehen würden
// (einmal durch JSON, damit der Schreiber und der Leser dieselbe Form hashen).
function coveredFields(content: Record<string, unknown>): Record<string, unknown> {
  const roundTripped = JSON.parse(JSON.stringify(content)) as Record<string, unknown>;
  const covered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(roundTripped)) {
    if (!EXCLUDED_FIELDS.has(key)) covered[key] = value;
  }
  return covered;
}

// `content` = die Datei ohne `integrity` (ein vorhandenes `integrity`/`claim_check` wird ignoriert).
export function computeReportIntegrity(content: object): ReportIntegrityProof {
  const covered = coveredFields(content as Record<string, unknown>);
  const forensics = covered.call_forensics as CallForensicReport | undefined;
  const entries = Array.isArray(forensics?.entries) ? forensics.entries : [];
  const fieldSha256: Record<string, string> = {};
  for (const key of Object.keys(covered).sort()) fieldSha256[key] = sha256Hex(canonicalJson(covered[key]));
  return {
    algorithm: "sha256",
    formatVersion: INTEGRITY_FORMAT,
    scope: "file-without-integrity-and-claim_check",
    payloadSha256: sha256Hex(canonicalJson(covered)),
    fieldSha256,
    callChainHeadSha256: chainHead(entries),
    callChainLength: entries.length,
  };
}

// Setzt `integrity` als letztes Feld ein.
export function sealReportFile<T extends object>(content: T): T & { integrity: ReportIntegrityProof } {
  return { ...content, integrity: computeReportIntegrity(content) };
}

export type IntegrityStatus = "ok" | "mismatch" | "legacy" | "missing" | "unreadable";

export interface IntegrityCheck {
  status: IntegrityStatus;
  valid: boolean;
  reasonDe: string;
  // Felder oberster Ebene, die sich gegenüber dem Schreiben geändert haben (nur bei mismatch, soweit erkennbar).
  changedFields: string[];
}

export const LEGACY_REASON_DE =
  "Prüfsumme aus Harness < 0.11.1, nicht prüfbar: Sie hat Format 1 und deckt nur Bericht, Schema-Gutachten und Aufruf-Protokoll ab, nicht Urteil und Score. Den Lauf mit 0.11.1 oder neuer wiederholen.";

function changedFieldsOf(file: ReportFile, proof: ReportIntegrityProof): string[] {
  const covered = coveredFields(file as unknown as Record<string, unknown>);
  const recorded = proof.fieldSha256 && typeof proof.fieldSha256 === "object" ? proof.fieldSha256 : {};
  const changed = new Set<string>();
  for (const key of Object.keys(covered)) {
    if (recorded[key] === undefined) changed.add(key);
    else if (recorded[key] !== sha256Hex(canonicalJson(covered[key]))) changed.add(key);
  }
  for (const key of Object.keys(recorded)) if (!(key in covered)) changed.add(key);
  return [...changed].sort();
}

export function checkReportIntegrity(file: ReportFile): IntegrityCheck {
  const proof = file.integrity;
  if (proof === undefined || proof === null || typeof proof !== "object") {
    return { status: "missing", valid: false, changedFields: [], reasonDe: "Die Datei enthält keinen Integritäts-Nachweis; ihre Unversehrtheit lässt sich nicht prüfen." };
  }
  if (proof.algorithm !== "sha256") {
    return { status: "unreadable", valid: false, changedFields: [], reasonDe: "Der Integritäts-Nachweis verwendet ein unbekanntes Verfahren." };
  }
  if (proof.formatVersion === undefined) {
    return { status: "legacy", valid: false, changedFields: [], reasonDe: LEGACY_REASON_DE };
  }
  if (proof.formatVersion !== INTEGRITY_FORMAT) {
    return {
      status: "unreadable",
      valid: false,
      changedFields: [],
      reasonDe: `Der Integritäts-Nachweis hat das Format ${String(proof.formatVersion)}; diese Version kennt nur Format ${INTEGRITY_FORMAT}. Mit einer neueren Harness-Version prüfen.`,
    };
  }
  if (typeof file.harnessVersion !== "string" || file.report === undefined || file.report === null) {
    return { status: "unreadable", valid: false, changedFields: [], reasonDe: "Die Datei enthält keinen vollständigen Bericht (Harness-Version oder report fehlt); der Nachweis kann nicht nachgerechnet werden." };
  }
  let expected: ReportIntegrityProof;
  try {
    expected = computeReportIntegrity(file);
  } catch {
    return { status: "unreadable", valid: false, changedFields: [], reasonDe: "Der Inhalt der Datei lässt sich nicht kanonisieren (zu tief verschachtelt); der Nachweis kann nicht geprüft werden." };
  }
  if (proof.callChainLength !== expected.callChainLength || proof.callChainHeadSha256 !== expected.callChainHeadSha256) {
    return {
      status: "mismatch",
      valid: false,
      changedFields: changedFieldsOf(file, proof),
      reasonDe: "Die Hash-Kette der Tool-Aufrufe stimmt nicht überein: Einträge in call_forensics wurden nach dem Schreiben verändert, entfernt oder ergänzt.",
    };
  }
  if (proof.payloadSha256 !== expected.payloadSha256) {
    const changed = changedFieldsOf(file, proof);
    return {
      status: "mismatch",
      valid: false,
      changedFields: changed,
      reasonDe:
        "Die Prüfsumme stimmt nicht überein: Die Datei wurde nach dem Schreiben verändert" +
        (changed.length > 0 ? ` (geänderte Felder: ${changed.join(", ")}).` : " (welches Feld, lässt sich nicht mehr erkennen: auch die Feld-Prüfsummen wurden verändert)."),
    };
  }
  return {
    status: "ok",
    valid: true,
    changedFields: [],
    reasonDe: `Die Datei stimmt mit ihrer eigenen Prüfsumme und der Hash-Kette über ${expected.callChainLength} ${expected.callChainLength === 1 ? "Aufruf" : "Aufrufe"} überein. Das ist eine Selbstprüfung ohne Signatur eines Dritten: Wer Datei und Prüfsumme zusammen ändert, kann fälschen.`,
  };
}

export function verifyReportIntegrity(file: ReportFile): { valid: boolean; reasonDe: string } {
  const { valid, reasonDe } = checkReportIntegrity(file);
  return { valid, reasonDe };
}

// ---------- Siegel des Dossiers ----------
//
// Das Dossier trägt seine Kernaussagen (Urteil, Score, Szenario, Operationen, Kunden- und
// Systemname, Lizenzstatus, Harness-Version, Zählweise und die Prüfsumme der Report-Datei) als
// JSON-Kommentar und dessen SHA-256. `verify <dossier>` rechnet beides nach und prüft, dass der
// sichtbare Kopf des Dossiers dem Kern entspricht. Der Fliesstext darunter ist nicht gesiegelt.

export const DOSSIER_SEAL_MARKER = "cuonztech-agent-harness-dossier-seal:";

export interface DossierCore {
  format: "cuonztech-agent-harness-dossier";
  formatVersion: 1;
  renderedWith: string;
  harnessVersion: string | null;
  generatedAt: string | null;
  sessionId: string | null;
  scenario: string | null;
  system: string;
  customer: string;
  licenseStatus: string;
  limited: boolean;
  verdict: string;
  verdictLabel: string;
  tone: string;
  scoreText: string;
  countingBasis: "executions" | "records";
  operations: Array<{ tool: string; attempts: number; executions: number; outcome: string }>;
  reportFile: {
    check: IntegrityStatus;
    payloadSha256: string | null;
    callChainHeadSha256: string | null;
    callChainLength: number | null;
  };
}

export interface DossierSeal {
  core: DossierCore;
  sha256: string;
}

export function sealDossierCore(core: DossierCore): DossierSeal {
  return { core, sha256: sha256Hex(canonicalJson(core)) };
}

// Als Kommentarinhalt tauglich: kein "--" und keine spitzen Klammern, JSON bleibt gültig.
export function sealToComment(seal: DossierSeal): string {
  const json = JSON.stringify(seal).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/--/g, "-\\u002d");
  return `<!-- ${DOSSIER_SEAL_MARKER} ${json} -->`;
}

export function extractDossierSeal(text: string): { seal: DossierSeal } | { error: "missing" | "unreadable" } {
  const start = text.lastIndexOf(`<!-- ${DOSSIER_SEAL_MARKER} `);
  if (start === -1) return { error: "missing" };
  const from = start + `<!-- ${DOSSIER_SEAL_MARKER} `.length;
  const end = text.indexOf(" -->", from);
  if (end === -1) return { error: "unreadable" };
  try {
    const parsed = JSON.parse(text.slice(from, end)) as Partial<DossierSeal>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sha256 !== "string" || !parsed.core || typeof parsed.core !== "object") {
      return { error: "unreadable" };
    }
    return { seal: parsed as DossierSeal };
  } catch {
    return { error: "unreadable" };
  }
}
