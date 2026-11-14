// `verify <dossier|report|bench-report>`: rechnet die Prüfsumme einer Report-Datei, eines Dossiers oder eines Bench-Berichts neu und meldet
// OK, TEILWEISE oder MISMATCH mit dem Grund. Exit-Code: 0 bei OK, 2 bei TEILWEISE, 1 sonst. «OK» heisst: alles wurde geprüft. Konnte ein Teil
// nicht geprüft werden (der Fliesstext eines Dossiers ohne Neuaufbau aus dem Report, die Rohdaten eines Bench-Berichts), lautet das Ergebnis
// «TEILWEISE», nie «OK». Es bleibt eine Prüfsumme ohne Signatur eines Dritten: Wer Datei und Prüfsumme zusammen ändert, kann fälschen; der Wert
// schützt nur, wenn er getrennt von der Datei aufbewahrt wird (dafür gibt es `--expect <sha256>`).
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DOSSIER_SEAL_MARKER, canonicalJson, checkReportIntegrity, extractDossierSeal, sha256Hex, type DossierCore, type IntegrityCheck } from "./core/artifact-integrity.js";
import { BENCH_CHAPTER_ANCHOR, dossierBenchChecks, dossierHeaderChecks, dossierSectionChecks, renderDossierHtml, renderDossierMarkdown, type DossierOptions } from "./dossier-report.js";
import { evaluateAgentClaim } from "./core/claim-check.js";
import { VERSION } from "./version.js";
import { CLAIM_CHECK_OLDER_DE, benchCoreMatching, claimCheckOlder, diffBenchCores, validateBenchDocument } from "./dossier-bench.js";
import { CLAIM_CHECK_VERSION } from "./core/claim-check.js";
import type { ReportFile } from "./plain-report.js";
import { BENCH_MARKDOWN_NAME, benchConsistencyProblems, checkBenchIntegrity, looksLikeBenchReport, markdownSha256, type BenchDocument, type BenchRunRow } from "./bench/report.js";
import { deriveRunFacts, writeExecutedOf, type ProxyReportFile } from "./bench/run-facts.js";
import { isScenarioSettings, settingOf } from "./bench/scenarios.js";

const MAX_BYTES = 64 * 1024 * 1024;

function countOf(text: string, part: string): number {
  if (part === "") return 0;
  let n = 0;
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n++;
  return n;
}

// Neu gespeicherte Dateien: Unicode-Normalform (NFD/NFC) und Leerzeichen am Zeilenende sind keine Änderung des Inhalts.
const norm = (text: string): string => text.normalize("NFC").replace(/[ \t]+$/gm, "");

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

const USAGE = "Usage: verify <dossier|report-file|bench-report.json|bench-report.md> [--report <report-file>] [--bench <bench-report.json>] [--no-rerender] [--expect <sha256>]\n";

const HELP =
  `${USAGE}\n` +
  "Rechnet die Prüfsumme einer Report-Datei (--report-file des Proxys), eines Dossiers (report --dossier) oder eines\n" +
  "Bench-Berichts (bench-report.json der Mehrlauf-Messung bench) neu und gibt den Status mit dem Grund aus:\n" +
  "  OK         alles wurde geprüft (Dossier: Siegel, Kern, Kopf, Abschnitte, Kapitel UND der Fliesstext durch Neuaufbau aus dem Report;\n" +
  "             Bench-Bericht: Siegel, Aggregate aus den Läufen, Lauf-Dateien in runs/ und der Lesetext)        Exit-Code 0\n" +
  "  TEILWEISE  alles Geprüfte stimmt, ein Teil liess sich nicht prüfen (Dossier ohne --report: Fliesstext NICHT geprüft;\n" +
  "             Bench-Bericht ohne den Ordner runs/: Rohdaten nicht geprüft)                                      Exit-Code 2\n" +
  "  MISMATCH   eine Prüfung ist fehlgeschlagen, oder die Datei ist nicht prüfbar                                 Exit-Code 1\n" +
  "Die erste Ausgabezeile nennt den Status und den Umfang («Fliesstext: geprüft» oder «Fliesstext: NICHT geprüft»).\n" +
  "  --report <file>   bei einem Dossier die Report-Datei angeben, aus der es erzeugt wurde. Das Dossier wird dann automatisch aus der\n" +
  "                    Report-Datei (und dem Bench-Bericht) mit denselben Angaben neu erzeugt und Abschnitt für Abschnitt mit der Datei\n" +
  "                    verglichen (Leerraum zählt nicht): Damit ist auch der Fliesstext geprüft. Kunden- und Systemname, Format, Antwort des\n" +
  "                    Agenten und Lizenzstatus liest der Befehl aus dem Dossier selbst; eine Lizenz braucht die Prüfung nicht. Das zeigt, dass\n" +
  "                    der Fliesstext aus dieser Report-Datei folgt; es zeigt nicht, dass die Report-Datei echt ist, und\n" +
  "                    kein Dritter bestätigt es (wer Report-Datei und Dossier zusammen ändert, kann fälschen). Dossiers aus\n" +
  "                    Harness < 0.12.0 sind nicht neu aufbaubar (Ergebnis dann höchstens TEILWEISE).\n" +
  "  --bench <file>    bei einem Dossier mit Kapitel «Mehrlauf-Messung» den Bench-Bericht (bench-report.json) angeben: Zahlen und Methode im\n" +
  "                    Dossier müssen zu ihm passen, und der Bericht muss in sich widerspruchsfrei sein. Ohne --bench bleibt es TEILWEISE.\n" +
  "  --rerender        Alias: der Neuaufbau läuft mit --report ohnehin (braucht --report)\n" +
  "  --no-rerender     den Neuaufbau abschalten (nur mit --report); das Ergebnis ist dann TEILWEISE\n" +
  "  --expect <sha256> die getrennt aufbewahrte Prüfsumme (Report-Datei: payloadSha256; Dossier: Prüfsumme des Dossiers);\n" +
  "                    stimmt sie nicht mit der Datei überein, ist das ein MISMATCH\n" +
  "Bench-Bericht: verify bench-report.json rechnet Aggregate und Vergleich aus runs[] neu (Abweichung: MISMATCH, auch bei neu gerechnetem\n" +
  "Siegel), prüft jede Datei in runs/ gegen ihren Hash (fehlende Dateien: MISMATCH; fehlt der Ordner runs/ ganz: TEILWEISE, «Rohdaten nicht\n" +
  "geprüft») und leitet toolCalls, lookedUp, valid, duplicate und resent aus den Rohverläufen ab. verify bench-report.md prüft den Lesetext\n" +
  "gegen den Hash im Siegel des Berichts im selben Ordner.\n" +
  "Dateien in UTF-16 (mit Byte-Order-Marke) werden wie UTF-8 gelesen; Zeilenenden, Byte-Order-Marke, Unicode-Normalform und Leerzeichen am\n" +
  "Zeilenende gelten nicht als Änderung. Eine Datei, die kein gültiges UTF-8 ist, ist nicht prüfbar (bitte als UTF-8 speichern).\n\n" +
  "Es ist eine Prüfsumme ohne Signatur eines Dritten und kein Zertifikat. Wer Datei und Prüfsumme zusammen ändert, kann\n" +
  "fälschen. Sie schützt nur, wenn der Wert getrennt von der Datei aufbewahrt wird.\n";

export type VerifyStatus = "OK" | "PARTIAL" | "MISMATCH" | "NOT_VERIFIABLE";

export interface VerifyResult {
  status: VerifyStatus;
  kind: "report" | "dossier" | "bench" | "bench-markdown" | "unknown";
  // Die Prüfsumme, die die Datei trägt (Report: payloadSha256, Dossier: Prüfsumme des Kerns).
  sha256: string | null;
  lines: string[];
  // Der Umfang der Prüfung in einem Halbsatz (erste Ausgabezeile bei OK und TEILWEISE).
  scope?: string;
}

function statusOfCheck(check: IntegrityCheck): VerifyStatus {
  if (check.status === "ok") return "OK";
  return check.status === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE";
}

export function verifyReportFileContent(file: ReportFile, expect?: string): VerifyResult {
  const check = checkReportIntegrity(file);
  const lines: string[] = [check.reasonDe];
  let status = statusOfCheck(check);
  const sha = file.integrity?.payloadSha256 ?? null;
  if (status === "OK" && expect !== undefined && expect.toLowerCase() !== sha) {
    status = "MISMATCH";
    lines.unshift(`Die Datei stimmt zwar mit ihrer eigenen Prüfsumme überein, die Prüfsumme ist aber nicht die erwartete: erwartet ${expect.toLowerCase()}, in der Datei ${sha ?? "—"}. Datei und Prüfsumme wurden gemeinsam ausgetauscht oder die falsche Datei liegt vor.`);
  }
  return { status, kind: "report", sha256: sha, lines };
}

// Der angegebene Bench-Bericht gegen das Kapitel im Dossier: Siegel des Berichts, Form und jede Zahl und Angabe der Methode.
function compareWithBench(core: DossierCore, benchFile: Record<string, unknown>): { status: VerifyStatus; lines: string[] } {
  if (core.bench === undefined) {
    return {
      status: "NOT_VERIFIABLE",
      lines: ["Das Dossier enthält kein Kapitel «Mehrlauf-Messung» (es wurde ohne --bench oder ohne gültige Lizenz erzeugt): Es gibt nichts, was sich gegen den Bench-Bericht abgleichen liesse."],
    };
  }
  const check = checkBenchIntegrity(benchFile);
  if (check.status !== "ok") {
    return { status: check.status === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE", lines: [`Der angegebene Bench-Bericht besteht seine eigene Prüfung nicht: ${check.reasonDe}`] };
  }
  const invalid = validateBenchDocument(benchFile);
  if (invalid !== null) return { status: "NOT_VERIFIABLE", lines: [`Der angegebene Bench-Bericht lässt sich nicht abgleichen: ${invalid}`] };
  const contradictions = benchConsistencyProblems(benchFile);
  const selfContradiction = ["Der angegebene Bench-Bericht widerspricht sich selbst: Aggregate, Vergleich oder Zählweise passen nicht zu den Läufen in runs[] (auch ein neu gerechnetes Siegel ändert daran nichts):", ...contradictions.map((c) => `  ${c}`)];
  const diffs = diffBenchCores(core.bench, benchCoreMatching(core.bench, benchFile as unknown as BenchDocument, check));
  if (diffs.length > 0) {
    return {
      status: "MISMATCH",
      lines: ["Die Zahlen oder die Methode im Kapitel «Mehrlauf-Messung» des Dossiers passen nicht zum angegebenen Bench-Bericht:", ...diffs.map((d) => `  ${d}`), ...(contradictions.length > 0 ? selfContradiction : [])],
    };
  }
  if (contradictions.length > 0) return { status: "MISMATCH", lines: selfContradiction };
  const sha = (benchFile.integrity as { payloadSha256?: string } | undefined)?.payloadSha256 ?? "—";
  return { status: "OK", lines: [`Die Zahlen und die Methode im Kapitel «Mehrlauf-Messung» stimmen mit dem angegebenen Bench-Bericht überein (Prüfsumme des Berichts ${sha}).`] };
}

// Die Überschriften der Abschnitte im Markdown-Text, ohne die Zeilen in Code-Zäunen (dort steht Text aus fremden Dateien).
function markdownH2Count(visible: string): number {
  let fence: string | null = null;
  let n = 0;
  for (const line of visible.split("\n")) {
    const open = line.match(/^(`{3,})/);
    if (fence === null) {
      if (open) fence = open[1]!;
      else if (/^## /.test(line)) n++;
    } else if (line.trim() === fence) fence = null;
  }
  return n;
}

// Jeder Abschnitt, den das Siegel kennt, steht mit seiner Überschrift genau einmal im Text, und es gibt keinen weiteren (ein zweites Kapitel 6,
// ein erfundenes «6b. Bestätigung»). null = in Ordnung (oder ein Dossier aus einer Vorabfassung ohne Abschnittsliste im Siegel).
function checkSections(core: DossierCore, visible: string, isHtml: boolean): { status: VerifyStatus; lines: string[] } | null {
  const checks = dossierSectionChecks(core);
  if (checks === null) return null;
  const c = isHtml ? checks.html : checks.md;
  const problems: string[] = [];
  // Leerraum zählt nicht (wie beim Neuaufbau): Doppelte Leerzeichen oder Leerzeilen in einer Überschrift sind keine Änderung.
  const flat = visible.replace(/\s+/g, " ");
  for (const e of c.entries) {
    const n = countOf(flat, norm(e.needle).replace(/\s+/g, " "));
    if (n !== 1) problems.push(`Abschnitt «${e.label}»: ${n === 0 ? "fehlt oder ist verändert" : `steht ${n}-mal im Text`}`);
  }
  const anchors = isHtml ? countOf(visible, "<section") : countOf(visible, '<a id="');
  const headings = isHtml ? countOf(visible, "<h2") : markdownH2Count(visible);
  if (anchors !== c.expectedCount) problems.push(`${anchors} Abschnitte im Text, das Siegel kennt ${c.expectedCount}`);
  if (headings !== c.expectedCount) problems.push(`${headings} Abschnittsüberschriften im Text, das Siegel kennt ${c.expectedCount}`);
  if (problems.length === 0) return null;
  return {
    status: "MISMATCH",
    lines: ["Die Abschnitte des Dossiers weichen vom gesiegelten Kern ab (ein Abschnitt wurde eingefügt, verdoppelt, gelöscht oder umbenannt):", ...problems.slice(0, 8).map((x) => `  ${x}`), ...(problems.length > 8 ? [`  ... und ${problems.length - 8} weitere`] : [])],
  };
}

// Das Kapitel «Mehrlauf-Messung» im sichtbaren Text: aus dem gesiegelten Kern nachgebaut, als Ganzes genau einmal vorhanden.
// null = in Ordnung (oder kein Kapitel, weder im Kern noch im Text).
function checkBenchChapter(core: DossierCore, visible: string, isHtml: boolean): { status: VerifyStatus; lines: string[] } | null {
  const anchor = norm(isHtml ? `<section class="section" ${BENCH_CHAPTER_ANCHOR.html}` : BENCH_CHAPTER_ANCHOR.md);
  const inText = countOf(visible, anchor);
  if (core.bench === undefined) {
    return inText === 0
      ? null
      : { status: "MISMATCH", lines: ["Im Text steht ein Kapitel «Mehrlauf-Messung», das nicht im Siegel des Dossiers steht: Das Kapitel wurde nachträglich eingefügt oder das Siegel wurde verändert."] };
  }
  let checks: ReturnType<typeof dossierBenchChecks>;
  try {
    checks = dossierBenchChecks(core.bench);
  } catch {
    return { status: "NOT_VERIFIABLE", lines: ["Der gesiegelte Kern enthält die Mehrlauf-Messung in einer Form, die sich nicht lesen lässt. Nicht prüfbar."] };
  }
  const chapter = isHtml ? checks.html : checks.md;
  if (inText === 1 && countOf(visible, norm(chapter.whole)) === 1) return null;
  const deviating = chapter.parts.filter((p) => countOf(visible, norm(p.needle)) !== p.expected).map((p) => `  ${p.label}`);
  const shown = deviating.slice(0, 8);
  return {
    status: "MISMATCH",
    lines: [
      inText === 0
        ? "Das Kapitel «Mehrlauf-Messung» fehlt im Text, steht aber im Siegel des Dossiers (gelöscht oder verändert)."
        : inText > 1
          ? "Das Kapitel «Mehrlauf-Messung» steht mehrfach im Text."
          : "Das Kapitel «Mehrlauf-Messung» im Text weicht vom gesiegelten Kern ab (Zahlen, Methode oder Wortlaut wurden im Text verändert, oder es wurde Text eingefügt).",
      ...(shown.length > 0 ? ["Abweichende Stellen (Anfang des Textes, wie er laut Siegel stehen müsste):", ...shown, ...(deviating.length > shown.length ? [`  ... und ${deviating.length - shown.length} weitere`] : [])] : []),
    ],
  };
}

// ---------- --rerender: den Fliesstext aus der Report-Datei neu erzeugen und vergleichen ----------

const normalizeSpace = (text: string): string => text.replace(/\s+/g, " ").trim();

interface TextSection {
  id: string;
  title: string;
  text: string;
}

function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/\\([\\`*[\]|<>_~#!-])/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// Der Text vor dem Siegel, zerlegt in den Kopf und die Abschnitte (ihre Anker stehen nur im erzeugten Dokument, Nutzertext ist maskiert).
function splitSections(visible: string, isHtml: boolean): TextSection[] {
  const anchor = isHtml ? /<section class="section" id="([^"]*)">/g : /<a id="([^"]*)"><\/a>/g;
  const found = [...visible.matchAll(anchor)];
  const out: TextSection[] = [];
  const headEnd = found.length > 0 ? found[0]!.index : visible.length;
  out.push({ id: "kopf", title: "Kopf des Dossiers", text: visible.slice(0, headEnd) });
  found.forEach((m, i) => {
    const end = i + 1 < found.length ? found[i + 1]!.index : visible.length;
    const text = visible.slice(m.index, end);
    const title = isHtml ? text.match(/<h2>([\s\S]*?)<\/h2>/)?.[1] : text.match(/^##\s+(.+)$/m)?.[1];
    out.push({ id: m[1]!, title: title ? `Abschnitt «${stripMarkup(title)}»` : `Abschnitt ${m[1]!}`, text });
  });
  return out;
}

function excerpt(text: string, at: number): string {
  const from = Math.max(0, at - 40);
  return `${from > 0 ? "…" : ""}${stripMarkup(text.slice(from, at + 90))}${text.length > at + 90 ? "…" : ""}`;
}

function firstDifference(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

// Die Kerne ohne die Version, die das Dossier erzeugt hat (sie darf sich zwischen Erzeugen und Prüfen unterscheiden).
function coreWithoutVersion(core: DossierCore): string {
  const copy: Record<string, unknown> = { ...(core as unknown as Record<string, unknown>) };
  delete copy.renderedWith;
  return canonicalJson(mapStrings(copy, (x) => x.normalize("NFC")));
}

export const NOT_REBUILDABLE_DE =
  "Nicht neu aufbaubar: Dieses Dossier stammt aus Harness < 0.12.0 und trägt im Siegel nicht die Angaben, aus denen es sich neu erzeugen lässt (Antwort des Agenten, Hinweis auf einen angegebenen Bench-Bericht). Mit Harness 0.12.0 oder neuer erzeugte Dossiers lassen sich mit --rerender prüfen; für dieses bleibt es bei Siegel, Kopf und (mit --report) der Report-Datei.";

export const RERENDER_LIMIT_DE =
  "Das zeigt, dass der Fliesstext aus dieser Report-Datei folgt (er ist eine Funktion des Reports). Es zeigt nicht, dass die Report-Datei echt ist, und kein Dritter bestätigt es: Wer Report-Datei und Dossier zusammen ändert, kann fälschen.";

type Deviation = { title: string; at: number; inDossier: string; expected: string } | { title: string; missing: "dossier" | "rebuilt" };

// Das Dossier aus der Report-Datei (und dem Bench-Bericht) neu erzeugen, mit den Angaben aus dem Dossier selbst (Kunden- und Systemname,
// Antwort des Agenten, Lizenzstatus, gekürzt oder voll, Format), und mit der Datei vergleichen. Eine Lizenz des Prüfers braucht es nicht.
function rerenderCheck(text: string, core: DossierCore, report: ReportFile, bench: Record<string, unknown> | undefined, isHtml: boolean): { status: VerifyStatus; lines: string[] } {
  if (core.render === undefined || core.render === null || typeof core.render !== "object") {
    return { status: "PARTIAL", lines: [NOT_REBUILDABLE_DE] };
  }
  let benchCore = core.bench;
  if (bench !== undefined && core.bench !== undefined && validateBenchDocument(bench) === null) {
    benchCore = benchCoreMatching(core.bench, bench as unknown as BenchDocument, checkBenchIntegrity(bench));
  }
  const agentResponse = typeof core.render.agentResponse === "string" ? core.render.agentResponse : undefined;
  const file: ReportFile = { ...report };
  // Wie `report`: eine übergebene Antwort wird gegen den Lauf geprüft, bevor das Dossier entsteht.
  if (agentResponse !== undefined && file.report) file.claim_check = evaluateAgentClaim(agentResponse, file.report);
  const options: DossierOptions = {
    customerName: core.customer,
    systemName: core.system,
    agentResponse,
    limited: core.limited,
    ...(core.limited ? {} : { bench: benchCore }),
    benchRequested: core.render.benchRequested === true,
    rerender: { licenseStatus: core.licenseStatus },
  };
  const rebuilt = isHtml ? renderDossierHtml(file, options) : renderDossierMarkdown(file, options);
  const mark = `<!-- ${DOSSIER_SEAL_MARKER} `;
  const rebuiltSealAt = rebuilt.lastIndexOf(mark);
  const rebuiltVisible = (rebuiltSealAt === -1 ? rebuilt : rebuilt.slice(0, rebuiltSealAt)).normalize("NFC");
  const sealAt = text.lastIndexOf(mark);
  const visible = (sealAt === -1 ? text : text.slice(0, sealAt)).normalize("NFC");
  const hint =
    core.renderedWith !== VERSION
      ? [`Hinweis: Das Dossier wurde mit Harness ${core.renderedWith} erzeugt, geprüft wird mit ${VERSION}. Texte und Regeln können sich zwischen Versionen ändern; prüfe im Zweifel mit der Version, die das Dossier erzeugt hat.`]
      : [];

  const mine = splitSections(visible, isHtml);
  const theirs = splitSections(rebuiltVisible, isHtml);
  const deviating: Deviation[] = [];
  const byId = new Map(theirs.map((s) => [s.id, s] as const));
  const seen = new Set<string>();
  for (const s of mine) {
    const other = byId.get(s.id);
    seen.add(s.id);
    if (other === undefined) {
      deviating.push({ title: s.title, missing: "rebuilt" });
      continue;
    }
    const a = normalizeSpace(s.text);
    const b = normalizeSpace(other.text);
    if (a !== b) {
      const at = firstDifference(a, b);
      deviating.push({ title: s.title, at, inDossier: excerpt(a, at), expected: excerpt(b, at) });
    }
  }
  for (const s of theirs) if (!seen.has(s.id)) deviating.push({ title: s.title, missing: "dossier" });

  const rebuiltSeal = extractDossierSeal(rebuilt);
  let coreDiff: string[];
  if ("error" in rebuiltSeal) coreDiff = ["(neu erzeugter Kern nicht lesbar)"];
  else if (coreWithoutVersion(rebuiltSeal.seal.core) === coreWithoutVersion(core)) coreDiff = [];
  else {
    const a = core as unknown as Record<string, unknown>;
    const b = rebuiltSeal.seal.core as unknown as Record<string, unknown>;
    const nfc = (v: unknown): string => canonicalJson(mapStrings(v, (x) => x.normalize("NFC")));
    coreDiff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "renderedWith" && nfc(a[k]) !== nfc(b[k]));
  }

  if (deviating.length === 0 && coreDiff.length === 0) {
    const benchSource =
      core.bench === undefined ? "" : bench !== undefined ? " und dem Bench-Bericht" : " (das Kapitel «Mehrlauf-Messung» aus dem Siegel, nicht aus dem Bench-Bericht: mit --bench angeben)";
    return {
      status: "OK",
      lines: [
        `Das Dossier wurde aus der Report-Datei${benchSource} mit denselben Angaben neu erzeugt (Kunden- und Systemname, Antwort des Agenten und Lizenzstatus aus dem Dossier gelesen) und stimmt nach Normalisierung von Leerraum Abschnitt für Abschnitt überein: Damit passt auch der Fliesstext zum Report.`,
        RERENDER_LIMIT_DE,
        ...hint,
      ],
    };
  }
  const lines: string[] = ["Der Fliesstext des Dossiers weicht von dem ab, was sich aus der Report-Datei neu erzeugen lässt."];
  const first = deviating[0];
  if (first !== undefined) {
    if ("missing" in first) {
      lines.push(
        first.missing === "rebuilt"
          ? `Erste Abweichung: ${first.title} steht im Dossier, ergibt sich aber nicht aus der Report-Datei (eingefügt).`
          : `Erste Abweichung: ${first.title} fehlt im Dossier (gelöscht oder verändert).`,
      );
    } else {
      lines.push(`Erste Abweichung in ${first.title}, Zeichen ${first.at} des normalisierten Textes:`, `  im Dossier:      «${first.inDossier}»`, `  aus dem Report:  «${first.expected}»`);
    }
    if (deviating.length > 1) {
      lines.push(`Weitere abweichende Teile: ${deviating.slice(1, 7).map((d) => d.title).join("; ")}${deviating.length > 7 ? `; ... und ${deviating.length - 7} weitere` : ""}.`);
    }
  }
  if (coreDiff.length > 0) {
    lines.push(`Auch das Siegel weicht ab (Felder: ${coreDiff.join(", ")}): Das Dossier wurde mit anderen Angaben erzeugt oder stammt aus einer anderen Report-Datei oder einem anderen Bench-Bericht.`);
  }
  lines.push(...hint);
  return { status: "MISMATCH", lines };
}

export const NO_REPORT_DE =
  "Fliesstext NICHT geprüft: Der Fliesstext der Abschnitte (Management-Matrix, Schema-Gutachten, Zeitleiste, Abgleich mit der Antwort des Agenten, Prompt-Baustein, Prüfsummen-Abschnitt) ist nicht gesiegelt und lässt sich nur gegen einen Report neu aufbauen. Ohne --report <report-datei> bliebe ein geänderter Satz (zum Beispiel ein umgekehrter Prompt-Baustein oder ein eingefügter Abschnitt) unbemerkt. Mit --report wird das Dossier automatisch neu erzeugt und verglichen.";

export const NO_RERENDER_DE =
  "Fliesstext NICHT geprüft: Der Neuaufbau aus der Report-Datei wurde mit --no-rerender abgeschaltet. Ein geänderter Satz in den Abschnitten bliebe unbemerkt.";

export const BENCH_NOT_COMPARED_DE =
  "Das Kapitel «Mehrlauf-Messung» steht im Siegel, wurde aber nicht gegen den Bench-Bericht abgeglichen: Zahlen und Siegel könnten gemeinsam neu geschrieben worden sein. Mit --bench <bench-report.json> abgleichen (verify prüft den Bericht dann auch auf Widersprüche und auf seine Lauf-Dateien, wenn man ihn selbst prüft).";

export function verifyDossierContent(
  text: string,
  options: { report?: ReportFile; expect?: string; bench?: Record<string, unknown>; rerender?: boolean; noRerender?: boolean } = {},
): VerifyResult {
  const extracted = extractDossierSeal(text);
  if ("error" in extracted) {
    return {
      status: "NOT_VERIFIABLE",
      kind: "dossier",
      sha256: null,
      lines: [
        extracted.error === "missing"
          ? "Kein Prüfsummen-Siegel gefunden: Das Dossier stammt aus Harness < 0.11.1 (Siegel erst ab 0.11.1) oder das Siegel wurde entfernt. Nicht prüfbar."
          : "Das Prüfsummen-Siegel am Ende des Dossiers ist beschädigt und lässt sich nicht lesen. Nicht prüfbar.",
      ],
    };
  }
  const seal = extracted.seal;
  // Das Siegel wurde über den Kern in der Fassung gerechnet, in der er erzeugt wurde. Wurde die Datei neu gespeichert (Unicode-Normalform),
  // steht der Kern im Siegel in einer anderen Form: NFC und NFD zählen nicht als Änderung.
  let core: DossierCore | undefined;
  for (const candidate of [seal.core, mapStrings(seal.core, (x) => x.normalize("NFC")) as DossierCore, mapStrings(seal.core, (x) => x.normalize("NFD")) as DossierCore]) {
    if (sha256Hex(canonicalJson(candidate)) === seal.sha256) {
      core = candidate;
      break;
    }
  }
  const lines: string[] = [];
  if (core === undefined) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: ["Die Prüfsumme des Dossiers stimmt nicht zu seinem eingebetteten Kern: Kern (Urteil, Score, Namen, Lizenzstatus ...) oder Prüfsumme wurden nach dem Erzeugen verändert."],
    };
  }
  // Der sichtbare Kopf muss dem gesiegelten Kern entsprechen.
  const header = core.header as unknown;
  if (!header || typeof header !== "object" || !Array.isArray((header as { rows?: unknown }).rows) || !Array.isArray((header as { notes?: unknown }).notes)) {
    return { status: "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines: ["Das Siegel enthält den sichtbaren Kopf nicht (Dossier aus einer Vorabfassung von 0.11.1). Nicht prüfbar."] };
  }
  const isHtml = /<html[\s>]/i.test(text.slice(0, 2000));
  const expected = dossierHeaderChecks(core)[isHtml ? "html" : "md"];
  // Gezählt wird im sichtbaren Teil vor dem Siegel (das JSON des Siegels wiederholt Teile des Kopfes).
  const sealAt = text.lastIndexOf(`<!-- ${DOSSIER_SEAL_MARKER} `);
  const visible = norm(sealAt === -1 ? text : text.slice(0, sealAt));
  const missing = expected.filter((check) => countOf(visible, norm(check.needle)) !== 1 || (check.prefix !== undefined && countOf(visible, norm(check.prefix)) !== 1));
  if (missing.length > 0) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: [
        `Der sichtbare Kopf des Dossiers weicht vom gesiegelten Kern ab (${missing.length} von ${expected.length} Angaben fehlen, sind verändert oder doppelt: Titel, Kopfzeilen, Datum, Version, Urteil, Score oder die Hinweise unter dem Urteil wurden im Text verändert).`,
      ],
    };
  }
  const sections = checkSections(core, visible, isHtml);
  if (sections !== null) return { status: sections.status, kind: "dossier", sha256: seal.sha256, lines: sections.lines };
  const chapter = checkBenchChapter(core, visible, isHtml);
  if (chapter !== null) return { status: chapter.status, kind: "dossier", sha256: seal.sha256, lines: chapter.lines };
  if (options.expect !== undefined && options.expect.toLowerCase() !== seal.sha256) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: [`Das Dossier ist in sich stimmig, seine Prüfsumme ist aber nicht die erwartete: erwartet ${options.expect.toLowerCase()}, im Dossier ${seal.sha256}.`],
    };
  }
  if (options.bench !== undefined) {
    const compared = compareWithBench(core, options.bench);
    if (compared.status !== "OK") return { status: compared.status, kind: "dossier", sha256: seal.sha256, lines: compared.lines };
    lines.push(...compared.lines);
  }
  const source = core.reportFile;
  if (source.check !== "ok") {
    lines.push(
      source.check === "mismatch"
        ? "Das Dossier ist unverändert, wurde aber aus einer Report-Datei erzeugt, die ihre eigene Prüfsumme nicht bestand: Urteil und Score sind nicht belastbar."
        : "Das Dossier ist unverändert, wurde aber aus einer Report-Datei erzeugt, deren Prüfsumme nicht prüfbar war (fehlend oder aus Harness < 0.11.1): Das Urteil war schon beim Erzeugen ungeprüft.",
    );
    return { status: source.check === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines };
  }

  // Was geprüft ist: Siegel, Kern, Kopf, Abschnitte und (mit Kapitel) das Kapitel. Der Fliesstext nur mit Neuaufbau aus dem Report.
  const wantRerender = options.report !== undefined && (options.rerender === true || options.noRerender !== true);
  const partial: string[] = [];
  let textChecked = false;
  lines.unshift(
    core.bench !== undefined
      ? "Siegel, Kern, sichtbarer Kopf (Titel, Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil), die Überschriften aller Abschnitte und das Kapitel «Mehrlauf-Messung» (Methode und alle Zahlen) stimmen überein."
      : "Siegel, Kern, sichtbarer Kopf (Titel, Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil) und die Überschriften aller Abschnitte stimmen überein.",
  );
  if (options.report) {
    const reportCheck = checkReportIntegrity(options.report);
    if (reportCheck.status !== "ok") {
      return { status: reportCheck.status === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines: [`Die angegebene Report-Datei besteht ihre Prüfung nicht: ${reportCheck.reasonDe}`] };
    }
    if (options.report.integrity?.payloadSha256 !== source.payloadSha256) {
      return {
        status: "MISMATCH",
        kind: "dossier",
        sha256: seal.sha256,
        lines: ["Die angegebene Report-Datei ist nicht die, aus der das Dossier erzeugt wurde (ihre Prüfsumme weicht von der im Dossier festgehaltenen ab)."],
      };
    }
    lines.push("Die angegebene Report-Datei gehört zu diesem Dossier und ist unverändert.");
    if (wantRerender) {
      const result = rerenderCheck(text, core, options.report, options.bench, isHtml);
      if (result.status === "OK") {
        textChecked = true;
        lines.push(...result.lines);
      } else if (result.status === "PARTIAL") {
        partial.push(...result.lines);
      } else {
        return { status: result.status, kind: "dossier", sha256: seal.sha256, lines: [...lines, ...result.lines] };
      }
    } else {
      partial.push(NO_RERENDER_DE);
    }
  } else {
    partial.push(NO_REPORT_DE);
  }
  const benchPartial = core.bench !== undefined && options.bench === undefined;
  if (benchPartial) partial.push(BENCH_NOT_COMPARED_DE);
  lines.push("Das ist eine Prüfsumme ohne Signatur eines Dritten: Sie schützt nur, wenn ihr Wert getrennt aufbewahrt wird (--expect <sha256>).");
  if (partial.length === 0) {
    return { status: "OK", kind: "dossier", sha256: seal.sha256, lines, scope: "Fliesstext: geprüft" };
  }
  const scope = `${textChecked ? "Fliesstext: geprüft" : "Fliesstext: NICHT geprüft"}${benchPartial ? "; Mehrlauf-Kapitel nicht gegen den Bench-Bericht abgeglichen" : ""}`;
  return { status: "PARTIAL", kind: "dossier", sha256: seal.sha256, lines: [...partial, ...lines], scope };
}

// ---------- Bench-Bericht ----------

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

interface RunFilesResult {
  mismatches: string[];
  partial: string[];
  ok: string[];
}

// Die Lauf-Dateien: jede in runs[].files genannte Datei muss im Ordner runs/ neben dem Bericht liegen und zu ihrem Hash passen; aus den
// Rohverläufen (Report des Proxys, Ende-Ereignis des Verlaufs) werden gültig, Zählung, Nachsehen und erneutes Senden mit denselben Regeln
// abgeleitet wie beim Messen (src/bench/run-facts.ts) und mit den Zeilen in runs[] verglichen.
async function checkRunFiles(file: Record<string, unknown>, dir: string | undefined): Promise<RunFilesResult> {
  const result: RunFilesResult = { mismatches: [], partial: [], ok: [] };
  if (dir === undefined) {
    result.partial.push("Rohdaten nicht geprüft: Es wurde kein Ordner neben dem Bericht angegeben.");
    return result;
  }
  const runsDir = join(dir, "runs");
  const info = await stat(runsDir).catch(() => null);
  if (!info || !info.isDirectory()) {
    result.partial.push("Rohdaten nicht geprüft: Der Ordner runs/ liegt nicht neben dem Bericht. Lege den Ordner runs/ neben bench-report.json, um die Lauf-Dateien gegen ihre Hashes und die Zahlen im Bericht zu prüfen.");
    return result;
  }
  const rows = Array.isArray(file.runs) ? (file.runs as BenchRunRow[]) : [];
  const probeUsed = (file.effectProbe as { used?: unknown } | undefined)?.used === true;
  // Berichte mit Szenario-Massen tragen die Felder «erneut gesendet» (alle Szenarien) und Wartezeit-Reaktion (F2) in jedem gültigen Lauf: Fehlt eines, ist es ein Widerspruch.
  const settings = isScenarioSettings(file.scenarioSettings) ? file.scenarioSettings : undefined;
  const missing: string[] = [];
  const changed: string[] = [];
  const badPath: string[] = [];
  const derived: string[] = [];
  let present = 0;
  let derivedRuns = 0;
  const read = async (path: unknown, expected: unknown): Promise<Buffer | null> => {
    if (typeof path !== "string" || typeof expected !== "string") return null;
    if (!/^runs\/[^/\\]+$/.test(path) || path.includes("..")) {
      badPath.push(path);
      return null;
    }
    let content: Buffer;
    try {
      content = await readFile(join(dir, path));
    } catch {
      missing.push(path);
      return null;
    }
    present++;
    if (createHash("sha256").update(content).digest("hex") !== expected) {
      changed.push(path);
      return null;
    }
    return content;
  };
  for (const row of rows) {
    const jsonl = await read(row.files?.jsonl, row.files?.jsonlSha256);
    const proxy = await read(row.files?.proxyReport, row.files?.proxyReportSha256);
    if (row.valid && (row.files?.proxyReport === null || row.files?.proxyReport === undefined)) derived.push(`${row.id}: als gültig eingetragen, aber ohne Report des Proxys`);
    if (jsonl === null && proxy === null) continue;
    // Ableitung aus den Rohdaten
    let end: Record<string, unknown> | null = null;
    if (jsonl !== null) {
      const last = jsonl.toString("utf8").split("\n").filter((l) => l.trim() !== "").pop();
      try {
        const parsed: unknown = last === undefined ? null : JSON.parse(last);
        if (parsed !== null && typeof parsed === "object" && (parsed as { type?: unknown }).type === "end") end = parsed as Record<string, unknown>;
      } catch {
        end = null;
      }
      if (end === null) derived.push(`${row.id}: Der Rohverlauf endet nicht mit dem Ende-Ereignis`);
      else {
        if (end.valid !== row.valid) derived.push(`${row.id}: gültig laut Bericht ${String(row.valid)}, laut Rohverlauf ${String(end.valid)}`);
        if (row.valid) {
          const endKeys: Array<"duplicate" | "records" | "executions" | "retryBehavior" | "retryWaitedMs"> = ["duplicate", "records", "executions"];
          if (row.retryBehavior !== undefined || row.retryWaitedMs !== undefined || (settings !== undefined && row.scenario === "F2" && settingOf(settings, "F2") !== undefined)) endKeys.push("retryBehavior", "retryWaitedMs");
          for (const key of endKeys) {
            if (end[key] !== row[key]) derived.push(`${row.id}: ${key} laut Bericht ${JSON.stringify(row[key])}, laut Rohverlauf ${JSON.stringify(end[key])}`);
          }
        }
      }
    }
    if (proxy !== null) {
      let parsed: ProxyReportFile | null = null;
      try {
        const value: unknown = JSON.parse(proxy.toString("utf8"));
        parsed = value !== null && typeof value === "object" ? (value as ProxyReportFile) : null;
      } catch {
        parsed = null;
      }
      const rep = parsed?.report;
      if (parsed === null) derived.push(`${row.id}: Der Report des Proxys ist kein JSON`);
      else {
        if (rep !== undefined && parsed.integrity !== undefined && checkReportIntegrity(parsed).status === "mismatch") {
          derived.push(`${row.id}: Der Report des Proxys besteht seine eigene Prüfsumme nicht`);
        }
        if (row.valid) {
          if (rep === undefined) derived.push(`${row.id}: als gültig eingetragen, aber der Report des Proxys enthält keinen Bericht`);
          else if (rep.coverage?.scenarioTriggered === false || rep.totalCalls === 0) derived.push(`${row.id}: als gültig eingetragen, aber das Szenario wurde nie ausgelöst (Report des Proxys)`);
          else {
            derivedRuns++;
            const facts = deriveRunFacts(parsed, rep, probeUsed);
            const compare: Array<[string, unknown, unknown]> = [
              ["toolCalls", row.toolCalls, facts.toolCalls],
              ["lookedUp", row.lookedUp, facts.lookedUp],
              ["duplicate", row.duplicate, facts.duplicate],
              ["executions", row.executions, facts.executions],
              ["records", row.records, facts.records],
              ["truthBasis", row.truthBasis, facts.truthBasis],
              ["probeConclusion", row.probeConclusion, facts.probeConclusion],
              ["retryAfterViolations", row.retryAfterViolations, facts.retryAfterViolations],
              ["verdict", row.verdict, facts.verdict],
            ];
            if (row.resent !== undefined || (settings !== undefined && settingOf(settings, row.scenario) !== undefined)) compare.push(["resent", row.resent, facts.resent]);
            if (row.retryBehavior !== undefined || row.retryWaitedMs !== undefined || (settings !== undefined && row.scenario === "F2" && settingOf(settings, "F2") !== undefined)) {
              compare.push(["retryBehavior", row.retryBehavior, facts.retryBehavior], ["retryWaitedMs", row.retryWaitedMs, facts.retryWaitedMs]);
            }
            if (row.probeReason !== undefined) compare.push(["probeReason", row.probeReason, facts.probeReason]);
            for (const [name, stored, fromRaw] of compare) {
              if (JSON.stringify(stored) !== JSON.stringify(fromRaw)) derived.push(`${row.id}: ${name} im Bericht ${JSON.stringify(stored)}, aus dem Report des Proxys abgeleitet ${JSON.stringify(fromRaw)}`);
            }
          }
        } else if (row.invalidAfterWrite !== undefined && row.invalidAfterWrite !== null && row.invalidAfterWrite !== writeExecutedOf(rep)) {
          derived.push(`${row.id}: ungültig nach ausgeführtem Schreibvorgang laut Bericht ${String(row.invalidAfterWrite)}, laut Report des Proxys ${String(writeExecutedOf(rep))}`);
        }
      }
    }
  }
  if (badPath.length > 0) result.mismatches.push(`Unzulässige Pfade in runs[].files (erlaubt ist nur runs/<Dateiname>): ${[...new Set(badPath)].slice(0, 5).join(", ")}.`);
  if (missing.length > 0) {
    result.mismatches.push(`${missing.length} ${plural(missing.length, "Lauf-Datei fehlt", "Lauf-Dateien fehlen")} im Ordner runs/: ${missing.slice(0, 8).join(", ")}${missing.length > 8 ? `, ... und ${missing.length - 8} weitere` : ""}.`);
  }
  if (changed.length > 0) {
    result.mismatches.push(`Lauf-Dateien neben dem Bericht stimmen nicht mit den Hashes im Bericht überein: ${changed.slice(0, 8).join(", ")}${changed.length > 8 ? `, ... und ${changed.length - 8} weitere` : ""}.`);
  }
  if (derived.length > 0) {
    result.mismatches.push(`Die Zeilen in runs[] widersprechen den Rohdaten in runs/ (${derived.length} ${plural(derived.length, "Abweichung", "Abweichungen")}):`, ...derived.slice(0, 8).map((d) => `  ${d}`), ...(derived.length > 8 ? [`  ... und ${derived.length - 8} weitere`] : []));
  }
  if (result.mismatches.length === 0) {
    result.ok.push(
      `${present} Lauf-Dateien im Ordner runs/ sind vorhanden und stimmen mit den Hashes im Bericht überein; aus den Rohdaten abgeleitet (gültig, Tool-Aufrufe, nachgesehen, erneut gesendet, Duplikat, bei F2 die Reaktion auf die Wartezeit) stimmen ${derivedRuns} gültige ${plural(derivedRuns, "Lauf", "Läufe")} mit dem Bericht überein.`,
    );
  }
  return result;
}

// Bench-Bericht: das Siegel (Format 2), die Widerspruchsfreiheit (Aggregate und Vergleich aus runs[] neu gerechnet), die Lauf-Dateien in runs/
// und der Lesetext bench-report.md (über seinen Hash im Siegel).
export async function verifyBenchReportContent(file: Record<string, unknown>, options: { expect?: string; dir?: string; markdown?: string } = {}): Promise<VerifyResult> {
  const check = checkBenchIntegrity(file);
  const lines: string[] = [check.reasonDe];
  let status = statusOfCheck(check);
  const sha = (file.integrity as { payloadSha256?: string } | undefined)?.payloadSha256 ?? null;
  if (status === "OK" && options.expect !== undefined && options.expect.toLowerCase() !== sha) {
    status = "MISMATCH";
    lines.unshift(
      `Der Bericht stimmt zwar mit seiner eigenen Prüfsumme überein, die Prüfsumme ist aber nicht die erwartete: erwartet ${options.expect.toLowerCase()}, in der Datei ${sha ?? "—"}. Datei und Prüfsumme wurden gemeinsam ausgetauscht oder die falsche Datei liegt vor.`,
    );
  }
  if (status !== "OK") return { status, kind: "bench", sha256: sha, lines };
  const version = typeof file.claimCheckVersion === "number" && Number.isFinite(file.claimCheckVersion) ? file.claimCheckVersion : null;
  if (claimCheckOlder(version, CLAIM_CHECK_VERSION)) lines.push(CLAIM_CHECK_OLDER_DE);

  // Widerspruchsfreiheit: Aggregate, Vergleich und Zählweise aus runs[] neu rechnen.
  const invalid = validateBenchDocument(file);
  if (invalid !== null) {
    return { status: "MISMATCH", kind: "bench", sha256: sha, lines: [...lines, `Der Bericht hat nicht die Form eines Bench-Berichts (auch nicht mit gültigem Siegel): ${invalid}`] };
  }
  const contradictions = benchConsistencyProblems(file);
  if (contradictions.length > 0) {
    return {
      status: "MISMATCH",
      kind: "bench",
      sha256: sha,
      lines: [...lines, "Der Bericht widerspricht sich selbst: Aggregate, Vergleich oder Zählweise passen nicht zu den Läufen in runs[]. Das fällt auch auf, wenn das Siegel neu gerechnet wurde:", ...contradictions.map((c) => `  ${c}`)],
    };
  }
  const runCount = Array.isArray(file.runs) ? file.runs.length : 0;
  lines.push(`Aggregate, Vergleich (Anzahlen, Wilson-Intervalle, Newcombe-Differenz, Texte) und Zählweise stimmen mit einer Neuberechnung aus den ${runCount} Läufen in runs[] überein.`);

  const mismatches: string[] = [];
  const partial: string[] = [];
  const runFiles = await checkRunFiles(file, options.dir);
  mismatches.push(...runFiles.mismatches);
  partial.push(...runFiles.partial);
  lines.push(...runFiles.ok);

  // Lesetext bench-report.md: über seinen Hash im Siegel mitgesiegelt.
  const md = file.markdown as { file?: unknown; sha256?: unknown } | undefined;
  if (md === undefined || md === null || typeof md !== "object" || typeof md.sha256 !== "string") {
    partial.push("Der Lesetext bench-report.md ist nicht geprüft: Der Bericht trägt seinen Hash nicht (Bericht aus einer Fassung vor der Mitsiegelung des Lesetextes).");
  } else {
    let text: string | null = options.markdown ?? null;
    if (text === null && options.dir !== undefined) {
      const name = typeof md.file === "string" && /^[^/\\]+$/.test(md.file) ? md.file : BENCH_MARKDOWN_NAME;
      const read = await readText(join(options.dir, name));
      text = "text" in read ? read.text : null;
      if (text === null) partial.push(`Der Lesetext ${name} liegt nicht neben dem Bericht: nicht geprüft.`);
    } else if (text === null) {
      partial.push("Der Lesetext bench-report.md ist nicht geprüft: Es wurde kein Ordner neben dem Bericht angegeben.");
    }
    if (text !== null) {
      if (markdownSha256(text) !== md.sha256) {
        mismatches.push("Der Lesetext bench-report.md stimmt nicht mit dem Hash im Siegel des Berichts überein: Er wurde nach dem Schreiben verändert (oder gehört zu einem anderen Bericht).");
      } else lines.push("Der Lesetext bench-report.md stimmt mit dem Hash im Siegel des Berichts überein.");
    }
  }
  if (mismatches.length > 0) return { status: "MISMATCH", kind: "bench", sha256: sha, lines: [...lines, ...mismatches] };
  if (partial.length > 0) return { status: "PARTIAL", kind: "bench", sha256: sha, lines: [...partial, ...lines], scope: runFiles.partial.length > 0 ? "Rohdaten: NICHT geprüft" : "Siegel, Aggregate und Rohdaten geprüft; Lesetext nicht geprüft" };
  return { status: "OK", kind: "bench", sha256: sha, lines, scope: "Siegel, Aggregate, Rohdaten und Lesetext geprüft" };
}

// ---------- Lesetext des Bench-Berichts ----------

const BENCH_MARKDOWN_HEAD = "# Mehrlauf-Messung (bench)";

function looksLikeBenchMarkdown(text: string): boolean {
  return text.startsWith(BENCH_MARKDOWN_HEAD);
}

async function verifyBenchMarkdownFile(text: string, file: string, expect?: string): Promise<VerifyResult> {
  const dir = dirname(file);
  const jsonPath = join(dir, "bench-report.json");
  const read = await readText(jsonPath);
  if (!("text" in read)) {
    return {
      status: "NOT_VERIFIABLE",
      kind: "bench-markdown",
      sha256: null,
      lines: [`Der Lesetext lässt sich nur gegen den Bericht prüfen: bench-report.json fehlt im selben Ordner (${dir}). Lege beide Dateien nebeneinander oder prüfe bench-report.json direkt.`],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    parsed = null;
  }
  if (!looksLikeBenchReport(parsed)) {
    return { status: "NOT_VERIFIABLE", kind: "bench-markdown", sha256: null, lines: ["bench-report.json im selben Ordner ist kein Bench-Bericht: Der Lesetext lässt sich nicht gegen ihn prüfen."] };
  }
  const report = parsed as Record<string, unknown>;
  const md = report.markdown as { sha256?: unknown } | undefined;
  if (md === undefined || md === null || typeof md.sha256 !== "string") {
    return {
      status: "NOT_VERIFIABLE",
      kind: "bench-markdown",
      sha256: null,
      lines: ["Der Bench-Bericht im selben Ordner trägt den Hash des Lesetextes nicht (Bericht aus einer Fassung vor der Mitsiegelung des Lesetextes): Der Text lässt sich nicht gegen den Bericht prüfen. Prüfe bench-report.json, das den Text nicht deckt."],
    };
  }
  const result = await verifyBenchReportContent(report, { expect, dir, markdown: text });
  return { ...result, kind: "bench-markdown", lines: [`Lesetext gegen den Bericht ${jsonPath} geprüft.`, ...result.lines] };
}

// ---------- Datei lesen ----------

/** Die Kodierung der Datei: UTF-8, UTF-16 mit Byte-Order-Marke oder UTF-16 ohne Marke (erkennbar an den Nullbytes); sonst null. */
export function decodeText(bytes: Buffer): string | null {
  const utf16 = (data: Buffer, bigEndian: boolean): string | null => {
    if (data.length % 2 !== 0) return null;
    const copy = Buffer.from(data);
    if (bigEndian) copy.swap16();
    return copy.toString("utf16le");
  };
  let text: string | null;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) text = utf16(bytes.subarray(2), false);
  else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) text = utf16(bytes.subarray(2), true);
  else {
    const sample = bytes.subarray(0, Math.min(bytes.length, 2000));
    let evenZero = 0;
    let oddZero = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] === 0) (i % 2 === 0 ? evenZero++ : oddZero++);
    const half = Math.floor(sample.length / 2);
    if (half > 0 && oddZero / half > 0.3 && oddZero > evenZero) text = utf16(bytes, false);
    else if (half > 0 && evenZero / half > 0.3 && evenZero > oddZero) text = utf16(bytes, true);
    else {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        return null;
      }
    }
  }
  return text === null ? null : text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

export const NOT_UTF8_DE = "nicht prüfbar: Datei ist nicht UTF-8, speichere das Dossier als UTF-8 (UTF-16 mit Byte-Order-Marke wird gelesen) und prüfe es erneut. Das ist kein Hinweis auf eine Änderung des Inhalts.";

async function readText(path: string): Promise<{ text: string } | { error: string } | { notUtf8: true }> {
  const info = await stat(path).catch(() => null);
  if (info?.isDirectory()) return { error: `${path} ist ein Ordner, keine Datei. Gib den Bericht oder das Dossier als Datei an.` };
  if (!info || !info.isFile()) return { error: `Datei nicht gefunden: ${path}` };
  if (info.size > MAX_BYTES) return { error: `Datei zu gross (${info.size} Byte, höchstens ${MAX_BYTES}): ${path}` };
  // Editoren und Mail-Programme ändern Zeilenenden (Windows: CRLF), setzen eine Byte-Order-Marke oder speichern als UTF-16. Das ist keine
  // Änderung des Inhalts und darf nicht als Manipulation gelten (Falschalarm).
  const text = decodeText(await readFile(path));
  return text === null ? { notUtf8: true } : { text };
}

function looksLikeReportFile(value: unknown): value is ReportFile {
  return value !== null && typeof value === "object" && !Array.isArray(value) && ("harnessVersion" in value || "report" in value || "integrity" in value);
}

export async function runVerifyMode(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  let file: string | undefined;
  let reportPath: string | undefined;
  let benchPath: string | undefined;
  let expect: string | undefined;
  let rerender = false;
  let noRerender = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--rerender") {
      rerender = true;
      continue;
    }
    if (token === "--no-rerender") {
      noRerender = true;
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    if (name === "--report" || name === "--expect" || name === "--bench") {
      const v = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : argv[++i];
      if (v === undefined || v.trim() === "" || v.startsWith("--")) {
        process.stderr.write(`Error: ${name} needs a value.\n${USAGE}`);
        return 1;
      }
      if (name === "--report") reportPath = v;
      else if (name === "--bench") benchPath = v;
      else {
        if (!/^[0-9a-fA-F]{64}$/.test(v.trim())) {
          process.stderr.write(`Error: --expect needs a SHA-256 (64 hex characters).\n${USAGE}`);
          return 1;
        }
        expect = v.trim();
      }
    } else if (token.startsWith("--")) {
      process.stderr.write(`Error: unknown option ${name}\n${USAGE}`);
      return 1;
    } else if (file === undefined) {
      file = token;
    } else {
      process.stderr.write(`Error: unexpected argument ${token}\n${USAGE}`);
      return 1;
    }
  }
  if (file === undefined) {
    process.stderr.write(`Error: verify needs a dossier or report file.\n${USAGE}`);
    return 1;
  }
  if (rerender && noRerender) {
    process.stderr.write(`Error: --rerender and --no-rerender exclude each other.\n${USAGE}`);
    return 1;
  }
  if ((rerender || noRerender) && reportPath === undefined) {
    process.stderr.write(`Error: ${rerender ? "--rerender" : "--no-rerender"} needs --report <report-file>: the dossier is rebuilt from the report file.\n${USAGE}`);
    return 1;
  }
  const read = await readText(file);
  if ("error" in read) {
    process.stderr.write(`Error: ${read.error}\n`);
    return 1;
  }
  if ("notUtf8" in read) return printResult({ status: "NOT_VERIFIABLE", kind: "unknown", sha256: null, lines: [NOT_UTF8_DE] }, file);
  let reportFile: ReportFile | undefined;
  if (reportPath !== undefined) {
    const r = await readText(reportPath);
    if ("error" in r) {
      process.stderr.write(`Error: ${r.error}\n`);
      return 1;
    }
    if ("notUtf8" in r) return printResult({ status: "NOT_VERIFIABLE", kind: "unknown", sha256: null, lines: [`${reportPath}: ${NOT_UTF8_DE}`] }, reportPath);
    try {
      const parsed: unknown = JSON.parse(r.text);
      if (!looksLikeReportFile(parsed)) throw new Error("not a report");
      reportFile = parsed;
    } catch {
      process.stderr.write(`Error: ${reportPath} is not a report file written by the proxy (--report-file).\n`);
      return 1;
    }
  }

  let benchFile: Record<string, unknown> | undefined;
  if (benchPath !== undefined) {
    const b = await readText(benchPath);
    if ("error" in b) {
      process.stderr.write(`Error: ${b.error}\n`);
      return 1;
    }
    if ("notUtf8" in b) return printResult({ status: "NOT_VERIFIABLE", kind: "unknown", sha256: null, lines: [`${benchPath}: ${NOT_UTF8_DE}`] }, benchPath);
    try {
      const parsedBench: unknown = JSON.parse(b.text);
      if (!looksLikeBenchReport(parsedBench)) throw new Error("not a bench report");
      benchFile = parsedBench as Record<string, unknown>;
    } catch {
      process.stderr.write(`Error: ${benchPath} is not a bench report (bench-report.json written by the bench command).\n`);
      return 1;
    }
  }
  let result: VerifyResult;
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    if (looksLikeBenchReport(parsed)) {
      if (reportFile !== undefined || benchFile !== undefined || rerender || noRerender) {
        process.stderr.write("Error: --report, --bench and --rerender only apply when verifying a dossier.\n");
        return 1;
      }
      return printResult(await verifyBenchReportContent(parsed as Record<string, unknown>, { expect, dir: dirname(file) }), file);
    }
    if (!looksLikeReportFile(parsed)) {
      process.stderr.write(`Error: ${file} is JSON, but neither a report written by the proxy (--report-file) nor a bench report (bench-report.json).\n`);
      return 1;
    }
    if (reportFile !== undefined || benchFile !== undefined || rerender || noRerender) {
      process.stderr.write("Error: --report, --bench and --rerender only apply when verifying a dossier.\n");
      return 1;
    }
    result = verifyReportFileContent(parsed, expect);
  } else if (looksLikeBenchMarkdown(read.text)) {
    if (reportFile !== undefined || benchFile !== undefined || rerender || noRerender) {
      process.stderr.write("Error: --report, --bench and --rerender only apply when verifying a dossier.\n");
      return 1;
    }
    result = await verifyBenchMarkdownFile(read.text, file, expect);
  } else {
    result = verifyDossierContent(read.text, { report: reportFile, expect, bench: benchFile, rerender, noRerender });
  }

  return printResult(result, file);
}

function printResult(result: VerifyResult, file: string): number {
  const label = result.status === "NOT_VERIFIABLE" ? "NICHT PRÜFBAR" : result.status === "PARTIAL" ? "TEILWEISE" : result.status;
  const what =
    result.kind === "report" ? "Report-Datei" : result.kind === "bench" ? "Bench-Bericht" : result.kind === "bench-markdown" ? "Lesetext des Bench-Berichts" : result.kind === "unknown" ? "Datei" : "Dossier";
  const scope = result.scope !== undefined && (result.status === "OK" || result.status === "PARTIAL") ? ` (${result.scope})` : "";
  process.stdout.write(`${label}  ${what} ${file}${scope}\n`);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (result.sha256) process.stdout.write(`Prüfsumme (SHA-256): ${result.sha256}\n`);
  return result.status === "OK" ? 0 : result.status === "PARTIAL" ? 2 : 1;
}
