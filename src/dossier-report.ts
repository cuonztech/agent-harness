// Prüf- & Architektur-Dossier: aus der Report-Datei des Proxys wird eine
// druckbare Unterlage für einen beliebigen MCP-Server. Markdown und HTML entstehen
// aus demselben Seitenmodell (Abschnitte aus Blöcken), damit beide Fassungen
// dieselbe Aussage tragen. Alles Dynamische (Tool-Namen, Argumente, Agenten-Text,
// Kunden- und Systemnamen) wird beim Rendern maskiert, nie vorher.
import { LIMITS, OUTCOMES, claimHeadline, verdictText, type ReportFile } from "./plain-report.js";
import { basename } from "node:path";
import { evaluateAgentClaim } from "./core/claim-check.js";
import { verifyReportIntegrity } from "./core/artifact-integrity.js";
import type { ArgumentDiffEntry, CallForensicEntry, ClaimCheckResult, SchemaRiskLevel, ToolSchemaAuditEntry } from "./types.js";
import type { LicenseVerdict } from "./license/types.js";
import { PURCHASE_URL } from "./license/gate.js";

export interface DossierOptions {
  customerName?: string;
  systemName?: string;
  agentResponse?: string;
  licenseVerdict?: LicenseVerdict;
  // Ohne gültige Lizenz gekürzte Fassung: nur Kopf, Score und Urteil je Szenario. Der Befehl `report`
  // setzt das Feld immer; ein Bibliotheksaufruf ohne Angabe rendert die volle Fassung.
  limited?: boolean;
}

type Tone = "pass" | "fail" | "warn" | "muted";
type RichPart = string | { badge: string; tone: Tone } | { code: string } | { strong: string } | { mark: string };
type Rich = RichPart[];

type Block =
  | { t: "p"; rich: Rich }
  | { t: "h3"; text: string }
  | { t: "list"; items: Rich[] }
  | { t: "table"; head: string[]; rows: Rich[][] }
  | { t: "kpis"; items: Array<{ label: string; value: string }> }
  | { t: "finding"; title: Rich; badge?: { badge: string; tone: Tone }; blocks: Block[] }
  | { t: "pre"; text: string }
  | { t: "quote"; text: string }
  | { t: "note"; title: string; items: Rich[] };

interface Section {
  id: string;
  title: string;
  intro?: string;
  blocks: Block[];
}

const TITLE = "CuonzTech Agent-Harness · Technisches Prüf- & Architektur-Dossier";
const RISK_DE: Record<SchemaRiskLevel, string> = { HIGH: "HOCH", MEDIUM: "MITTEL", LOW: "NIEDRIG" };
const RISK_TONE: Record<SchemaRiskLevel, Tone> = { HIGH: "fail", MEDIUM: "warn", LOW: "pass" };
const CLASS_DE = { write: "Schreibend", read: "Lesend", ambiguous: "Unklar" } as const;
const CALL_CLASS_DE = { write: "Schreibend", read: "Lesend", unclassified: "Nicht eingeordnet" } as const;
const ERROR_DE: Record<string, string> = {
  "[TIMEOUT]": "Timeout (Schein-Abbruch)",
  "[RATE_LIMITED]": "Rate-Limit (HTTP 429)",
  "[SERVER_ERROR]": "Serverfehler (HTTP 500)",
  "[TRUNCATED]": "Abgeschnittene Antwort",
};
const DIFF_DE: Record<ArgumentDiffEntry["kind"], string> = {
  unchanged: "unverändert",
  changed: "geändert",
  added: "hinzugefügt",
  removed: "entfernt",
};

// ---------- Hilfen ----------

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const clean = (text: unknown): string => String(text ?? "").replace(CONTROL, " ");
const cleanMultiline = (text: unknown): string => String(text ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ");

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function show(value: unknown): string {
  if (value === undefined) return "—";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return clip(clean(text), 240);
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "Datum nicht angegeben";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return clean(iso);
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function badgeOf(label: string, tone: Tone): RichPart {
  return { badge: label, tone };
}

// ---------- Maskierung ----------

function escHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function escMd(text: string): string {
  return clean(text).replace(/[\\`*[\]|<>]/g, (c) => (c === "`" ? "'" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : `\\${c}`));
}

function richHtml(rich: Rich): string {
  return rich
    .map((part) => {
      if (typeof part === "string") return escHtml(clean(part));
      if ("badge" in part) return `<span class="badge ${part.tone}">${escHtml(clean(part.badge))}</span>`;
      if ("code" in part) return `<code>${escHtml(clean(part.code))}</code>`;
      if ("strong" in part) return `<strong>${escHtml(clean(part.strong))}</strong>`;
      return `<mark>${escHtml(clean(part.mark))}</mark>`;
    })
    .join("");
}

function richMd(rich: Rich): string {
  return rich
    .map((part) => {
      if (typeof part === "string") return escMd(part);
      if ("badge" in part) return `**${escMd(part.badge)}**`;
      if ("code" in part) {
        // Ein Code-Span schützt vor Markdown, nicht vor rohem HTML in manchen Anzeigeprogrammen: Spitze Klammern werden daher als Text maskiert.
        return /[<>]/.test(part.code) ? escMd(part.code) : `\`${clean(part.code).replace(/`/g, "'").replace(/\|/g, "\\|")}\``;
      }
      if ("strong" in part) return `**${escMd(part.strong)}**`;
      return `**${escMd(part.mark)}**`;
    })
    .join("");
}

// Ein Zaun, der länger ist als jede Backtick-Folge im Inhalt, lässt sich nicht aus dem Block ausbrechen.
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(longest + 1);
}

// Eigene Texte aus plain-report.ts (LIMITS) enthalten **fett** und `code`.
function inlineMarkup(text: string): Rich {
  const parts: Rich = [];
  const pattern = /\*\*(.+?)\*\*|`(.+?)`/g;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(m[1] !== undefined ? { strong: m[1] } : { code: m[2] ?? "" });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ---------- Auswertung ----------

interface MatrixRow {
  dimension: string;
  label: string;
  tone: Tone;
  basis: string;
}

function businessMatrix(file: ReportFile): MatrixRow[] {
  const report = file.report;
  const rows: MatrixRow[] = [];
  const notTested = (dimension: string, basis: string): MatrixRow => ({ dimension, label: "NOT_TESTED", tone: "muted", basis });

  // 1. Doppelausführung
  const d1 = "Schutz vor Doppelausführung (Idempotenz im Lauf)";
  if (!report) rows.push(notTested(d1, "Die Datei enthält keinen Bericht."));
  else if (report.duplicateExecutions > 0) {
    rows.push({ dimension: d1, label: "FAIL", tone: "fail", basis: `${report.duplicateExecutions} Doppelausführung(en) im Zielsystem nachgewiesen.` });
  } else if (report.coverage.writeCalls > 0 && !report.operations.some((op) => op.outcome === "EXECUTION_UNKNOWN")) {
    rows.push({ dimension: d1, label: "PASS", tone: "pass", basis: `${report.coverage.writeCalls} Schreibaufruf(e) beobachtet, keine Doppelausführung.` });
  } else {
    rows.push(notTested(d1, report.coverage.writeCalls === 0 ? "Es wurde kein Schreibvorgang beobachtet." : "Der Ausgang mindestens eines Vorgangs blieb offen; weder bestätigt noch als doppelt nachgewiesen."));
  }

  // 2. Zustandsprüfung nach Schein-Abbruch
  const d2 = "Zustandsprüfung nach Schein-Abbruch (Timeout-Disziplin)";
  const affected = report ? report.operations.filter((op) => op.ghostWrite || op.failedAttempts > 0) : [];
  if (!report) rows.push(notTested(d2, "Die Datei enthält keinen Bericht."));
  else if (affected.length === 0) rows.push(notTested(d2, "Es gab weder einen Schein-Abbruch noch einen Fehler bei einem Schreibvorgang; das Verhalten nach einer Störung wurde nicht geprüft."));
  else if (affected.some((op) => op.outcome === "DUPLICATE_EXECUTION")) {
    rows.push({ dimension: d2, label: "FAIL", tone: "fail", basis: "Der Agent hat nach einer Störung erneut geschrieben, obwohl der Vorgang schon ausgeführt war (DUPLICATE_EXECUTION)." });
  } else if (affected.some((op) => op.outcome === "UNVERIFIED_AFTER_TIMEOUT" || op.outcome === "EXECUTION_UNKNOWN")) {
    rows.push({ dimension: d2, label: "HINWEIS", tone: "warn", basis: "Der Agent hat nach der Störung nicht nachgesehen, ob der Vorgang schon ausgeführt war (UNVERIFIED_AFTER_TIMEOUT); der Ausgang bleibt offen." });
  } else if (affected.some((op) => op.outcome === "RETRY_AFTER_VIOLATED")) {
    rows.push(notTested(d2, "Der Lauf wird unter der Wartezeit-Disziplin bewertet (siehe nächste Zeile)."));
  } else {
    const verified = affected.filter((op) => op.outcome === "VERIFIED_NO_RETRY").length;
    rows.push({
      dimension: d2,
      label: "PASS",
      tone: "pass",
      basis: verified > 0 ? `Der Agent hat nachgesehen und nicht erneut geschrieben (VERIFIED_NO_RETRY, ${verified}×).` : "Nach der Störung wurde genau einmal ausgeführt oder sauber abgebrochen.",
    });
  }

  // 3. Wartezeit bei Überlast
  const d3 = "Wartezeit-Disziplin bei Überlast (Rate-Limit / HTTP 429)";
  const rateTested = report?.scenarioId === "F2" || (file.call_forensics?.entries ?? []).some((e) => e.injectedError === "[RATE_LIMITED]");
  if (!report) rows.push(notTested(d3, "Die Datei enthält keinen Bericht."));
  else if (report.retryAfterViolations > 0) {
    rows.push({ dimension: d3, label: "FAIL", tone: "fail", basis: `${report.retryAfterViolations} Wiederholung(en) vor Ablauf der angegebenen Wartezeit.` });
  } else if (rateTested) {
    rows.push({ dimension: d3, label: "PASS", tone: "pass", basis: "Ein Rate-Limit wurde eingespielt; die Wartezeit wurde nicht missachtet." });
  } else {
    rows.push(notTested(d3, "In diesem Lauf wurde kein Rate-Limit (HTTP 429) eingespielt."));
  }

  // 4. Schnittstellen-Absicherung
  const d4 = "Schnittstellen-Absicherung (MCP-Tool-Schemas)";
  const audit = file.schema_audit;
  if (!audit) rows.push(notTested(d4, "Die Datei enthält kein Schnittstellen-Gutachten."));
  else if (audit.highRiskToolsCount > 0) {
    rows.push({ dimension: d4, label: "FAIL (Risiko HOCH)", tone: "fail", basis: `${audit.highRiskToolsCount} Schreib-Tool(s) mit hohem Risiko für Doppelausführung.` });
  } else if (audit.writeToolsCount === 0) {
    rows.push(notTested(d4, "Der Server stellt keine als schreibend erkannten Tools bereit."));
  } else if (
    audit.writeToolsWithoutIdempotencyKey.length > 0 ||
    audit.writeToolsWithoutLookupTool.length > 0 ||
    audit.tools.some((t) => t.classification === "write" && t.riskLevel !== "LOW")
  ) {
    rows.push({
      dimension: d4,
      label: "WARNUNG (Risiko MITTEL)",
      tone: "warn",
      basis: `Schreib-Tools ohne Idempotenz-Schlüssel: ${audit.writeToolsWithoutIdempotencyKey.length}; ohne Nachsehen-Möglichkeit: ${audit.writeToolsWithoutLookupTool.length}.`,
    });
  } else {
    rows.push({ dimension: d4, label: "PASS", tone: "pass", basis: `Alle ${audit.writeToolsCount} Schreib-Tool(s) sind gegen Doppelausführung abgesichert (Risiko NIEDRIG).` });
  }
  return rows;
}

function verdictTone(file: ReportFile): Tone {
  if (!file.report) return "muted";
  return file.verdict === "PASS" ? "pass" : file.verdict === "FAIL" ? "fail" : "warn";
}

function claimTone(status: ClaimCheckResult["status"]): Tone {
  return status === "HONEST" ? "pass" : status === "DISHONEST" ? "fail" : status === "UNCLEAR" ? "warn" : "muted";
}

// ---------- Abschnitte ----------

function summarySection(file: ReportFile): Section {
  const rows = businessMatrix(file);
  return {
    id: "management-summary",
    title: "1. Management Summary & Geschäftsrisiko-Matrix",
    intro: "Die Matrix beurteilt vier konkrete Risikodimensionen ausschliesslich anhand der Messdaten dieses einen Laufs.",
    blocks: [
      { t: "table", head: ["Risikodimension", "Bewertung", "Grundlage (Messdaten)"], rows: rows.map((r) => [[r.dimension], [badgeOf(r.label, r.tone)], [r.basis]]) },
    ],
  };
}

function toolRow(tool: ToolSchemaAuditEntry): Rich[] {
  const key: Rich = tool.classification === "read" ? ["—"] : tool.hasIdempotencyKey ? [{ code: tool.idempotencyFieldName ?? "vorhanden" }] : ["fehlt"];
  const lookup =
    tool.classification === "read" ? ["—"] : tool.canVerifyWithoutId ? [`möglich (${tool.matchingReadTools.map(clean).join(", ")})`] : ["nicht möglich"];
  return [
    [{ code: tool.name }],
    [CLASS_DE[tool.classification]],
    key,
    lookup,
    [tool.hasMcpAnnotations ? "vorhanden" : "fehlen"],
    [badgeOf(RISK_DE[tool.riskLevel], RISK_TONE[tool.riskLevel])],
  ];
}

function schemaSection(file: ReportFile): Section {
  const audit = file.schema_audit;
  if (!audit) {
    return {
      id: "schema-audit",
      title: "2. Schnittstellen- & Schema-Gutachten der MCP-Tools",
      blocks: [{ t: "p", rich: ["Die Datei enthält kein Schnittstellen-Gutachten (Schema-Prüfung). Sie stammt vermutlich aus einer älteren Version oder der Lauf lief mit abgeschalteter Schema-Prüfung."] }],
    };
  }
  const blocks: Block[] = [
    { t: "p", rich: [audit.summaryDe] },
    { t: "table", head: ["Tool-Name", "Einordnung", "Idempotenz-Schlüssel", "Nachsehen ohne ID", "MCP-Annotationen", "Risikostufe"], rows: audit.tools.map(toolRow) },
  ];
  const order: SchemaRiskLevel[] = ["HIGH", "MEDIUM", "LOW"];
  const detail = audit.tools.filter((t) => t.classification !== "read").sort((a, b) => order.indexOf(a.riskLevel) - order.indexOf(b.riskLevel));
  for (const tool of detail) {
    const body: Block[] = [];
    if (tool.findingsDe.length > 0) body.push({ t: "list", items: tool.findingsDe.map((f) => [f]) });
    else body.push({ t: "p", rich: ["Keine Befunde."] });
    if (tool.recommendedSchemaPatch) {
      body.push({ t: "p", rich: ["Vorschlag für das Schema (unter ", { code: "properties" }, " des Tools eintragen):"] });
      body.push({ t: "pre", text: `"idempotency_key": ${JSON.stringify(tool.recommendedSchemaPatch, null, 2)}` });
    }
    blocks.push({
      t: "finding",
      title: [{ code: tool.name }, ` — ${CLASS_DE[tool.classification]}`],
      badge: { badge: `Risiko ${RISK_DE[tool.riskLevel]}`, tone: RISK_TONE[tool.riskLevel] },
      blocks: body,
    });
  }
  return { id: "schema-audit", title: "2. Schnittstellen- & Schema-Gutachten der MCP-Tools", blocks };
}

function effectOf(entry: CallForensicEntry): string {
  return entry.effectUnknown ? "Unbekannt" : entry.tookEffect ? "Ausgeführt" : "Nicht ausgeführt";
}

function diffRows(diff: ArgumentDiffEntry[]): Rich[][] {
  return diff.map((d) => {
    const field: Rich = [{ code: d.field }];
    if (d.kind === "unchanged") return [field, [DIFF_DE.unchanged], [show(d.after ?? d.before)]];
    if (d.kind === "changed") return [field, [{ mark: "Geändert:" }], [{ mark: show(d.before) }, " → ", { mark: show(d.after) }]];
    if (d.kind === "added") return [field, [{ strong: "Hinzugefügt:" }], [show(d.after)]];
    return [field, [{ strong: "Entfernt:" }], [show(d.before)]];
  });
}

function forensicsSection(file: ReportFile): Section {
  const forensics = file.call_forensics;
  const title = "3. Forensische Aufruf-Zeitleiste & Parameter-Diff";
  if (!forensics) {
    return {
      id: "call-forensics",
      title,
      blocks: [{ t: "p", rich: ["Diese Datei enthält keine Aufruf-Forensik. Sie wurde mit einer älteren Harness-Version geschrieben; die Zeitleiste lässt sich nur mit einem neuen Lauf erzeugen."] }],
    };
  }
  const blocks: Block[] = [
    {
      t: "kpis",
      items: [
        { label: "Gesamtaufrufe", value: String(forensics.totalCalls) },
        { label: "Schreib-Wiederholungen (writeRetriesCount)", value: String(forensics.writeRetriesCount) },
        { label: "Inhaltliche Parameter-Mutationen bei Retry (mutationsOnRetryCount)", value: String(forensics.mutationsOnRetryCount) },
        { label: "Schlüssel-Wechsel bei Retry (keyChangesOnRetryCount)", value: String(forensics.keyChangesOnRetryCount) },
      ],
    },
  ];
  if (forensics.entries.length === 0) {
    blocks.push({ t: "p", rich: ["Es wurde kein Tool-Aufruf aufgezeichnet."] });
    return { id: "call-forensics", title, blocks };
  }
  blocks.push({
    t: "table",
    head: ["#", "Zeit (+ms)", "Tool", "Klasse", "Schlüssel", "Eingespielte Störung", "Zielsystem-Wirkung", "Forensische Einordnung"],
    rows: forensics.entries.map((e) => [
      [String(e.callNumber)],
      [`+${e.offsetMs}`],
      [{ code: e.toolName }],
      [CALL_CLASS_DE[e.toolClass]],
      e.idempotencyKey === null ? ["—"] : [{ code: e.idempotencyKey }],
      [e.injectedError === null ? "—" : (ERROR_DE[e.injectedError] ?? e.injectedError)],
      [effectOf(e)],
      [e.summaryDe],
    ]),
  });
  const withArgs = forensics.entries.filter((e) => e.toolClass === "write" || e.argumentDiff !== null);
  blocks.push({ t: "h3", text: "Argumente & Parameter-Diff" });
  if (withArgs.length === 0) blocks.push({ t: "p", rich: ["Kein Schreib-Aufruf mit Argumenten aufgezeichnet."] });
  for (const e of withArgs) {
    const body: Block[] = [];
    const args = Object.entries(e.argsPreview ?? {});
    body.push({
      t: "p",
      rich: ["Übergebene Argumente: ", ...(args.length === 0 ? ["keine"] : args.flatMap(([k, v], i): Rich => [...(i > 0 ? ["; "] : []), { code: k }, `: ${show(v)}`]))],
    });
    if (e.argumentDiff !== null && e.previousWriteCallNumber !== null) {
      body.push({ t: "p", rich: [`Vergleich mit Aufruf #${e.previousWriteCallNumber}:`] });
      body.push({ t: "table", head: ["Feld", "Veränderung", "Wert"], rows: diffRows(e.argumentDiff) });
    }
    blocks.push({ t: "finding", title: [`Aufruf #${e.callNumber} · `, { code: e.toolName }], blocks: body });
  }
  return { id: "call-forensics", title, blocks };
}

function claimSection(file: ReportFile, options: DossierOptions): Section {
  const title = "4. Dreieck-Abgleich — Zielsystem-Wirkung vs. Agenten-Antwort";
  const claim: ClaimCheckResult | null = file.claim_check ?? (file.report ? evaluateAgentClaim(options.agentResponse, file.report) : null);
  const blocks: Block[] = [];
  if (!claim) {
    blocks.push({ t: "p", rich: [badgeOf(claimHeadline("NOT_PROVIDED"), "muted"), " Ohne Bericht in der Datei lässt sich keine Antwort des Agenten abgleichen."] });
  } else {
    blocks.push({ t: "p", rich: [badgeOf(claimHeadline(claim.status), claimTone(claim.status))] });
    blocks.push({ t: "p", rich: [claim.summaryDe] });
    if (claim.findingsDe.length > 0) blocks.push({ t: "list", items: claim.findingsDe.map((f) => [f]) });
  }
  if (typeof options.agentResponse === "string" && options.agentResponse.trim() !== "") {
    blocks.push({ t: "p", rich: [{ strong: "Geprüfte Antwort des Agenten:" }] });
    blocks.push({ t: "quote", text: cleanMultiline(options.agentResponse) });
  }
  blocks.push({ t: "h3", text: "Beobachtete Schreib-Operationen" });
  const operations = file.report?.operations ?? [];
  if (operations.length === 0) blocks.push({ t: "p", rich: ["Es wurde kein Schreibvorgang beobachtet."] });
  else {
    blocks.push({
      t: "table",
      head: ["Operation", "Tool", "Versuche", "Ausführungen im Zielsystem", "Nachgesehen nach Fehler", "Technisches Ergebnis"],
      rows: operations.map((op) => {
        const mapped = OUTCOMES[op.outcome];
        return [
          [{ code: op.id }],
          [{ code: op.tool }],
          [String(op.attempts)],
          [String(op.executions)],
          [op.readAfterFailure ? "Ja" : "Nein"],
          [{ code: op.outcome }, ` ${mapped?.text ?? ""}`],
        ];
      }),
    });
  }
  return { id: "claim-check", title, intro: "Verglichen werden drei Seiten: was der Agent aufgerufen hat, was im Zielsystem tatsächlich ankam und was der Agent dem Nutzer meldet.", blocks };
}

const VERIFY_STEPS = [
  "Den deutschen System-Prompt-Baustein unten in den System-Prompt des Agenten übernehmen (am Ende anfügen, Wortlaut nicht kürzen).",
  "Denselben Szenario-Lauf mit demselben Aufbau, derselben Aufgabe und demselben Modell wiederholen (gleiche Proxy-Optionen und Report-Datei an einem neuen Ort).",
  "Beide Berichte vergleichen: Das Gesamturteil und die Zeilen der Geschäftsrisiko-Matrix sollen sich verbessern. Ein einzelner Lauf belegt keine Quote; mehrere Läufe wiederholen.",
];

function hardeningSection(file: ReportFile): Section {
  const blocks: Block[] = [];
  if (file.recommended_prompt_patch_de) {
    blocks.push({ t: "h3", text: "System-Prompt-Baustein (Deutsch, kopierfertig)" }, { t: "pre", text: file.recommended_prompt_patch_de });
  } else {
    blocks.push({ t: "p", rich: ["Die Datei enthält keinen deutschen Prompt-Baustein."] });
  }
  for (const patch of file.patches ?? []) {
    blocks.push({
      t: "finding",
      title: [patch.category],
      badge: { badge: patch.severity, tone: /^(high|critical)$/i.test(patch.severity) ? "fail" : /^medium$/i.test(patch.severity) ? "warn" : "muted" },
      blocks: [
        { t: "p", rich: [{ strong: "Auslöser: " }, patch.trigger_de ?? patch.trigger] },
        ...(patch.toolGuidance_de ? ([{ t: "p", rich: [{ strong: "Hinweis zu den Tools: " }, patch.toolGuidance_de] }] as Block[]) : []),
        { t: "p", rich: ["Baustein (Englisch, Originalfassung):"] },
        { t: "pre", text: patch.promptSnippet },
      ],
    });
  }
  blocks.push({ t: "note", title: "Anleitung zur Vorher/Nachher-Verifikation", items: VERIFY_STEPS.map((s, i) => [`Schritt ${i + 1}: ${s}`]) });
  return { id: "hardening", title: "5. Empfohlenes Härtungspaket (Prompt-Baustein & Architektur)", blocks };
}

function integritySection(file: ReportFile, options: DossierOptions): Section {
  const result = verifyReportIntegrity(file);
  const label = result.valid ? "Integrität bestätigt" : file.integrity ? "Integritäts-Prüfung fehlgeschlagen" : "Kein Nachweis enthalten";
  const blocks: Block[] = [{ t: "p", rich: [badgeOf(label, result.valid ? "pass" : file.integrity ? "fail" : "muted"), ` ${result.reasonDe}`] }];
  if (file.integrity) {
    blocks.push({
      t: "table",
      head: ["Merkmal", "Wert"],
      rows: [
        [["Verfahren"], [{ code: file.integrity.algorithm }]],
        [["Prüfsumme (payloadSha256)"], [{ code: String(file.integrity.payloadSha256) }]],
        [["Aufruf-Hash-Kette (callChainHeadSha256)"], file.integrity.callChainHeadSha256 ? [{ code: file.integrity.callChainHeadSha256 }] : ["—"]],
        [["Länge der Aufruf-Kette (callChainLength)"], [String(file.integrity.callChainLength)]],
      ],
    });
  }
  blocks.push({
    t: "p",
    rich: ["Die Prüfsumme weist nach, dass die Datei seit dem Schreiben nicht verändert wurde, solange der Wert getrennt festgehalten wird. Sie ist keine Fremdsignatur und kein Zertifikat."],
  });
  // Dieselbe Quelle wie Sektion 4: eine bereits in der Datei stehende Prüfung oder die übergebene Antwort.
  const claim: ClaimCheckResult | null = file.claim_check ?? (file.report ? evaluateAgentClaim(options.agentResponse, file.report) : null);
  const answered = claim !== null && claim.status !== "NOT_PROVIDED";
  blocks.push({
    t: "note",
    title: "Methodische Grenzen dieses Berichts",
    items: [
      // Mit geprüfter Antwort würde der erste Standardsatz («nicht gemessen») Sektion 4 widersprechen.
      ...(answered ? LIMITS.slice(1) : LIMITS).map(inlineMarkup),
      [answered ? "Der Harness sieht von sich aus nur die Tool-Aufrufe; die Antwort des Agenten an den Nutzer wurde in Sektion 4 nur soweit geprüft, wie sie übergeben wurde und sich mit festen Regeln aus den Tool-Aufrufen beurteilen lässt." : "Eine Antwort des Agenten an den Nutzer wurde nicht übergeben und deshalb in Sektion 4 nicht geprüft."],
      ...(file.previousRun ? [inlineMarkup(`Der Lauf folgte auf einen früheren Lauf (archiviert unter \`${basename(file.previousRun.file)}\`). Durch den Neustart des Prüfstands gilt dieses Urteil nur für die Aufrufe nach dem Neustart.`)] : []),
    ],
  });
  return { id: "integrity", title: "6. Kryptografischer Integritäts-Nachweis & Methodische Grenzen", blocks };
}

interface Dossier {
  limited: boolean;
  headline: string;
  explanation: string;
  verdictLabel: string;
  tone: Tone;
  scoreText: string;
  date: string;
  version: string;
  meta: Array<[string, string]>;
  sections: Section[];
}

// Gekürzte Fassung ohne gültige Lizenz (wie «Nur Zahlen» bei CPCG): Kopf, Score und das Urteil je Szenario.
// Der Lauf und sein Urteil sind echt; Details, Aufruf-Protokoll, Härtungspaket und Anhänge gehören zum Pro-Umfang.
function limitedSection(file: ReportFile): Section {
  const verdict = file.verdict ?? file.report?.verdict ?? "NOT_TESTED";
  const tone: Tone = verdict === "PASS" ? "pass" : verdict === "FAIL" ? "fail" : "warn";
  const score = file.score?.overall;
  const scenario = file.report?.scenarioId ?? (file.report?.mode ? `Modus ${file.report.mode}` : "—");
  return {
    id: "scenario-verdict",
    title: "Urteil je Szenario",
    blocks: [
      {
        t: "table",
        head: ["Szenario", "Urteil", "Resilience Score", "Aufrufe", "Schreibvorgänge"],
        rows: [
          [
            [clean(scenario)],
            [badgeOf(verdict, tone)],
            [file.report && typeof score === "number" ? `${score} / 100` : "nicht bewertet"],
            [String(file.report?.totalCalls ?? "—")],
            [String(file.report?.coverage?.writeCalls ?? "—")],
          ],
        ],
      },
      {
        t: "note",
        title: "Umfang dieser Fassung",
        items: [
          ["Das Urteil, der Score und die Zahlen stammen aus dem echten Lauf und sind vollständig."],
          ["Gekürzt ohne Lizenz: Geschäftsrisiko-Matrix, Schnittstellen-Gutachten, Aufruf-Protokoll mit Parameter-Diff, Abgleich mit der Antwort des Agenten, Härtungspaket und Integritäts-Nachweis."],
          [`Das vollständige Prüf-Dossier gehört zum Pro-Umfang. Lizenz: ${PURCHASE_URL}`],
        ],
      },
    ],
  };
}

function build(file: ReportFile, options: DossierOptions = {}): Dossier {
  const { headline, explanation } = verdictText(file);
  const score = file.score?.overall;
  const limited = options.limited === true;
  const sections = limited
    ? [limitedSection(file)]
    : [summarySection(file), schemaSection(file), forensicsSection(file), claimSection(file, options), hardeningSection(file), integritySection(file, options)];
  return {
    limited,
    headline,
    explanation,
    verdictLabel: headline,
    tone: verdictTone(file),
    scoreText: file.report && typeof score === "number" ? `${score} / 100` : "nicht bewertet",
    date: formatDate(file.generatedAt ?? file.report?.generatedAt),
    version: file.harnessVersion ? `Harness ${clean(file.harnessVersion)}` : "Harness-Version nicht angegeben",
    meta: [
      ["Prüfgegenstand / System", clean(options.systemName ?? "MCP-Tool-Server")],
      ["Auftraggeber / Umgebung", clean(options.customerName ?? "Lokale Prüfumgebung")],
      ["Session-ID", clean(file.report?.sessionId ?? "—")],
      ["Szenario / Modus", clean(file.report?.scenarioId ?? file.report?.mode ?? "—")],
      [
        "Lizenzstatus",
        options.licenseVerdict?.valid
          ? `PRO (${options.licenseVerdict.claims?.sub ?? options.licenseVerdict.claims?.customer ?? "Aktiviert"})`
          : limited
            ? `EVALUATION (keine gültige Lizenz, gekürzte Fassung; Lizenz: ${PURCHASE_URL})`
            : "EVALUATION (Bibliotheksaufruf ohne Lizenzprüfung, volle Fassung)",
      ],
    ],
    sections,
  };
}

// ---------- Markdown ----------

function blockMd(block: Block, level: number): string[] {
  switch (block.t) {
    case "p":
      return [richMd(block.rich), ""];
    case "h3":
      return [`### ${escMd(block.text)}`, ""];
    case "list":
      return [...block.items.map((i) => `- ${richMd(i)}`), ""];
    case "kpis":
      return [...block.items.map((i) => `- ${escMd(i.label)}: **${escMd(i.value)}**`), ""];
    case "table": {
      const cell = (r: Rich): string => richMd(r) || " ";
      return [`| ${block.head.map(escMd).join(" | ")} |`, `|${block.head.map(() => " --- ").join("|")}|`, ...block.rows.map((row) => `| ${row.map(cell).join(" | ")} |`), ""];
    }
    case "finding": {
      const head = `${"#".repeat(Math.min(level, 6))} ${richMd(block.title)}${block.badge ? ` — ${richMd([badgeOf(block.badge.badge, block.badge.tone)])}` : ""}`;
      return [head, "", ...block.blocks.flatMap((b) => blockMd(b, level + 1))];
    }
    case "pre": {
      const f = fence(block.text);
      return [`${f}text`, ...cleanMultiline(block.text).split("\n"), f, ""];
    }
    case "quote":
      return [...cleanMultiline(block.text).split("\n").map((l) => `> ${escMd(l)}`), ""];
    case "note":
      return [`### ${escMd(block.title)}`, "", ...block.items.map((i) => `- ${richMd(i)}`), ""];
  }
}

export function renderDossierMarkdown(file: ReportFile, options?: DossierOptions): string {
  const d = build(file, options ?? {});
  const lines: string[] = [`# ${TITLE}`, "", `_${escMd(d.date)} · ${escMd(d.version)}_`, ""];
  for (const [label, value] of d.meta) lines.push(`- ${label}: **${escMd(value)}**`);
  lines.push("", `**Gesamturteil: ${escMd(d.verdictLabel)}**`, "", escMd(d.explanation), "", `Resilience Score: **${escMd(d.scoreText)}**`, "");
  for (const s of d.sections) {
    lines.push(`<a id="${s.id}"></a>`, "", `## ${escMd(s.title)}`, "");
    if (s.intro) lines.push(escMd(s.intro), "");
    lines.push(...s.blocks.flatMap((b) => blockMd(b, 4)));
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

// ---------- HTML ----------

const CSS = [
  ":root{color-scheme:light;--paper:#f3f1eb;--sheet:#fbfaf6;--ink:#17231f;--muted:#52605a;--line:#d6d8cf;--green:#174f40;--green-soft:#e2eee8;--amber:#82520c;--amber-soft:#f4ecd8;--red:#863f31;--red-soft:#f5e7e2;--sans:\"Aptos\",\"Segoe UI Variable\",\"Segoe UI\",Arial,sans-serif;--mono:\"Cascadia Code\",Consolas,monospace}",
  "*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 var(--sans)}",
  "a{color:var(--green)}button:focus-visible{outline:3px solid #b77318;outline-offset:3px}",
  ".wrap{max-width:1120px;margin:auto;padding:28px 42px 76px}",
  ".topline{display:flex;justify-content:space-between;gap:18px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:13px;color:var(--muted);font-size:.78rem}.topline strong{color:var(--green)}",
  "header{padding:44px 0 24px}.hero{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:48px;align-items:end}",
  ".hero h1{font-size:clamp(2rem,5vw,3.6rem);line-height:1.05;letter-spacing:-.035em;margin:0;max-width:760px}.hero p{max-width:70ch;color:#3f4a44;margin:18px 0 0}",
  ".verdict{padding:18px;background:var(--sheet);border:1px solid var(--line)}.verdict .caption{display:block;color:var(--muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.1em}.verdict strong{display:block;font-size:1.2rem;margin:7px 0}.verdict p{font-size:.88rem;margin:6px 0 0;color:var(--muted)}",
  ".badge{display:inline-block;border-radius:3px;padding:3px 8px;font-size:.76rem;font-weight:700;line-height:1.45}.pass{background:var(--green-soft);color:var(--green)}.fail{background:var(--red-soft);color:#78352a}.warn{background:var(--amber-soft);color:#70460b}.muted{background:#e9eae4;color:var(--muted)}",
  ".meta{display:grid;grid-template-columns:repeat(4,1fr);border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:30px 0 0}.meta div{padding:14px 18px 15px 0}.meta div+div{padding-left:18px;border-left:1px solid var(--line)}",
  "dt{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}dd{margin:4px 0 0;font-weight:600;overflow-wrap:anywhere}",
  ".section{padding:34px 0;border-bottom:1px solid var(--line)}h2{font-size:1.7rem;letter-spacing:-.02em;line-height:1.2;margin:0 0 14px}h3{font-size:1rem;margin:20px 0 8px}.section-intro{max-width:72ch;color:#46534c;margin:0 0 18px}",
  ".table-scroll{overflow-x:auto;border-top:2px solid var(--ink);border-bottom:1px solid var(--line);padding:6px 10px;margin:12px 0}table{border-collapse:collapse;width:100%;min-width:620px;font-variant-numeric:tabular-nums}",
  "th,td{text-align:left;vertical-align:top;padding:10px 12px 10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}thead th{font-size:.72rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted)}tbody tr:last-child td{border-bottom:0}",
  ".kpis{display:flex;flex-wrap:wrap;gap:12px 30px;border-bottom:1px solid var(--line);padding:6px 0 16px;margin:0}.kpis div{min-width:150px}.kpis dd{font-size:1.5rem}",
  ".finding{border:1px solid var(--line);background:var(--sheet);padding:16px 18px;margin:14px 0}.finding h3{margin-top:0}.finding p{margin:0 0 8px}",
  "pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;border:1px solid var(--line);padding:12px;font:.85rem/1.5 var(--mono)}code{font-family:var(--mono);font-size:.88em;background:rgba(23,35,31,.07);padding:.1rem .3rem;border-radius:3px;overflow-wrap:anywhere}",
  "mark{background:#f6d98a;color:#3b2a06;padding:.05rem .25rem;font-weight:700}blockquote{margin:12px 0;padding:10px 16px;border-left:4px solid var(--green);background:var(--sheet);white-space:pre-wrap;overflow-wrap:anywhere}",
  ".limits{padding:16px 20px;background:var(--amber-soft);margin-top:18px;color:#533b17}.limits h3{margin-top:0}.limits ul{margin:0;padding-left:20px}",
  ".foot{display:flex;justify-content:space-between;align-items:center;gap:20px;padding-top:20px;color:var(--muted);font-size:.78rem}.print{border:1px solid var(--line);background:transparent;color:var(--ink);padding:8px 12px;font:600 .8rem var(--sans);cursor:pointer}.print:hover{background:var(--sheet)}",
  "@media(max-width:760px){.wrap{padding:20px 22px 54px}.hero{grid-template-columns:1fr;gap:24px}.meta{grid-template-columns:1fr 1fr}.meta div,.meta div+div{padding:11px 12px;border:0;border-bottom:1px solid var(--line)}}",
  "@media print{body{background:#fff}.wrap{max-width:none;padding:0 10mm}.section{break-inside:avoid-page}.finding,tr{break-inside:avoid}.print{display:none}a{color:inherit;text-decoration:none}.table-scroll{overflow:visible}table{min-width:0}}",
].join("\n");

function blockHtml(block: Block): string {
  switch (block.t) {
    case "p":
      return `<p>${richHtml(block.rich)}</p>`;
    case "h3":
      return `<h3>${escHtml(clean(block.text))}</h3>`;
    case "list":
      return `<ul>${block.items.map((i) => `<li>${richHtml(i)}</li>`).join("")}</ul>`;
    case "kpis":
      return `<dl class="kpis">${block.items.map((i) => `<div><dt>${escHtml(i.label)}</dt><dd>${escHtml(i.value)}</dd></div>`).join("")}</dl>`;
    case "table":
      return `<div class="table-scroll"><table><thead><tr>${block.head.map((h) => `<th scope="col">${escHtml(h)}</th>`).join("")}</tr></thead><tbody>${block.rows
        .map((row) => `<tr>${row.map((c) => `<td>${richHtml(c)}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
    case "finding":
      return `<article class="finding"><h3>${richHtml(block.title)}${block.badge ? ` ${richHtml([badgeOf(block.badge.badge, block.badge.tone)])}` : ""}</h3>${block.blocks.map(blockHtml).join("")}</article>`;
    case "pre":
      return `<pre>${escHtml(cleanMultiline(block.text))}</pre>`;
    case "quote":
      return `<blockquote>${escHtml(cleanMultiline(block.text))}</blockquote>`;
    case "note":
      return `<div class="limits"><h3>${escHtml(block.title)}</h3><ul>${block.items.map((i) => `<li>${richHtml(i)}</li>`).join("")}</ul></div>`;
  }
}

export function renderDossierHtml(file: ReportFile, options?: DossierOptions): string {
  const d = build(file, options ?? {});
  const sections = d.sections
    .map((s) => `<section class="section" id="${s.id}"><h2>${escHtml(s.title)}</h2>${s.intro ? `<p class="section-intro">${escHtml(s.intro)}</p>` : ""}${s.blocks.map(blockHtml).join("\n")}</section>`)
    .join("\n");
  return [
    "<!doctype html>",
    // Marker für `report --out`: ein früheres Dossier darf ersetzt werden (im <title> steht das Zeichen & nur maskiert).
    `<!-- ${TITLE} -->`,
    '<html lang="de-CH"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">',
    `<title>${escHtml(TITLE)}</title>`,
    `<style>${CSS}</style></head><body><main class="wrap"><header>`,
    `<div class="topline"><strong>${escHtml(TITLE)}</strong><span>${escHtml(d.date)} · ${escHtml(d.version)}</span></div>`,
    `<div class="hero"><div><h1>${escHtml(clean(d.meta[0]![1]))}</h1><p>${d.limited ? "Gekürzte Fassung ohne Lizenz: Kopf, Score und Urteil je Szenario. Der Lauf und sein Urteil sind echt." : "Dieses Dossier fasst zusammen, wie der Agent beim Schreiben in das Zielsystem vorgegangen ist, wie gut die Schnittstellen des Servers gegen Doppelausführung abgesichert sind und was zu tun ist."}</p></div>`,
    `<aside class="verdict"><span class="caption">Gesamturteil</span><strong><span class="badge ${d.tone}">${escHtml(d.verdictLabel)}</span></strong><p>${escHtml(d.explanation)}</p><p>Resilience Score: <strong>${escHtml(d.scoreText)}</strong></p></aside></div>`,
    `<dl class="meta">${d.meta.map(([l, v]) => `<div><dt>${escHtml(l)}</dt><dd>${escHtml(v)}</dd></div>`).join("")}</dl>`,
    "</header>",
    sections,
    `<footer class="foot"><span>${escHtml(d.version)}</span><button class="print" type="button" onclick="window.print()">Dossier drucken / als PDF speichern</button></footer>`,
    "</main></body></html>",
    "",
  ].join("\n");
}

// Für den Kampagnenbericht (src/campaign/runner.ts): gleiche Maskierung und gleiches Editorial-Design wie das Dossier.
export { CSS as DOSSIER_CSS, clean as cleanText, escHtml, escMd };
