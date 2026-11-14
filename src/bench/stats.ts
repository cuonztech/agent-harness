// Statistik für `bench`: reine Funktionen ohne Ein- und Ausgabe, damit sie sich mit bekannten Werten prüfen lassen.
//
// Anteil mit Wilson-Intervall (Score-Intervall, 95 %) und Differenz zweier Anteile nach Newcombe (Hybrid-Score-Methode,
// beide Anteile je mit Wilson-Intervall). Gerechnet wird mit dem exakten Quantil der Normalverteilung für 95 %.

/** Das 97,5-%-Quantil der Standardnormalverteilung (zweiseitig 95 %). */
export const Z_95 = 1.959963984540054;

export interface Proportion {
  /** Zahl der Treffer. */
  k: number;
  /** Zahl der gültigen Läufe. */
  n: number;
  /** Anteil k/n; null bei n = 0. */
  p: number | null;
  /** Untere Grenze des Wilson-Intervalls; null bei n = 0. */
  lower: number | null;
  /** Obere Grenze des Wilson-Intervalls; null bei n = 0. */
  upper: number | null;
}

export interface DifferenceInterval {
  /** p1 − p2. */
  difference: number;
  lower: number;
  upper: number;
}

function checkCounts(k: number, n: number): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new Error(`Ungültige Zählung: ${String(k)} von ${String(n)}`);
  }
}

/** Wilson-Intervall für k von n. Bei n = 0 gibt es keinen Anteil (alles null). */
export function wilson(k: number, n: number, z: number = Z_95): Proportion {
  checkCounts(k, n);
  if (n === 0) return { k, n, p: null, lower: null, upper: null };
  const p = k / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return { k, n, p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/**
 * Differenz p1 − p2 mit dem Intervall nach Newcombe (Methode 10, hybrid score). Null, wenn eine der beiden Gruppen leer ist.
 */
export function differenceInterval(k1: number, n1: number, k2: number, n2: number): DifferenceInterval | null {
  const a = wilson(k1, n1);
  const b = wilson(k2, n2);
  if (a.p === null || b.p === null || a.lower === null || a.upper === null || b.lower === null || b.upper === null) return null;
  const difference = a.p - b.p;
  const lower = difference - Math.sqrt((a.p - a.lower) ** 2 + (b.upper - b.p) ** 2);
  const upper = difference + Math.sqrt((a.upper - a.p) ** 2 + (b.p - b.lower) ** 2);
  return { difference, lower, upper };
}

/** Überlappen sich zwei Intervalle (Randberührung zählt als Überlappung)? Null, wenn eines fehlt. */
export function intervalsOverlap(a: Proportion, b: Proportion): boolean | null {
  if (a.lower === null || a.upper === null || b.lower === null || b.upper === null) return null;
  return a.lower <= b.upper && b.lower <= a.upper;
}

/** Auf eine feste Zahl Nachkommastellen runden (für die Datei; die Rechnung bleibt ungerundet). */
export function round(value: number | null, digits = 4): number | null {
  if (value === null) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Anteil als Prozentangabe mit Dezimalkomma, zum Beispiel «53,3 %». */
export function percentDe(p: number | null, digits = 1): string {
  if (p === null) return "—";
  return `${(p * 100).toFixed(digits).replace(".", ",")} %`;
}

/** «k von n (53,3 %; 95-%-Intervall 30,1 bis 75,2 %)». Bei n = 0: «keine gültigen Läufe». */
export function proportionDe(x: Proportion): string {
  if (x.p === null || x.lower === null || x.upper === null) return "keine gültigen Läufe";
  return `${x.k} von ${x.n} (${percentDe(x.p)}; 95-%-Intervall ${percentDe(x.lower)} bis ${percentDe(x.upper)})`;
}

/** Eine Differenz in Prozentpunkten, mit Vorzeichen, zum Beispiel «−46,7 Prozentpunkte». */
export function pointsDe(value: number, digits = 1): string {
  const text = (Math.abs(value) * 100).toFixed(digits).replace(".", ",");
  const sign = value < 0 ? "−" : value > 0 ? "+" : "";
  return `${sign}${text} Prozentpunkte`;
}
