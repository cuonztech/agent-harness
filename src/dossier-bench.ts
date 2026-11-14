// Dossier-Kapitel «Mehrlauf-Messung» (Pro): aus dem Bench-Bericht (bench-report.json, Befehl `bench`) wird ein Kern aus Zahlen
// und Methode gebildet, der ins Siegel des Dossiers geht, und daraus das Kapitel gerendert. Das Kapitel entsteht NUR aus diesem
// Kern (nie direkt aus der Datei), damit `verify` es aus dem gesiegelten Kern genau so nachbauen und mit dem sichtbaren Text
// abgleichen kann. Wortwahl: keine Wirkungs- oder Kausalaussage; die Zahlen «nicht erneut geschrieben» und «hat nachgesehen»
// stehen getrennt, und nirgends steht, ein Textbaustein bringe den Agenten zum Nachsehen.
import type { Block, Rich, Section } from "./dossier-report.js";
import type { IntegrityCheck, IntegrityStatus } from "./core/artifact-integrity.js";
import type { BenchAggregate, BenchDocument, ComparisonMeasure } from "./bench/report.js";
import { pointsDe, proportionDe, round, type Proportion } from "./bench/stats.js";
import { redactSecrets } from "./cli-args.js";
import { CLAIM_CHECK_VERSION } from "./core/claim-check.js";
import {
  COUNTING_WARNING_DE,
  countingLabelDe,
  countingNeedsWarning,
  countingOfDocument,
  isBenchCounting,
  probeStatementDe,
  type BenchCounting,
} from "./bench/counting.js";

export const BENCH_CHAPTER_ID = "mehrlauf-messung";
/** Nummer des Kapitels im Dossier mit Mehrlauf-Messung; der Abschnitt «Prüfsumme & Methodische Grenzen» rückt auf 7. */
export const BENCH_CHAPTER_NO = 6;
export const BENCH_CHAPTER_TITLE = `${BENCH_CHAPTER_NO}. Mehrlauf-Messung (bench)`;

export interface DossierBenchCore {
  sealStatus: IntegrityStatus;
  reportSha256: string | null;
  harnessVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenarios: string[];
  conditions: string[];
  runsPerCell: number;
  patchLang: string;
  agent: {
    kind: string;
    model: string | null;
    api: string | null;
    urlHost: string | null;
    temperature: number | null;
    think: string | null;
    program: string | null;
  };
  task: string;
  followup: string | null;
  prompts: Array<{ scenario: string; condition: string; sha256: string }>;
  upstream: { program: string; script: string | null };
  toolCount: number;
  toolsSha256: string;
  effectProbe: { used: boolean; tool: string | null };
  /**
   * Zählweise aus dem Ergebnis der Läufe (nicht aus der Konfiguration). Fehlt in Kernen von Dossiers, die vor dieser Angabe erzeugt wurden;
   * deren Kapitel wird mit dem damaligen Wortlaut nachgebaut.
   */
  counting?: BenchCounting;
  /** Lesetext der Zählweise (bei neuen Kernen aus `counting`). */
  countingBasis: string;
  limits: { runTimeoutSec: number; stepTimeoutSec: number };
  reproduction: string;
  aggregates: BenchAggregate[];
  comparison: Array<{ scenario: string; smallSample: boolean; noStatement: boolean; measures: ComparisonMeasure[] }>;
  /** Version der Regeln der Ehrlichkeitsbewertung, mit der der Bench-Bericht ausgewertet wurde; null: der Bericht trägt keine Angabe (ältere Version des Prüfers). */
  claimCheckVersion: number | null;
  /** Nur bei einer abgebrochenen Messung: Abbruchgrund und die Läufe (es gibt keine Auswertung). */
  aborted?: { reason: string; runs: Array<{ id: string; scenario: string; condition: string; valid: boolean; invalidReason: string | null }> };
}

// ---------------------------------------------------------------- Prüfung der Datei

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === "string";
const isNumOrNull = (x: unknown): boolean => x === null || isNum(x);

function validProportion(x: unknown): boolean {
  return isObj(x) && isInt(x.k) && isInt(x.n) && x.k <= x.n && isNumOrNull(x.p) && isNumOrNull(x.lower) && isNumOrNull(x.upper);
}

function validCounts(x: unknown): boolean {
  return isObj(x) && (["HONEST", "DISHONEST", "UNCLEAR", "NOT_PROVIDED"] as const).every((k) => isInt(x[k]));
}

/** Null, wenn der Bench-Bericht die Felder hat, aus denen das Kapitel entsteht; sonst der Grund. */
export function validateBenchDocument(doc: unknown): string | null {
  if (!isObj(doc)) return "Der Bench-Bericht ist kein JSON-Objekt.";
  if (doc.status !== "abgeschlossen" && doc.status !== "abgebrochen") return "Im Bench-Bericht fehlt der Status («abgeschlossen» oder «abgebrochen») oder er hat einen unbekannten Wert.";
  const aborted = doc.status === "abgebrochen";
  const need = (cond: boolean, field: string): string | null => (cond ? null : `Im Bench-Bericht fehlt das Feld «${field}» oder es hat eine unerwartete Form.`);
  const strList = (x: unknown): boolean => Array.isArray(x) && x.every(isStr);
  const evaluation: Array<string | null> = aborted
    ? [
        need(isStr(doc.abortReason), "abortReason"),
        need(
          Array.isArray(doc.runs) &&
            doc.runs.every((r) => isObj(r) && isStr(r.id) && isStr(r.scenario) && isStr(r.condition) && typeof r.valid === "boolean" && (r.invalidReason === null || isStr(r.invalidReason))),
          "runs",
        ),
      ]
    : [
        need(
          Array.isArray(doc.aggregates) &&
            doc.aggregates.length > 0 &&
            doc.aggregates.every(
              (a) =>
                isObj(a) &&
                isStr(a.scenario) &&
                isStr(a.condition) &&
                isInt(a.planned) &&
                isInt(a.nValid) &&
                isInt(a.nInvalid) &&
                isObj(a.invalidReasons) &&
                Object.values(a.invalidReasons).every(isInt) &&
                (a.countingBasis === null || isStr(a.countingBasis)) &&
                validProportion(a.duplicate) &&
                validProportion(a.lookedUp) &&
                validProportion(a.dishonestFinal) &&
                validProportion(a.dishonestFirst) &&
                validCounts(a.claimFinalCounts) &&
                validCounts(a.claimFirstCounts) &&
                isObj(a.verdicts) &&
                Object.values(a.verdicts).every(isInt) &&
                isNumOrNull(a.meanToolCalls) &&
                typeof a.smallSample === "boolean" &&
                typeof a.noStatement === "boolean",
            ),
          "aggregates",
        ),
        need(
          Array.isArray(doc.comparison) &&
            doc.comparison.every(
              (c) =>
                isObj(c) &&
                isStr(c.scenario) &&
                typeof c.smallSample === "boolean" &&
                typeof c.noStatement === "boolean" &&
                Array.isArray(c.measures) &&
                c.measures.every(
                  (m) =>
                    isObj(m) &&
                    (m.measure === "duplicate" || m.measure === "lookedUp" || m.measure === "dishonestFinal") &&
                    validProportion(m.baseline) &&
                    validProportion(m.patch) &&
                    (m.difference === null || (isObj(m.difference) && isNum(m.difference.value) && isNum(m.difference.lower) && isNum(m.difference.upper))) &&
                    (m.intervalsOverlap === null || typeof m.intervalsOverlap === "boolean"),
                ),
            ),
          "comparison",
        ),
      ];
  const checks: Array<string | null> = [
    need(isStr(doc.harnessVersion), "harnessVersion"),
    need(isStr(doc.startedAt) && isStr(doc.finishedAt), "startedAt / finishedAt"),
    need(isNum(doc.durationMs), "durationMs"),
    need(strList(doc.scenarios) && (doc.scenarios as string[]).length > 0, "scenarios"),
    need(strList(doc.conditions) && (doc.conditions as string[]).length > 0, "conditions"),
    need(isInt(doc.runsPerCell), "runsPerCell"),
    need(isObj(doc.agent) && isStr(doc.agent.kind), "agent"),
    need(isStr(doc.task), "task"),
    need(doc.followup === null || isStr(doc.followup), "followup"),
    need(Array.isArray(doc.prompts) && doc.prompts.every((p) => isObj(p) && isStr(p.scenario) && isStr(p.condition) && isStr(p.sha256)), "prompts"),
    need(isObj(doc.upstream) && isStr(doc.upstream.program), "upstream"),
    need(Array.isArray(doc.tools) && isStr(doc.toolsSha256), "tools / toolsSha256"),
    need(isObj(doc.effectProbe) && typeof doc.effectProbe.used === "boolean", "effectProbe"),
    need(isStr(doc.countingBasis), "countingBasis"),
    need(doc.counting === undefined || isBenchCounting(doc.counting), "counting"),
    need(isObj(doc.limits) && isNum(doc.limits.runTimeoutSec) && isNum(doc.limits.stepTimeoutSec), "limits"),
    need(isStr(doc.reproduction), "reproduction"),
    ...evaluation,
  ];
  return checks.find((c) => c !== null) ?? null;
}

const text = (x: unknown): string => (typeof x === "string" ? x : "");
const textOrNull = (x: unknown): string | null => (typeof x === "string" ? x : null);
const numOrNull = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);

/** Der Kern, der ins Siegel des Dossiers geht. Der Bench-Bericht muss `validateBenchDocument` bestanden haben. */
export function benchCoreOf(doc: BenchDocument, check: IntegrityCheck): DossierBenchCore {
  const agent = doc.agent;
  // Die Zählweise folgt den Läufen: bei älteren Berichten ohne das Feld wird sie aus `runs` abgeleitet (soweit ablesbar).
  const counting = countingOfDocument(doc);
  return {
    sealStatus: check.status,
    reportSha256: doc.integrity?.payloadSha256 ?? null,
    harnessVersion: doc.harnessVersion,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    durationMs: doc.durationMs,
    scenarios: [...doc.scenarios],
    conditions: [...doc.conditions],
    runsPerCell: doc.runsPerCell,
    patchLang: text(doc.patchLang),
    agent: {
      kind: text(agent.kind),
      model: textOrNull(agent.model),
      api: textOrNull(agent.api),
      urlHost: textOrNull(agent.urlHost),
      temperature: numOrNull(agent.temperature),
      think: textOrNull(agent.think),
      program: textOrNull(agent.program),
    },
    task: doc.task,
    followup: doc.followup,
    prompts: doc.prompts.map((p) => ({ scenario: p.scenario, condition: p.condition, sha256: p.sha256 })),
    upstream: { program: doc.upstream.program, script: textOrNull(doc.upstream.script) },
    toolCount: doc.tools.length,
    toolsSha256: doc.toolsSha256,
    effectProbe: { used: doc.effectProbe.used, tool: textOrNull(doc.effectProbe.tool) },
    counting,
    countingBasis: countingLabelDe(counting),
    limits: { runTimeoutSec: doc.limits.runTimeoutSec, stepTimeoutSec: doc.limits.stepTimeoutSec },
    reproduction: redactSecrets(doc.reproduction),
    aggregates: JSON.parse(JSON.stringify(doc.aggregates)) as BenchAggregate[],
    comparison: doc.comparison.map((c) => ({
      scenario: c.scenario,
      smallSample: c.smallSample,
      noStatement: c.noStatement,
      measures: JSON.parse(JSON.stringify(c.measures)) as ComparisonMeasure[],
    })),
    claimCheckVersion: typeof doc.claimCheckVersion === "number" && Number.isFinite(doc.claimCheckVersion) ? doc.claimCheckVersion : null,
    ...(doc.status === "abgebrochen"
      ? {
          aborted: {
            reason: redactSecrets(doc.abortReason ?? ""),
            runs: doc.runs.map((r) => ({ id: r.id, scenario: r.scenario, condition: String(r.condition), valid: r.valid, invalidReason: r.invalidReason === null ? null : redactSecrets(r.invalidReason) })),
          },
        }
      : {}),
  };
}

/**
 * Der Kern, mit dem ein vorhandenes Dossier zu vergleichen oder neu aufzubauen ist: Trägt dessen Kern noch keine Zählweise aus den Läufen
 * (Dossier aus einer Fassung davor), gilt für den Vergleich der damalige Wortlaut (Angabe der Konfiguration im Bench-Bericht).
 */
export function benchCoreMatching(inDossier: DossierBenchCore, doc: BenchDocument, check: IntegrityCheck): DossierBenchCore {
  const core = benchCoreOf(doc, check);
  if (inDossier.counting === undefined) {
    delete core.counting;
    core.countingBasis = doc.countingBasis;
  }
  return core;
}

// ---------------------------------------------------------------- Abgleich Dossier ↔ Bench-Bericht

function labelOf(value: unknown, index: number): string {
  if (isObj(value) && isStr(value.scenario) && isStr(value.condition)) return `${value.scenario}/${value.condition}`;
  if (isObj(value) && isStr(value.scenario)) return value.scenario;
  if (isObj(value) && isStr(value.measure)) return value.measure;
  return String(index);
}

function shortJson(value: unknown): string {
  const t = JSON.stringify(value) ?? "undefined";
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/** Die Pfade, an denen zwei Kerne verschieden sind (höchstens `limit` Zeilen, danach eine Zählung). */
export function diffBenchCores(inDossier: unknown, fromReport: unknown, limit = 12): string[] {
  const out: string[] = [];
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${labelOf(a[i] ?? b[i], i)}]`);
      return;
    }
    if (isObj(a) && isObj(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], path === "" ? key : `${path}.${key}`);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: im Dossier ${shortJson(a)}, im Bench-Bericht ${shortJson(b)}`);
  };
  walk(inDossier, fromReport, "");
  return out.length > limit ? [...out.slice(0, limit), `... und ${out.length - limit} weitere Abweichungen`] : out;
}

// ---------------------------------------------------------------- Kapitel

function utc(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const u = (value: string): { user: string } => ({ user: value });

function agentText(a: DossierBenchCore["agent"]): string {
  if (a.kind === "builtin") {
    return `${a.model ?? "unbekanntes Modell"} (Schnittstelle ${a.api ?? "unbekannt"}, Host ${a.urlHost ?? "unbekannt"}), Temperatur ${a.temperature === null ? "Modellstandard" : String(a.temperature)}, Denkmodus ${a.think ?? "Modellstandard"}`;
  }
  return `eigener Agent (Programm ${a.program ?? "unbekannt"})`;
}

/** Kurzfassung für die Kopfzeile «Modell / Agent». */
export function benchAgentShort(a: DossierBenchCore["agent"]): string {
  return a.kind === "builtin" ? `${a.model ?? "unbekanntes Modell"} (${a.api ?? "unbekannt"})` : `eigener Agent (${a.program ?? "unbekannt"})`;
}

/** Kopfzeile «Umfang» mit Mehrlauf-Messung. */
export function benchScopeText(b: DossierBenchCore): string {
  if (b.aborted) return `Mehrlauf-Messung abgebrochen, keine Auswertung (${b.runsPerCell} Läufe je Bedingung geplant; Bedingungen ${b.conditions.join(", ")}, Szenario ${b.scenarios.join(", ")}); dazu ein aufgezeichneter Einzellauf (Abschnitte 1 bis 5)`;
  return `Mehrlauf-Messung: ${b.runsPerCell} Läufe je Bedingung (${b.conditions.join(", ")}), Szenario ${b.scenarios.join(", ")}; dazu ein aufgezeichneter Einzellauf (Abschnitte 1 bis 5)`;
}

const MEASURE_DE: Record<ComparisonMeasure["measure"], string> = {
  duplicate: "Erneut geschrieben (Duplikat)",
  lookedUp: "Hat nachgesehen",
  dishonestFinal: "Widerspruch in der Schlussantwort",
};

function basisSuffix(a: BenchAggregate): string {
  if (a.countingBasis === "executions") return " (gezählt als Ausführungen)";
  if (a.countingBasis === "mixed") return " (teils gezählt als Ausführungen)";
  return "";
}

function claimLine(counts: BenchAggregate["claimFirstCounts"]): string {
  const parts = [`ehrlich ${counts.HONEST}`, `unklar ${counts.UNCLEAR}`];
  if (counts.NOT_PROVIDED > 0) parts.push(`nicht geprüft ${counts.NOT_PROVIDED}`);
  return parts.join(", ");
}

function sealBlock(b: DossierBenchCore): Block {
  const sha: Rich = b.reportSha256 ? [{ code: b.reportSha256 }] : ["—"];
  if (b.sealStatus === "ok") {
    return { t: "p", rich: [{ badge: "Bench-Bericht: Prüfsumme stimmt", tone: "muted" }, " Selbstprüfung beim Erzeugen dieses Dossiers (ohne Signatur eines Dritten). Prüfsumme des Bench-Berichts (payloadSha256): ", ...sha] };
  }
  return {
    t: "p",
    rich: [
      { badge: b.sealStatus === "mismatch" ? "Bench-Bericht: Prüfsumme stimmt nicht" : "Bench-Bericht: Prüfsumme nicht prüfbar", tone: b.sealStatus === "mismatch" ? "fail" : "warn" },
      " ",
      { strong: "ACHTUNG: Der Bench-Bericht besteht seine eigene Prüfsumme nicht (oder trägt keine). Die Zahlen dieses Kapitels sind nicht belastbar." },
      " Prüfsumme laut Datei: ",
      ...sha,
    ],
  };
}

// Die Sonde als Aussage über das Ergebnis («angegeben; verwertbar in k von n Läufen»), die Zählweise aus den Läufen.
function probeMethodItems(b: DossierBenchCore): Rich[] {
  if (b.counting === undefined) {
    // Kern aus einer Fassung vor der Zählweise aus den Läufen: damaliger Wortlaut.
    return [
      b.effectProbe.used
        ? ["Wirkungs-Sonde: ja (Lese-Tool ", u(b.effectProbe.tool ?? "—"), "); Zählweise: ", u(b.countingBasis)]
        : ["Wirkungs-Sonde: nein; Zählweise: ", u(b.countingBasis), " (alle Zahlen sind Ausführungen, keine Datensätze)"],
    ];
  }
  return [["Wirkungs-Sonde: ", u(probeStatementDe(b.counting, b.effectProbe.tool))], ["Zählweise (aus den Läufen): ", u(countingLabelDe(b.counting))]];
}

function methodBlock(b: DossierBenchCore): Block {
  const items: Rich[] = [
    ["Modell / Agent der Messung: ", u(agentText(b.agent))],
    [`Harness-Version der Messung: `, u(b.harnessVersion), `; Datum und Dauer: ${utc(b.startedAt)} bis ${utc(b.finishedAt)} (${Math.round(b.durationMs / 1000)} s)`],
    [
      "Szenario: ",
      u(b.scenarios.join(", ")),
      "; Bedingungen: ",
      u(b.conditions.join(", ")),
      " (baseline = System-Prompt ohne Textbaustein, patch = System-Prompt mit dem Textbaustein des Harness",
      b.patchLang === "en" ? ", englisch)" : ", deutsch)",
    ],
    [`Läufe je Bedingung und Szenario (geplant): ${b.runsPerCell}. Ungültige Läufe zählen weder als sauber noch als Duplikat und stehen in der Tabelle.`],
    ...b.prompts.map((p): Rich => [`System-Prompt, SHA-256 (`, u(p.scenario), " ", u(p.condition), "): ", { code: p.sha256 }]),
    ["Aufgabe an den Agenten (Wortlaut): «", u(b.task), "»"],
    b.followup === null ? ["Nachfrage des Benutzers nach der ersten Antwort: keine"] : ["Nachfrage des Benutzers nach der ersten Antwort (Wortlaut): «", u(b.followup), "»"],
    ["Upstream (Testsystem): ", u(`${b.upstream.program}${b.upstream.script ? ` ${b.upstream.script}` : ""}`), `; ${b.toolCount} Tools (SHA-256 der Tool-Liste `, { code: b.toolsSha256 }, ")"],
    ...probeMethodItems(b),
    [`Zeitlimits: ${b.limits.runTimeoutSec} s je Lauf, ${b.limits.stepTimeoutSec} s je Schritt`],
  ];
  return { t: "list", items };
}

// Das Gegenstück eines Anteils (nicht erneut geschrieben = 1 − erneut geschrieben), aus den gerundeten Werten der Datei, damit die
// Grenzen mit denen der übrigen Zellen übereinstimmen.
function complement(x: BenchAggregate["duplicate"]): Proportion {
  if (x.n === 0 || x.p === null || x.lower === null || x.upper === null) return { k: x.n - x.k, n: x.n, p: null, lower: null, upper: null };
  return { k: x.n - x.k, n: x.n, p: round(1 - x.p), lower: round(1 - x.upper), upper: round(1 - x.lower) };
}

function behaviourTable(b: DossierBenchCore): Block {
  return {
    t: "table",
    head: ["Szenario", "Bedingung", "Läufe gültig / ungültig", "Erneut geschrieben (Duplikat, k von n gültigen Läufen)", "Nicht erneut geschrieben", "Hat nachgesehen", "Urteile", "Ø Tool-Aufrufe"],
    rows: b.aggregates.map((a): Rich[] => {
      const none = a.noStatement;
      const dup = none
        ? `keine Aussage (weniger als 5 gültige Läufe): ${a.duplicate.k} von ${a.duplicate.n}`
        : a.duplicate.n === 0
          ? "keine gültigen Läufe"
          : `${proportionDe(a.duplicate)}${basisSuffix(a)}${a.smallSample ? "; kleine Stichprobe" : ""}`;
      const notRewritten = none
        ? `${a.duplicate.n - a.duplicate.k} von ${a.duplicate.n}`
        : a.duplicate.n === 0
          ? "—"
          : proportionDe(complement(a.duplicate));
      return [
        [u(a.scenario)],
        [u(a.condition)],
        [`${a.nValid} gültig / ${a.nInvalid} ungültig (von ${a.planned} geplanten)`],
        [dup],
        [notRewritten],
        [a.lookedUp.n === 0 ? "—" : none ? `${a.lookedUp.k} von ${a.lookedUp.n}` : proportionDe(a.lookedUp)],
        [u(Object.entries(a.verdicts).map(([v, n]) => `${v} ${n}`).join(", ") || "—")],
        [a.meanToolCalls === null ? "—" : String(a.meanToolCalls).replace(".", ",")],
      ];
    }),
  };
}

function honestyTable(b: DossierBenchCore): Block {
  const cell = (p: BenchAggregate["dishonestFirst"], counts: BenchAggregate["claimFirstCounts"], none: boolean): string =>
    p.n === 0 ? "—" : `${none ? `${p.k} von ${p.n}` : proportionDe(p)}; ${claimLine(counts)}`;
  return {
    t: "table",
    head: ["Szenario", "Bedingung", "Erste Antwort (nach dem Timeout): Widerspruch erkannt", "Schlussantwort (nach der Nachfrage): Widerspruch erkannt"],
    rows: b.aggregates.map((a): Rich[] => [
      [u(a.scenario)],
      [u(a.condition)],
      [cell(a.dishonestFirst, a.claimFirstCounts, a.noStatement)],
      [cell(a.dishonestFinal, a.claimFinalCounts, a.noStatement)],
    ]),
  };
}

function readingItems(b: DossierBenchCore): Rich[] {
  const out: Rich[] = [];
  for (const a of b.aggregates) {
    if (a.nValid === 0 || a.noStatement) continue;
    const notRewritten = a.duplicate.n - a.duplicate.k;
    const looked = a.lookedUp.k;
    out.push([
      u(`${a.scenario} ${a.condition}`),
      `: nicht erneut geschrieben in ${notRewritten} von ${a.duplicate.n} gültigen Läufen, nachgesehen in ${looked} von ${a.lookedUp.n}.`,
      looked < notRewritten ? " Es haben weniger Läufe nachgesehen als nicht erneut geschrieben haben: Nicht erneut zu schreiben ist hier nicht dasselbe wie nachzusehen." : "",
    ]);
  }
  return out;
}

function comparisonBlocks(b: DossierBenchCore): Block[] {
  const blocks: Block[] = [];
  if (b.conditions.length < 2) {
    blocks.push({ t: "p", rich: ["Es wurde nur eine Bedingung gemessen (", u(b.conditions.join(", ")), "): Es gibt keinen Vergleich zwischen baseline und patch."] });
    return blocks;
  }
  if (b.comparison.length === 0) {
    blocks.push({ t: "p", rich: ["Kein Vergleich: Für kein Szenario liegen beide Bedingungen vor."] });
    return blocks;
  }
  for (const c of b.comparison) {
    const byMeasure = (m: ComparisonMeasure["measure"]): ComparisonMeasure | undefined => c.measures.find((x) => x.measure === m);
    const dup = byMeasure("duplicate");
    const look = byMeasure("lookedUp");
    let statement: string;
    if (c.noStatement) statement = "Keine Aussage: In einer der beiden Bedingungen gibt es weniger als 5 gültige Läufe.";
    else if (!dup || dup.difference === null || dup.intervalsOverlap === null) statement = "Keine Aussage: Es fehlen gültige Läufe.";
    else {
      statement =
        `Erneut geschrieben: baseline ${proportionDe(dup.baseline)}, patch ${proportionDe(dup.patch)}; Differenz ${pointsDe(dup.difference.value)} (95-%-Intervall ${pointsDe(dup.difference.lower)} bis ${pointsDe(dup.difference.upper)}). ` +
        (dup.intervalsOverlap ? "Die 95-%-Intervalle überlappen." : "Die 95-%-Intervalle überlappen nicht.") +
        (look && look.intervalsOverlap !== null
          ? ` Hat nachgesehen: baseline ${look.baseline.k} von ${look.baseline.n}, patch ${look.patch.k} von ${look.patch.n}; ${look.intervalsOverlap ? "die 95-%-Intervalle überlappen" : "die 95-%-Intervalle überlappen nicht"}.`
          : "") +
        (c.smallSample ? " Kleine Stichprobe (weniger als 10 gültige Läufe in einer Bedingung): vorsichtig lesen." : "") +
        " Das ist ein Hinweis, kein Beweis, und gilt nur für dieses Modell, diese Aufgabe und diesen Upstream.";
    }
    blocks.push({ t: "p", rich: [{ strong: `${c.scenario}:` }, " ", u(statement)] });
    if (!c.noStatement) {
      blocks.push({
        t: "table",
        head: ["Mass", "baseline", "patch", "Differenz patch − baseline (95-%-Intervall nach Newcombe)", "95-%-Intervalle der Anteile"],
        rows: c.measures.map((m): Rich[] => [
          [MEASURE_DE[m.measure]],
          [m.baseline.n === 0 ? "—" : proportionDe(m.baseline)],
          [m.patch.n === 0 ? "—" : proportionDe(m.patch)],
          [m.difference ? `${pointsDe(m.difference.value)} (${pointsDe(m.difference.lower)} bis ${pointsDe(m.difference.upper)})` : "—"],
          [m.intervalsOverlap === null ? "—" : m.intervalsOverlap ? "überlappen" : "überlappen nicht"],
        ]),
      });
    }
  }
  blocks.push({
    t: "p",
    rich: ["Zur Wortwahl: «überlappen» heisst, dass sich ein Unterschied bei dieser Stichprobe nicht von Zufall trennen lässt; «überlappen nicht» ist ein Hinweis auf einen Unterschied, kein Beweis. Aus dem Vergleich folgt nicht, dass der Textbaustein den Agenten zum Nachsehen bringt: Das zeigt allein die Zeile «Hat nachgesehen»."],
  });
  return blocks;
}

function countingLimitItem(b: DossierBenchCore): Rich {
  const c = b.counting;
  if (c === undefined) {
    return b.effectProbe.used
      ? ["Gezählt wurden Datensätze (Wirkungs-Sonde: nachher minus vorher), wo die Sonde verwertbar war, sonst Ausführungen (mit dem Zusatz «gezählt als Ausführungen»)."]
      : ["Ohne Wirkungs-Sonde sind alle Zahlen Ausführungen beim Upstream (gezählt als Ausführungen), keine Datensätze."];
  }
  switch (c.basis) {
    case "records":
      return ["Gezählt wurden Datensätze (Wirkungs-Sonde: nachher minus vorher) in allen gültigen Läufen."];
    case "executions":
      return c.probeGiven
        ? ["Die Wirkungs-Sonde war angegeben, aber in keinem gültigen Lauf verwertbar: Alle Zahlen sind Ausführungen beim Upstream (gezählt als Ausführungen), keine Datensätze."]
        : ["Ohne Wirkungs-Sonde sind alle Zahlen Ausführungen beim Upstream (gezählt als Ausführungen), keine Datensätze."];
    case "mixed":
      return [`Die Zählweise ist nicht einheitlich: Datensätze wurden in ${c.recordRuns} von ${c.validRuns} Läufen gezählt (Wirkungs-Sonde), Ausführungen in ${c.executionRuns} von ${c.validRuns} Läufen (gezählt als Ausführungen).`];
    case "none":
      return ["Es gibt keinen gültigen Lauf; die Zählweise lässt sich nicht bestimmen."];
    default:
      return ["Die Zählweise lässt sich aus dem Bench-Bericht nicht ablesen (Bericht ohne Angabe zur Zählweise)."];
  }
}

function warningBlocks(b: DossierBenchCore): Block[] {
  return b.counting !== undefined && countingNeedsWarning(b.counting) ? [{ t: "p", rich: [{ strong: "Hinweis zur Zählweise:" }, " ", COUNTING_WARNING_DE] }] : [];
}

function limitItems(b: DossierBenchCore): Rich[] {
  const items: Rich[] = [
    ["Eine Messung: ein Modell oder Agent (Angabe: ", u(benchAgentShort(b.agent)), "), eine Aufgabe, ein Upstream und das Szenario ", u(b.scenarios.join(", ")), ". Sie sagt nichts über andere Modelle, andere Prompts, andere Aufgaben oder andere Systeme."],
    [
      `Stichprobe: ${b.runsPerCell} Läufe je Bedingung geplant. Jeder Anteil trägt ein 95-%-Wilson-Intervall, die Differenz ein Intervall nach Newcombe. Bei weniger als 10 gültigen Läufen je Bedingung steht «kleine Stichprobe», bei weniger als 5 gibt es keine Aussage. Überlappen die Intervalle, lässt sich ein Unterschied nicht von Zufall trennen; überlappen sie nicht, ist das ein Hinweis, kein Beweis.`,
    ],
    ["Der Aufbau zählt: Dieselbe Messung mit einem anderen Modell, Prompt, einer anderen Aufgabe oder einem anderen Testsystem kann ein anderes Ergebnis haben. Diese Zahlen gelten nur für den oben beschriebenen Aufbau."],
    ["«Hat nachgesehen» zählt nur, ob der Agent nach dem ersten Schreibvorgang ein Lese-Tool aufgerufen hat, nicht, ob er den Zustand richtig geprüft hat. «Nicht erneut geschrieben» heisst nur, dass kein zweiter Schreibvorgang ankam."],
    ["Der Ehrlichkeits-Check arbeitet mit festen Regeln für deutsche und englische Sätze und kann Bedeutung nicht verstehen. Was er nicht eindeutig erkennt, bleibt «unklar» und gilt nie als unehrlich; «Widerspruch erkannt» ist ein Befund der Regeln, kein Beweis."],
    countingLimitItem(b),
    ["Ein Lauf ohne Doppelausführung ist keine Freigabe für den Produktivbetrieb und kein Zertifikat. Die Prüfsumme schützt nur, wenn ihr Wert getrennt von der Datei aufbewahrt wird; sie ist keine Signatur eines Dritten."],
    ["Der Rohverlauf je Lauf (runs/*.jsonl und runs/*.report.json) liegt neben dem Bench-Bericht und ist nicht Teil dieses Dossiers."],
  ];
  return items;
}

/** Das Kapitel «Mehrlauf-Messung»; entsteht allein aus dem Kern. */
export const CLAIM_CHECK_OLDER_DE =
  "Die Ehrlichkeitsbewertung dieser Messung stammt aus einer älteren Version des Prüfers; sie kann sich bei erneuter Auswertung ändern.";

/** Hinweis, wenn der Bench-Bericht kein Feld `claimCheckVersion` oder eine ältere Version als die dieses Programms trägt. */
export function claimCheckOlder(version: number | null, current: number): boolean {
  return version === null || version < current;
}

function abortedSection(b: DossierBenchCore): Section {
  const aborted = b.aborted!;
  const invalid = aborted.runs.filter((r) => !r.valid);
  const blocks: Block[] = [sealBlock(b)];
  blocks.push({
    t: "p",
    rich: [{ strong: "Die Messung wurde abgebrochen." }, " Abbruchgrund: ", u(aborted.reason === "" ? "nicht angegeben" : aborted.reason)],
  });
  blocks.push({
    t: "p",
    rich: [
      { strong: "Keine Auswertung." },
      " Aus den Läufen entsteht keine Aussage darüber, wie oft der Agent erneut schreibt, ob er nachsieht oder ob seine Meldungen stimmen: Es gibt weder Anteile noch Intervalle noch einen Vergleich zwischen baseline und patch. Die Messung muss wiederholt werden.",
    ],
  });
  blocks.push({ t: "h3", text: "Methode (geplant)" }, methodBlock(b), ...warningBlocks(b));
  blocks.push({ t: "h3", text: "Läufe" });
  blocks.push({
    t: "p",
    rich: [`${aborted.runs.length} Läufe wurden ausgeführt (geplant: ${b.runsPerCell} je Bedingung und Szenario), davon ${aborted.runs.length - invalid.length} gültig und ${invalid.length} ungültig. Ungültige Läufe zählen weder als sauber noch als Duplikat.`],
  });
  if (invalid.length > 0) {
    blocks.push({
      t: "table",
      head: ["Lauf", "Szenario", "Bedingung", "Grund (ungültig)"],
      rows: invalid.map((r): Rich[] => [[u(r.id)], [u(r.scenario)], [u(r.condition)], [u(r.invalidReason ?? "unbekannter Grund")]]),
    });
  }
  blocks.push({
    t: "note",
    title: "Grenzen",
    items: [
      ["Eine abgebrochene Messung belegt nichts über den Agenten. Auch die gültigen Läufe werden hier nicht ausgewertet; ihr Rohverlauf (runs/*.jsonl und runs/*.report.json) liegt neben dem Bench-Bericht und ist nicht Teil dieses Dossiers."],
      ["Die Prüfsumme schützt nur, wenn ihr Wert getrennt von der Datei aufbewahrt wird; sie ist keine Signatur eines Dritten. Ein Lauf ohne Doppelausführung ist keine Freigabe für den Produktivbetrieb und kein Zertifikat."],
    ],
  });
  blocks.push({ t: "h3", text: "Reproduktion" }, { t: "pre", text: b.reproduction.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n") });
  return {
    id: BENCH_CHAPTER_ID,
    title: BENCH_CHAPTER_TITLE,
    intro: "Dieses Kapitel gibt eine eigene Messung wieder, die abgebrochen wurde. Sie ist unabhängig vom aufgezeichneten Einzellauf der Abschnitte 1 bis 5.",
    blocks,
  };
}

export function benchSection(b: DossierBenchCore): Section {
  if (b.aborted) return abortedSection(b);
  const blocks: Block[] = [sealBlock(b)];
  blocks.push({ t: "h3", text: "Methode" }, methodBlock(b));
  blocks.push({ t: "h3", text: "Ergebnis je Szenario und Bedingung" }, behaviourTable(b), ...warningBlocks(b));
  const invalidItems = b.aggregates
    .filter((a) => a.nInvalid > 0)
    .flatMap((a) =>
      Object.entries(a.invalidReasons).map(([reason, n]): Rich => ["Ungültig (nicht als sauber, nicht als Duplikat gezählt), ", u(`${a.scenario} ${a.condition}`), `: ${n} × `, u(reason)]),
    );
  if (invalidItems.length > 0) blocks.push({ t: "list", items: invalidItems });
  blocks.push(
    { t: "h3", text: "Erneut geschrieben und nachgesehen sind zwei verschiedene Zahlen" },
    {
      t: "p",
      rich: [
        "«Nicht erneut geschrieben» heisst nur, dass kein zweiter Schreibvorgang beim Upstream ankam. «Hat nachgesehen» heisst, dass der Agent nach dem ersten Schreibvorgang ein Lese-Tool aufgerufen hat. Ein Agent kann nach einem Timeout aufhören, ohne nachzusehen; dann bleibt offen, ob der Vorgang schon ausgeführt war. Ein Rückgang beim erneuten Schreiben zeigt deshalb nicht, dass der Agent nachgesehen oder den Zustand richtig geprüft hat; das zeigt nur die Zahl «hat nachgesehen».",
      ],
    },
  );
  const reading = readingItems(b);
  if (reading.length > 0) blocks.push({ t: "list", items: reading });
  blocks.push({ t: "h3", text: "Ehrlichkeit der Meldungen des Agenten" });
  blocks.push({
    t: "p",
    rich: [
      "Die erste Antwort entsteht nach dem ersten Zug (nach dem Timeout) und wird gegen den Zwischenstand des Laufs geprüft, die Schlussantwort nach der Nachfrage gegen den Endstand. «Widerspruch erkannt» ist der Anteil der bewerteten Antworten, die einer beobachteten Tatsache widersprechen.",
    ],
  });
  if (claimCheckOlder(b.claimCheckVersion, CLAIM_CHECK_VERSION)) blocks.push({ t: "p", rich: [{ strong: "Hinweis: " }, CLAIM_CHECK_OLDER_DE] });
  blocks.push(honestyTable(b));
  blocks.push({ t: "h3", text: "Vergleich baseline gegen patch" }, ...comparisonBlocks(b));
  blocks.push({ t: "note", title: "Grenzen dieser Messung", items: limitItems(b) });
  blocks.push({ t: "h3", text: "Reproduktion" }, { t: "pre", text: b.reproduction.replace(/\r\n?/g, "\n").replace(/\n{2,}/g, "\n") });
  blocks.push({ t: "p", rich: ["Der Befehl enthält weder Lizenzcode noch API-Schlüssel; Pfade und weitere Argumente des Upstreams fehlen. Die Zahlen dieses Kapitels gegen den Bench-Bericht prüfen: ", { code: "verify <dossier> --bench bench-report.json" }, "."] });
  return {
    id: BENCH_CHAPTER_ID,
    title: BENCH_CHAPTER_TITLE,
    intro: "Dieses Kapitel fasst eine eigene Messung zusammen: Der Agent wurde je Bedingung mehrfach gegen das Testsystem ausgeführt. Sie ist unabhängig vom aufgezeichneten Einzellauf der Abschnitte 1 bis 5.",
    blocks,
  };
}
