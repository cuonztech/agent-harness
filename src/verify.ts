// `verify <dossier|report>`: rechnet die Prüfsumme einer Report-Datei oder eines Dossiers neu und meldet
// OK oder MISMATCH mit dem Grund. Exit-Code 0 nur bei OK, sonst 1. Es bleibt eine Prüfsumme ohne Signatur
// eines Dritten: Wer Datei und Prüfsumme zusammen ändert, kann fälschen; der Wert schützt nur, wenn er
// getrennt von der Datei aufbewahrt wird (dafür gibt es `--expect <sha256>`).
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DOSSIER_SEAL_MARKER, canonicalJson, checkReportIntegrity, extractDossierSeal, sha256Hex, type DossierCore, type IntegrityCheck } from "./core/artifact-integrity.js";
import { BENCH_CHAPTER_ANCHOR, dossierBenchChecks, dossierHeaderChecks, renderDossierHtml, renderDossierMarkdown, type DossierOptions } from "./dossier-report.js";
import { evaluateAgentClaim } from "./core/claim-check.js";
import { VERSION } from "./version.js";
import { CLAIM_CHECK_OLDER_DE, benchCoreOf, claimCheckOlder, diffBenchCores, validateBenchDocument } from "./dossier-bench.js";
import { CLAIM_CHECK_VERSION } from "./core/claim-check.js";
import type { ReportFile } from "./plain-report.js";
import { checkBenchIntegrity, looksLikeBenchReport, type BenchDocument, type BenchRunRow } from "./bench/report.js";

const MAX_BYTES = 64 * 1024 * 1024;

function countOf(text: string, part: string): number {
  if (part === "") return 0;
  let n = 0;
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n++;
  return n;
}

const USAGE = "Usage: verify <dossier|report-file|bench-report.json> [--report <report-file>] [--bench <bench-report.json>] [--rerender] [--expect <sha256>]\n";

const HELP =
  `${USAGE}\n` +
  "Rechnet die Prüfsumme einer Report-Datei (--report-file des Proxys), eines Dossiers (report --dossier) oder eines\n" +
  "Bench-Berichts (bench-report.json der Mehrlauf-Messung bench) neu\n" +
  "und gibt OK oder MISMATCH mit dem Grund aus. Exit-Code 0 bei OK, sonst 1.\n" +
  "  --report <file>   bei einem Dossier zusätzlich die Report-Datei prüfen, aus der es erzeugt wurde, und beide abgleichen\n" +
  "  --bench <file>    bei einem Dossier mit Kapitel «Mehrlauf-Messung» zusätzlich den Bench-Bericht (bench-report.json) prüfen und\n" +
  "                    abgleichen, dass die Zahlen und die Methode im Dossier zu ihm passen (MISMATCH mit Grund bei jeder Abweichung)\n" +
  "  --rerender        (nur bei einem Dossier, braucht --report) das Dossier aus der Report-Datei (und dem Bench-Bericht) mit denselben\n" +
  "                    Angaben neu erzeugen und mit der Datei vergleichen (Leerraum zählt nicht): Damit ist auch der Fliesstext der\n" +
  "                    Abschnitte geprüft. Kunden- und Systemname, Format, Antwort des Agenten und Lizenzstatus liest der Befehl aus dem\n" +
  "                    Dossier selbst; eine Lizenz braucht die Prüfung nicht. Bei Abweichung MISMATCH mit der ersten abweichenden Stelle.\n" +
  "                    Das zeigt, dass der Fliesstext aus dieser Report-Datei folgt; es zeigt nicht, dass die Report-Datei echt ist, und\n" +
  "                    kein Dritter bestätigt es (wer Report-Datei und Dossier zusammen ändert, kann fälschen). Dossiers aus\n" +
  "                    Harness < 0.12.0 sind nicht neu aufbaubar.\n" +
  "  --expect <sha256> die getrennt aufbewahrte Prüfsumme (Report-Datei: payloadSha256; Dossier: Prüfsumme des Dossiers);\n" +
  "                    stimmt sie nicht mit der Datei überein, ist das ein MISMATCH\n\n" +
  "Es ist eine Prüfsumme ohne Signatur eines Dritten und kein Zertifikat. Wer Datei und Prüfsumme zusammen ändert, kann\n" +
  "fälschen. Sie schützt nur, wenn der Wert getrennt von der Datei aufbewahrt wird.\n";

export type VerifyStatus = "OK" | "MISMATCH" | "NOT_VERIFIABLE";

export interface VerifyResult {
  status: VerifyStatus;
  kind: "report" | "dossier" | "bench" | "unknown";
  // Die Prüfsumme, die die Datei trägt (Report: payloadSha256, Dossier: Prüfsumme des Kerns).
  sha256: string | null;
  lines: string[];
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
  const diffs = diffBenchCores(core.bench, benchCoreOf(benchFile as unknown as BenchDocument, check));
  if (diffs.length > 0) {
    return { status: "MISMATCH", lines: ["Die Zahlen oder die Methode im Kapitel «Mehrlauf-Messung» des Dossiers passen nicht zum angegebenen Bench-Bericht:", ...diffs.map((d) => `  ${d}`)] };
  }
  const sha = (benchFile.integrity as { payloadSha256?: string } | undefined)?.payloadSha256 ?? "—";
  return { status: "OK", lines: [`Die Zahlen und die Methode im Kapitel «Mehrlauf-Messung» stimmen mit dem angegebenen Bench-Bericht überein (Prüfsumme des Berichts ${sha}).`] };
}

// Das Kapitel «Mehrlauf-Messung» im sichtbaren Text: aus dem gesiegelten Kern nachgebaut, als Ganzes genau einmal vorhanden.
// null = in Ordnung (oder kein Kapitel, weder im Kern noch im Text).
function checkBenchChapter(core: DossierCore, visible: string, isHtml: boolean): { status: VerifyStatus; lines: string[] } | null {
  const anchor = isHtml ? `<section class="section" ${BENCH_CHAPTER_ANCHOR.html}` : BENCH_CHAPTER_ANCHOR.md;
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
  if (inText === 1 && countOf(visible, chapter.whole) === 1) return null;
  const deviating = chapter.parts.filter((p) => countOf(visible, p.needle) !== p.expected).map((p) => `  ${p.label}`);
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
  return canonicalJson(copy);
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
    return { status: "NOT_VERIFIABLE", lines: [NOT_REBUILDABLE_DE] };
  }
  let benchCore = core.bench;
  if (bench !== undefined && core.bench !== undefined && validateBenchDocument(bench) === null) {
    benchCore = benchCoreOf(bench as unknown as BenchDocument, checkBenchIntegrity(bench));
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
  const rebuiltVisible = rebuiltSealAt === -1 ? rebuilt : rebuilt.slice(0, rebuiltSealAt);
  const sealAt = text.lastIndexOf(mark);
  const visible = sealAt === -1 ? text : text.slice(0, sealAt);
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
    coreDiff = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "renderedWith" && canonicalJson(a[k]) !== canonicalJson(b[k]));
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

export function verifyDossierContent(text: string, options: { report?: ReportFile; expect?: string; bench?: Record<string, unknown>; rerender?: boolean } = {}): VerifyResult {
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
  const { seal } = extracted;
  const recomputed = sha256Hex(canonicalJson(seal.core));
  const lines: string[] = [];
  if (recomputed !== seal.sha256) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: ["Die Prüfsumme des Dossiers stimmt nicht zu seinem eingebetteten Kern: Kern (Urteil, Score, Namen, Lizenzstatus ...) oder Prüfsumme wurden nach dem Erzeugen verändert."],
    };
  }
  // Der sichtbare Kopf muss dem gesiegelten Kern entsprechen.
  const header = seal.core.header as unknown;
  if (!header || typeof header !== "object" || !Array.isArray((header as { rows?: unknown }).rows) || !Array.isArray((header as { notes?: unknown }).notes)) {
    return { status: "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines: ["Das Siegel enthält den sichtbaren Kopf nicht (Dossier aus einer Vorabfassung von 0.11.1). Nicht prüfbar."] };
  }
  const isHtml = /<html[\s>]/i.test(text.slice(0, 2000));
  const expected = dossierHeaderChecks(seal.core)[isHtml ? "html" : "md"];
  // Gezählt wird im sichtbaren Teil vor dem Siegel (das JSON des Siegels wiederholt Teile des Kopfes).
  const sealAt = text.lastIndexOf(`<!-- ${DOSSIER_SEAL_MARKER} `);
  const visible = sealAt === -1 ? text : text.slice(0, sealAt);
  const missing = expected.filter((check) => countOf(visible, check.needle) !== 1 || (check.prefix !== undefined && countOf(visible, check.prefix) !== 1));
  if (missing.length > 0) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: [
        `Der sichtbare Kopf des Dossiers weicht vom gesiegelten Kern ab (${missing.length} von ${expected.length} Angaben fehlen, sind verändert oder doppelt: Kopfzeilen, Datum, Version, Urteil, Score oder die Hinweise unter dem Urteil wurden im Text verändert).`,
      ],
    };
  }
  const chapter = checkBenchChapter(seal.core, visible, isHtml);
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
    const compared = compareWithBench(seal.core, options.bench);
    if (compared.status !== "OK") return { status: compared.status, kind: "dossier", sha256: seal.sha256, lines: compared.lines };
    lines.push(...compared.lines);
  }
  const source = seal.core.reportFile;
  if (source.check !== "ok") {
    lines.push(
      source.check === "mismatch"
        ? "Das Dossier ist unverändert, wurde aber aus einer Report-Datei erzeugt, die ihre eigene Prüfsumme nicht bestand: Urteil und Score sind nicht belastbar."
        : "Das Dossier ist unverändert, wurde aber aus einer Report-Datei erzeugt, deren Prüfsumme nicht prüfbar war (fehlend oder aus Harness < 0.11.1): Das Urteil war schon beim Erzeugen ungeprüft.",
    );
    return { status: source.check === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines };
  }
  const rerender = options.rerender === true;
  if (seal.core.bench !== undefined) {
    lines.unshift(
      rerender
        ? "Siegel, Kern, sichtbarer Kopf (Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil) und das Kapitel «Mehrlauf-Messung» (Methode und alle Zahlen) stimmen überein."
        : "Siegel, Kern, sichtbarer Kopf (Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil) und das Kapitel «Mehrlauf-Messung» (Methode und alle Zahlen) stimmen überein. Der Fliesstext der übrigen Abschnitte ist nicht gesiegelt und wurde nicht geprüft.",
    );
    if (options.bench === undefined && !rerender) lines.push("Das Kapitel «Mehrlauf-Messung» wurde nicht gegen den Bench-Bericht abgeglichen; mit --bench <bench-report.json> abgleichen.");
  } else {
    lines.push(
      rerender
        ? "Siegel, Kern und sichtbarer Kopf (Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil) stimmen überein."
        : "Siegel, Kern und sichtbarer Kopf (Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil) stimmen überein. Der Fliesstext der Abschnitte 1 bis 6 ist nicht gesiegelt und wurde nicht geprüft.",
    );
  }
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
    if (rerender) {
      const result = rerenderCheck(text, seal.core, options.report, options.bench, isHtml);
      if (result.status !== "OK") return { status: result.status, kind: "dossier", sha256: seal.sha256, lines: [...lines, "Die angegebene Report-Datei gehört zu diesem Dossier und ist unverändert.", ...result.lines] };
      lines.push("Die angegebene Report-Datei gehört zu diesem Dossier und ist unverändert.", ...result.lines);
    } else {
      lines.push("Die angegebene Report-Datei gehört zu diesem Dossier und ist unverändert. Der Fliesstext des Dossiers wurde dabei nicht gegen die Report-Datei abgeglichen.");
    }
  } else {
    lines.push("Die Report-Datei wurde nicht mitgeprüft; mit --report <datei> abgleichen (und mit --rerender den Fliesstext gegen sie prüfen).");
  }
  lines.push("Das ist eine Prüfsumme ohne Signatur eines Dritten: Sie schützt nur, wenn ihr Wert getrennt aufbewahrt wird (--expect <sha256>).");
  return { status: "OK", kind: "dossier", sha256: seal.sha256, lines };
}

// Bench-Bericht: das Siegel (Format 2) und, wenn der Ordner runs/ neben der Datei liegt, die Lauf-Dateien, deren Hash im Bericht steht.
export async function verifyBenchReportContent(file: Record<string, unknown>, options: { expect?: string; dir?: string } = {}): Promise<VerifyResult> {
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
  if (status === "OK") {
    const version = typeof file.claimCheckVersion === "number" && Number.isFinite(file.claimCheckVersion) ? file.claimCheckVersion : null;
    if (claimCheckOlder(version, CLAIM_CHECK_VERSION)) lines.push(CLAIM_CHECK_OLDER_DE);
  }
  if (status === "OK" && options.dir !== undefined && Array.isArray(file.runs)) {
    let checked = 0;
    const changed: string[] = [];
    for (const row of file.runs as BenchRunRow[]) {
      const pairs: Array<[unknown, unknown]> = [
        [row.files?.jsonl, row.files?.jsonlSha256],
        [row.files?.proxyReport, row.files?.proxyReportSha256],
      ];
      for (const [path, expected] of pairs) {
        if (typeof path !== "string" || typeof expected !== "string" || path.includes("..")) continue;
        let content: Buffer;
        try {
          content = await readFile(join(options.dir, path));
        } catch {
          continue;
        }
        checked++;
        if (createHash("sha256").update(content).digest("hex") !== expected) changed.push(path);
      }
    }
    if (changed.length > 0) {
      status = "MISMATCH";
      lines.push(`Lauf-Dateien neben dem Bericht stimmen nicht mit den Hashes im Bericht überein: ${changed.join(", ")}.`);
    } else if (checked > 0) {
      lines.push(`${checked} Lauf-Dateien im Ordner runs/ neben dem Bericht stimmen mit den Hashes im Bericht überein.`);
    } else {
      lines.push("Der Ordner runs/ liegt nicht neben dem Bericht: Die Lauf-Dateien wurden nicht geprüft.");
    }
  }
  return { status, kind: "bench", sha256: sha, lines };
}

async function readText(path: string): Promise<{ text: string } | { error: string }> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return { error: `Datei nicht gefunden: ${path}` };
  if (info.size > MAX_BYTES) return { error: `Datei zu gross (${info.size} Byte, höchstens ${MAX_BYTES}): ${path}` };
  // Editoren und Mail-Programme ändern Zeilenenden (Windows: CRLF) und setzen eine Byte-Order-Marke. Das ist keine
  // Änderung des Inhalts und darf nicht als Manipulation gelten (Falschalarm).
  return { text: (await readFile(path, "utf8")).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n") };
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
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--rerender") {
      rerender = true;
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
  if (rerender && reportPath === undefined) {
    process.stderr.write(`Error: --rerender needs --report <report-file>: the dossier is rebuilt from the report file.\n${USAGE}`);
    return 1;
  }
  const read = await readText(file);
  if ("error" in read) {
    process.stderr.write(`Error: ${read.error}\n`);
    return 1;
  }
  let reportFile: ReportFile | undefined;
  if (reportPath !== undefined) {
    const r = await readText(reportPath);
    if ("error" in r) {
      process.stderr.write(`Error: ${r.error}\n`);
      return 1;
    }
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
      if (reportFile !== undefined || benchFile !== undefined || rerender) {
        process.stderr.write("Error: --report, --bench and --rerender only apply when verifying a dossier.\n");
        return 1;
      }
      return printResult(await verifyBenchReportContent(parsed as Record<string, unknown>, { expect, dir: dirname(file) }), file);
    }
    if (!looksLikeReportFile(parsed)) {
      process.stderr.write(`Error: ${file} is JSON, but neither a report written by the proxy (--report-file) nor a bench report (bench-report.json).\n`);
      return 1;
    }
    if (reportFile !== undefined || benchFile !== undefined || rerender) {
      process.stderr.write("Error: --report, --bench and --rerender only apply when verifying a dossier.\n");
      return 1;
    }
    result = verifyReportFileContent(parsed, expect);
  } else {
    result = verifyDossierContent(read.text, { report: reportFile, expect, bench: benchFile, rerender });
  }

  return printResult(result, file);
}

function printResult(result: VerifyResult, file: string): number {
  const label = result.status === "NOT_VERIFIABLE" ? "NICHT PRÜFBAR" : result.status;
  const what = result.kind === "report" ? "Report-Datei" : result.kind === "bench" ? "Bench-Bericht" : "Dossier";
  process.stdout.write(`${label}  ${what} ${file}\n`);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (result.sha256) process.stdout.write(`Prüfsumme (SHA-256): ${result.sha256}\n`);
  return result.status === "OK" ? 0 : 1;
}
