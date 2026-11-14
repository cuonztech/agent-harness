// Lizenz-Sperre nach dem Muster von CPCG (Privacy Chaos Gate): Der Lauf selbst
// (Proxy, Szenarien F1 bis F5, Score, PASS/FAIL, Exit-Code) ist nie davon
// abhängig. Ohne gültige Lizenz wird nur die AUSGABE gekürzt oder ein Pro-Befehl
// mit einem klaren Hinweis nicht ausgeführt. Die Prüfung der Lizenz selbst
// (Ed25519, offline) liegt in verifier.ts.
import { resolveLicense } from "./verifier.js";
import type { LicenseVerdict } from "./types.js";
import type { SchemaAuditReport } from "../types.js";

export const PURCHASE_URL = "https://cuonztech.ch/agent-harness.html#audit";
// Alte Adresse aus früheren Texten des Verifizierers (ältere Berichte) und die aktuelle Adresse im Grund des Verifizierers: Der Hinweis
// nennt die Adresse am Ende selbst (PURCHASE_URL), darum wird sie aus dem Grund entfernt.
const LEGACY_URL = "https://cuonztech.ch/agent-audit";
const REASON_URL = "https://cuonztech.ch/agent-harness.html";

export type ProFeature = "dossier" | "ui" | "campaign" | "bench" | "schema-audit" | "hardening";

// Zuordnung frei/Pro. Dieselbe Tabelle steht in der README (Abschnitt «Lizenz und Umfang»).
export const PRO_FEATURES: Record<ProFeature, { name: string; command: string; mode: "gesperrt" | "gekürzt"; free: string }> = {
  dossier: {
    name: "Das Prüf-Dossier (report --dossier)",
    command: "report --dossier",
    mode: "gekürzt",
    free: "Das Dossier enthält nur Kopf, Score und das Urteil je Szenario",
  },
  ui: {
    name: "Die geführte Web-Oberfläche (ui)",
    command: "ui",
    mode: "gesperrt",
    free: "Der Weg über die Kommandozeile (proxy, doctor, report)",
  },
  campaign: {
    name: "Der Kampagnen-Runner (campaign)",
    command: "campaign",
    mode: "gesperrt",
    free: "Der Selbsttest (benchmark) und jeder einzelne Proxy-Lauf",
  },
  bench: {
    name: "Die Mehrlauf-Messung am eigenen Agenten (bench)",
    command: "bench",
    mode: "gesperrt",
    free: "Der Selbsttest (benchmark), jeder einzelne Proxy-Lauf und die Prüfung eines Bench-Berichts (verify)",
  },
  "schema-audit": {
    name: "Das Schema-Gutachten (Befunde je Tool und Schema-Vorschläge)",
    command: "proxy --report-file, report",
    mode: "gekürzt",
    free: "Die Zusammenfassung und die Risikostufe je Tool (auch in doctor)",
  },
  hardening: {
    name: "Der Textbaustein- und Prompt-Patch-Generator (die auf den Lauf zugeschnittenen Härtungsvorschläge)",
    command: "proxy --report-file, report, cuonztech__get_score",
    mode: "gekürzt",
    free: "Der Score, das Urteil und die Beobachtungen; der allgemeine Wortlaut der Textbausteine steht in der README und in der Ausgabe von benchmark",
  },
};

export const FREE_SCOPE_DE =
  "MCP-Chaos-Proxy mit den Szenarien F1 bis F5, doctor, Kompaktbericht, JSON-Report (--report-file), Resilience Score und PASS/FAIL samt Exit-Code";

export interface ProGate {
  pro: boolean;
  verdict: LicenseVerdict;
}

// 0.12.0 (E3e): Ein Lizenzcode in `--license` steht in der Prozessliste (ps, Task-Manager, Win32_Process.CommandLine) und im Verlauf der
// Shell. Ein Satz auf stderr, einmal je Prozess; nie der Code selbst. Die Umgebungsvariable AGENT_AUDIT_LICENSE steht in keiner Prozessliste.
export const LICENSE_ON_COMMAND_LINE_HINT_DE =
  "Hinweis: Ein Lizenzcode in --license steht in der Prozessliste und im Verlauf der Shell; setze ihn besser als Umgebungsvariable AGENT_AUDIT_LICENSE.";
let licenseHintShown = false;

export function warnLicenseOnCommandLine(explicitKey?: string): void {
  if (licenseHintShown || typeof explicitKey !== "string" || explicitKey.trim() === "") return;
  licenseHintShown = true;
  try {
    process.stderr.write(`${LICENSE_ON_COMMAND_LINE_HINT_DE}\n`);
  } catch {
    // stderr geschlossen: kein Grund, den Lauf abzubrechen
  }
}

/** Löst die Lizenz auf (--license, sonst Umgebungsvariablen). Ohne gültige Lizenz ist `pro` false. */
export function resolveProGate(licenseKey?: string): ProGate {
  warnLicenseOnCommandLine(licenseKey);
  const verdict = resolveLicense(licenseKey);
  return { pro: verdict.valid === true, verdict };
}

/** Der Grund in einem Satz, ohne Kauf-Link (der steht immer am Ende des Hinweises). */
export function reasonSentence(verdict: LicenseVerdict): string {
  if (verdict.valid) return "Die Lizenz ist gültig.";
  const raw = (verdict.reason ?? "").trim();
  const none = raw === "" || raw === "Nicht lizenziert" || raw.startsWith("Kein Lizenzschlüssel");
  if (none) return "Es ist keine Lizenz hinterlegt.";
  const core = raw
    .replace(LEGACY_URL, "")
    .replace(REASON_URL, "")
    .replace(/\s*(Lizenzen erhältlich unter|Verlängerung unter)\s*$/i, "")
    .trim()
    .replace(/\.$/, "");
  return `Ihre Lizenz ist nicht gültig: ${core}.`;
}

/**
 * Hinweis für einen Befehl, der ohne Lizenz nicht läuft (`ui`, `campaign`).
 * Form: «Keine gültige Lizenz: <Funktion> gehört zum Pro-Umfang. Frei bleiben …. Lizenz: <URL>»
 */
export function lockedNotice(feature: ProFeature, verdict: LicenseVerdict): string {
  const f = PRO_FEATURES[feature];
  return (
    `Keine gültige Lizenz: ${f.name} gehört zum Pro-Umfang. ${reasonSentence(verdict)}\n` +
    `Frei bleiben: ${FREE_SCOPE_DE}.\n` +
    `Der Befehl wurde nicht ausgeführt. Lizenz: ${PURCHASE_URL}\n` +
    `Aktivierung: Umgebungsvariable AGENT_AUDIT_LICENSE (auch CUONZTECH_LICENSE_KEY; empfohlen, sie steht in keiner Prozessliste) oder --license <KEY>. ${LICENSE_TERMS_DE}\n`
  );
}

/**
 * Hinweis für eine gekürzte Ausgabe (Dossier, Schema-Gutachten, Härtungsvorschläge).
 * Der Lauf selbst, das Urteil und der Exit-Code sind davon unberührt.
 */
export function shortenedNotice(feature: ProFeature, verdict: LicenseVerdict): string {
  const f = PRO_FEATURES[feature];
  return (
    `WARNUNG: Die Ausgabe ist gekürzt. Keine gültige Lizenz: ${f.name} gehört zum Pro-Umfang. ${reasonSentence(verdict)} ` +
    `Der Lauf, das Urteil und der Score sind echt. Der Befehl endet trotzdem mit Exit-Code 0, denn die gekürzte Fassung ist frei: Eine Pipeline erkennt die fehlende oder abgelaufene Lizenz daran nicht. ` +
    `Frei bleiben: ${FREE_SCOPE_DE}. Lizenz: ${PURCHASE_URL}`
  );
}

/** Was der Code vertraglich und technisch ist (README, «Lizenz und Umfang»). */
export const LICENSE_TERMS_DE =
  "Der Code gilt pro System laut AGB Teil D; technisch ist er nicht an ein System gebunden und nicht widerrufbar. Die Laufzeit wird mit der lokalen Uhr geprüft.";

/** Steht im JSON-Report ohne Lizenz, wo `findingsDe` leer ist: Das ist «nicht berechnet», nicht «keine Befunde». */
export const FINDINGS_NOTE_DE = "Befunde sind Teil von Pro";

/** Schlankere Fassung des Schema-Gutachtens ohne Lizenz: Zusammenfassung und Risikostufe, keine Befunde, kein Schema-Vorschlag. */
export function reduceSchemaAudit(audit: SchemaAuditReport): SchemaAuditReport {
  return {
    ...audit,
    // `findingsDe: []` allein liesse sich als «keine Befunde» lesen: Das Feld sagt, dass sie nicht berechnet wurden.
    findingsAvailable: false,
    findingsNoteDe: FINDINGS_NOTE_DE,
    tools: audit.tools.map((t) => ({ ...t, findingsDe: [], recommendedSchemaPatch: null, findingsAvailable: false, findingsNoteDe: FINDINGS_NOTE_DE })),
  };
}
