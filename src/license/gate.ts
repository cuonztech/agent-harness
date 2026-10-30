// Lizenz-Sperre nach dem Muster von CPCG (Privacy Chaos Gate): Der Lauf selbst
// (Proxy, Szenarien F1 bis F5, Score, PASS/FAIL, Exit-Code) ist nie davon
// abhängig. Ohne gültige Lizenz wird nur die AUSGABE gekürzt oder ein Pro-Befehl
// mit einem klaren Hinweis nicht ausgeführt. Die Prüfung der Lizenz selbst
// (Ed25519, offline) liegt in verifier.ts.
import { resolveLicense } from "./verifier.js";
import type { LicenseVerdict } from "./types.js";
import type { SchemaAuditReport } from "../types.js";

export const PURCHASE_URL = "https://cuonztech.ch/agent-harness.html#audit";
// Alte Adresse aus früheren Texten des Verifizierers; die Website leitet weiter.
const LEGACY_URL = "https://cuonztech.ch/agent-audit";

export type ProFeature = "dossier" | "ui" | "campaign" | "schema-audit" | "hardening";

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
  "schema-audit": {
    name: "Das Schema-Gutachten (Befunde je Tool und Schema-Vorschläge)",
    command: "proxy --report-file, report",
    mode: "gekürzt",
    free: "Die Zusammenfassung und die Risikostufe je Tool (auch in doctor)",
  },
  hardening: {
    name: "Der Textbaustein- und Prompt-Patch-Generator (Härtungsvorschläge)",
    command: "proxy --report-file, report, cuonztech__get_score",
    mode: "gekürzt",
    free: "Der Score, das Urteil und die Beobachtungen",
  },
};

export const FREE_SCOPE_DE =
  "MCP-Chaos-Proxy mit den Szenarien F1 bis F5, doctor, Kompaktbericht, JSON-Report (--report-file), Resilience Score und PASS/FAIL samt Exit-Code";

export interface ProGate {
  pro: boolean;
  verdict: LicenseVerdict;
}

/** Löst die Lizenz auf (--license, sonst Umgebungsvariablen). Ohne gültige Lizenz ist `pro` false. */
export function resolveProGate(licenseKey?: string): ProGate {
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
    `Aktivierung: --license <KEY> oder Umgebungsvariable AGENT_AUDIT_LICENSE.\n`
  );
}

/**
 * Hinweis für eine gekürzte Ausgabe (Dossier, Schema-Gutachten, Härtungsvorschläge).
 * Der Lauf selbst, das Urteil und der Exit-Code sind davon unberührt.
 */
export function shortenedNotice(feature: ProFeature, verdict: LicenseVerdict): string {
  const f = PRO_FEATURES[feature];
  return (
    `Keine gültige Lizenz: ${f.name} gehört zum Pro-Umfang. ${reasonSentence(verdict)} ` +
    `Die Ausgabe ist gekürzt; der Lauf, das Urteil und der Exit-Code sind echt. ` +
    `Frei bleiben: ${FREE_SCOPE_DE}. Lizenz: ${PURCHASE_URL}`
  );
}

/** Schlankere Fassung des Schema-Gutachtens ohne Lizenz: Zusammenfassung und Risikostufe, keine Befunde, kein Schema-Vorschlag. */
export function reduceSchemaAudit(audit: SchemaAuditReport): SchemaAuditReport {
  return {
    ...audit,
    tools: audit.tools.map((t) => ({ ...t, findingsDe: [], recommendedSchemaPatch: null })),
  };
}
