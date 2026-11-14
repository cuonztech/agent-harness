// Zählweise einer Mehrlauf-Messung: Sie folgt dem Ergebnis der Läufe, nicht der Konfiguration.
//
// Wer `--effect-probe` angibt, hat damit noch keine Datensätze gezählt: Die Sonde kann in einem Lauf unbrauchbar sein
// (Fehler des Tools, Pflichtargument fehlt, Zählwert widerspricht den Schreibvorgängen). Dann zählt der Lauf Ausführungen.
// Dieser Baustein liest aus den Läufen, was wirklich gezählt wurde, und liefert die Wortlaute für Bericht, Konsole und Dossier.
// Reine Funktionen ohne Ein- und Ausgabe; Gründe sind feste deutsche Sätze (nie ein Text des Upstreams, keine Pfade).

/** Der Teil eines Laufs, aus dem die Zählweise folgt. */
export interface CountingRun {
  valid: boolean;
  truthBasis: "records" | "executions" | null;
  probeConclusion: string | null;
  /** Fester deutscher Grund, warum die Sonde nicht verwertbar war (neu ab 0.12.0); fehlt in älteren Berichten. */
  probeReason?: string | null;
}

export type CountingBasis = "records" | "executions" | "mixed" | "none" | "unknown";

export interface BenchCounting {
  /** Was die gültigen Läufe tatsächlich gezählt haben. «none»: kein gültiger Lauf; «unknown»: aus dem Bericht nicht ablesbar. */
  basis: CountingBasis;
  /** `--effect-probe` war angegeben. */
  probeGiven: boolean;
  validRuns: number;
  /** Gültige Läufe, in denen die Sonde verwertbar war (Datensätze). */
  recordRuns: number;
  /** Gültige Läufe, die als Ausführungen gezählt haben. */
  executionRuns: number;
  /** Gründe, warum die Sonde in Läufen nicht verwertbar war (nur wenn sie angegeben war), häufigster zuerst. */
  reasons: Array<{ reason: string; runs: number }>;
}

export const COUNTING_WARNING_DE =
  "Bei Zählung als Ausführungen kann ein Upstream, der eine Wiederholung selbst abfängt (zum Beispiel über einen Schlüssel), trotzdem als «erneut geschrieben» erscheinen. Genaueres zeigt nur die Wirkungs-Sonde.";

export const COUNTING_RECORDS_DE = "Datensätze (Wirkungs-Sonde: nachher minus vorher)";

// ---------------------------------------------------------------- Gründe

/** Fester deutscher Grund aus dem Ergebnis der Sonde und der (englischen) Begründung des Proxy-Reports. Kopiert keinen Text des Upstreams. */
export function probeReasonDe(conclusion: string | null, note: string): string {
  const n = note.toLowerCase();
  if (n.includes("could not be read")) {
    if (n.includes("error result")) return "Sonde antwortete mit einem Fehler (Argumente fehlen oder sind falsch)";
    if (n.includes("not json")) return "Antwort der Sonde ist kein JSON";
    if (n.includes("cannot tell what to count")) return "Antwort der Sonde ohne erkennbare Liste oder Zahl (--effect-count nötig)";
    if (n.includes("--effect-count") && n.includes("does not lead")) return "--effect-count führt zu keiner Liste, Zahl oder keinem Objekt";
    if (n.includes("did not answer within")) return "Sonde antwortete nicht rechtzeitig";
    if (n.includes("not running any more")) return "Upstream lief beim Lesen der Sonde nicht mehr";
    if (n.includes("not a count")) return "Antwort der Sonde ist keine gültige Zahl";
    return "Sonde nicht lesbar";
  }
  if (n.includes("no reading of the probe")) return "keine Messung der Sonde vorhanden";
  if (n.includes("still open")) return "Aufrufe waren beim Lesen der Sonde noch offen";
  if (n.includes("older than the latest call")) return "Messung der Sonde war nicht mehr aktuell";
  if (n.includes("different write tools")) return "mehrere Schreib-Tools: --effect-tools angeben";
  if (n.includes("read like an error")) return "Antworten wie Fehler ohne isError: Zählwert nicht zuordenbar";
  if (n.includes("contradicts the assumptions")) return "Zählwert der Sonde passt nicht zu den Schreibvorgängen (zählt die Sonde, was sie erzeugen? verwendet die Aufgabe den Wert der Sonden-Argumente?)";
  if (conclusion === "partial") return "Zählwert lässt sich nicht den Vorgängen zuordnen (teils neu, teils nicht)";
  if (conclusion === "no_writes") return "kein Schreibvorgang erreichte den Upstream";
  return genericReasonDe(conclusion);
}

/** Grund aus dem Ergebnis allein (ältere Berichte ohne Begründung). */
function genericReasonDe(conclusion: string | null): string {
  if (conclusion === null) return "kein Ergebnis der Sonde im Report des Proxys";
  if (conclusion === "inconclusive") return "Sonde ohne verwertbares Ergebnis (Zählwert nicht lesbar oder widersprüchlich)";
  if (conclusion === "partial") return "Zählwert lässt sich nicht den Vorgängen zuordnen (teils neu, teils nicht)";
  if (conclusion === "no_writes") return "kein Schreibvorgang erreichte den Upstream";
  return `Ergebnis der Sonde: ${conclusion}`;
}

// ---------------------------------------------------------------- Ermitteln

export function countingOfRuns(rows: CountingRun[], probeGiven: boolean): BenchCounting {
  const valid = rows.filter((r) => r.valid && r.truthBasis !== null);
  const recordRuns = valid.filter((r) => r.truthBasis === "records").length;
  const executionRuns = valid.length - recordRuns;
  const basis: CountingBasis = valid.length === 0 ? "none" : executionRuns === 0 ? "records" : recordRuns === 0 ? "executions" : "mixed";
  const reasons = new Map<string, number>();
  if (probeGiven) {
    for (const r of valid.filter((x) => x.truthBasis === "executions")) {
      const reason = r.probeReason ?? genericReasonDe(r.probeConclusion);
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  return {
    basis,
    probeGiven,
    validRuns: valid.length,
    recordRuns,
    executionRuns,
    reasons: [...reasons.entries()].map(([reason, runs]) => ({ reason, runs })).sort((a, b) => b.runs - a.runs || a.reason.localeCompare(b.reason, "de")),
  };
}

export function isBenchCounting(x: unknown): x is BenchCounting {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return false;
  const c = x as Record<string, unknown>;
  const int = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
  return (
    (c.basis === "records" || c.basis === "executions" || c.basis === "mixed" || c.basis === "none" || c.basis === "unknown") &&
    typeof c.probeGiven === "boolean" &&
    int(c.validRuns) &&
    int(c.recordRuns) &&
    int(c.executionRuns) &&
    Array.isArray(c.reasons) &&
    c.reasons.every((r) => r !== null && typeof r === "object" && typeof (r as Record<string, unknown>).reason === "string" && int((r as Record<string, unknown>).runs))
  );
}

/** Die Zählweise eines Bench-Berichts: das gesiegelte Feld `counting`, sonst aus den Läufen abgeleitet (ältere Berichte), soweit ablesbar. */
export function countingOfDocument(doc: { counting?: unknown; runs?: unknown; effectProbe?: { used?: unknown } }): BenchCounting {
  if (isBenchCounting(doc.counting)) return doc.counting;
  const probeGiven = doc.effectProbe?.used === true;
  if (Array.isArray(doc.runs) && doc.runs.every((r) => r !== null && typeof r === "object" && typeof (r as CountingRun).valid === "boolean")) {
    return countingOfRuns(doc.runs as CountingRun[], probeGiven);
  }
  return { basis: "unknown", probeGiven, validRuns: 0, recordRuns: 0, executionRuns: 0, reasons: [] };
}

// ---------------------------------------------------------------- Wortlaut

export const runsDe = (n: number): string => `${n} ${n === 1 ? "Lauf" : "Läufe"}`;

function reasonsDe(c: BenchCounting): string {
  if (c.reasons.length === 0) return "";
  const shown = c.reasons.slice(0, 3).map((r) => `${r.reason} (${r.runs} ×)`);
  const more = c.reasons.length - shown.length;
  return `: ${shown.join("; ")}${more > 0 ? `; ${more} weitere` : ""}`;
}

/** «Datensätze (…)» / «Ausführungen (keine Sonde)» / «gemischt: …» aus dem Ergebnis der Läufe. */
export function countingLabelDe(c: BenchCounting): string {
  switch (c.basis) {
    case "records":
      return COUNTING_RECORDS_DE;
    case "executions":
      return c.probeGiven ? `Ausführungen (Sonde in ${c.executionRuns} von ${c.validRuns} Läufen nicht verwertbar${reasonsDe(c)})` : "Ausführungen (keine Sonde)";
    case "mixed":
      return `gemischt: ${runsDe(c.recordRuns)} Datensätze, ${runsDe(c.executionRuns)} Ausführungen (Sonde in ${c.executionRuns} von ${c.validRuns} Läufen nicht verwertbar${reasonsDe(c)})`;
    case "none":
      return "nicht bestimmbar (kein gültiger Lauf)";
    default:
      return "nicht aus den Läufen ablesbar (Bericht ohne Angabe zur Zählweise)";
  }
}

/** Satz über die Sonde als Aussage über das Ergebnis, nicht über die Konfiguration. */
export function probeStatementDe(c: BenchCounting, tool: string | null): string {
  if (!c.probeGiven) return "nicht angegeben";
  const name = tool === null ? "" : ` (${tool})`;
  if (c.basis === "unknown") return `angegeben${name}; ob sie verwertbar war, lässt sich aus dem Bericht nicht ablesen`;
  return `angegeben${name}; verwertbar in ${c.recordRuns} von ${c.validRuns} Läufen`;
}

/** Zählung als Ausführungen (ganz oder teilweise, oder nicht ablesbar): der Hinweis auf die Grenze gehört dazu. */
export function countingNeedsWarning(c: BenchCounting): boolean {
  return c.basis === "executions" || c.basis === "mixed" || c.basis === "unknown";
}
