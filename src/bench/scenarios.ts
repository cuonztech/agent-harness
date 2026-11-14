// Szenarien von `bench`: welche es gibt, was jedes misst und was nicht. Jedes Szenario hat sein EIGENES Mass; die Zahlen verschiedener
// Szenarien werden nie in einem Aggregat vermischt. Die Wortlaute stehen nur hier und werden von Lesetext, Konsole und Dossier-Kapitel
// benutzt. Reine Daten und Funktionen ohne Ein- und Ausgabe (Schweizer Rechtschreibung, kein Eszett).

/** Die Szenarien, die `bench` misst. F3 (defektes JSON) und F5 (HTTP 500) gibt es in `bench` nicht, siehe `NOT_IN_BENCH_DE`. */
export const BENCH_SCENARIOS = ["F1", "F2", "F4"] as const;
export type BenchScenario = (typeof BENCH_SCENARIOS)[number];

export const NOT_IN_BENCH_DE: Record<string, string> = {
  F3:
    "F3 (defektes JSON in der Antwort) misst bench nicht: Für F3 gibt es noch kein eigenes Mass für viele Läufe (der Einzellauf mit proxy oder campaign beurteilt es), und ein Lauf mit dem Mass von F1 würde etwas anderes messen, als der Name sagt.",
  F5:
    "F5 (HTTP 500 auf dem ersten Schreibversuch) misst bench nicht: Für F5 gibt es noch kein eigenes Mass für viele Läufe (der Einzellauf mit proxy oder campaign beurteilt es), und ein Lauf mit dem Mass von F1 würde etwas anderes messen, als der Name sagt.",
};

/** Ausgänge eines F2-Laufs nach der Ablehnung mit Wartezeit, aus den Zeitstempeln der Aufrufe am Proxy. */
export type RetryBehavior = "waited" | "too_early" | "gave_up" | "no_retry";
export const RETRY_BEHAVIORS: RetryBehavior[] = ["waited", "too_early", "gave_up", "no_retry"];

export const RETRY_BEHAVIOR_DE: Record<RetryBehavior, string> = {
  waited: "hielt die Wartezeit ein",
  too_early: "wiederholte vor Ablauf",
  gave_up: "gab auf",
  no_retry: "wiederholte gar nicht",
};

export interface ScenarioText {
  id: BenchScenario;
  title: string;
  /** Das Mass in einem Satz (Konsole). */
  shortDe: string;
  /** Wie der Lauf aussieht und wie das Mass definiert ist. */
  measureDe: string;
  /** Was das Szenario nicht misst. */
  notMeasuredDe: string;
}

export const SCENARIO_TEXTS: Record<BenchScenario, ScenarioText> = {
  F1: {
    id: "F1",
    title: "F1: Timeout nach dem ersten Schreibvorgang",
    shortDe: "Mass «erneut geschrieben (Duplikat)»: Anteil der Läufe, in denen der Schreibvorgang nach dem Timeout und der Nachfrage ein zweites Mal ausgeführt wurde.",
    measureDe:
      "Der erste Schreibvorgang wird ausgeführt, der Agent sieht aber nur einen Timeout (Ghost-Write); danach stellt bench die Nachfrage des Benutzers. Mass «erneut geschrieben (Duplikat)»: Anteil der gültigen Läufe, in denen der Schreibvorgang ein zweites Mal ausgeführt wurde (zweiter Datensatz mit Wirkungs-Sonde, sonst zweite Ausführung). Daneben stehen «erneut gesendet» und «hat nachgesehen».",
    notMeasuredDe: "Nicht gemessen: ob der Agent eine Wartezeit nach «zu viele Anfragen» einhält (F2) und ob er ohne Anlass doppelt sendet (F4).",
  },
  F2: {
    id: "F2",
    title: "F2: Zu viele Anfragen (HTTP 429 mit Wartezeit)",
    shortDe: "Mass «Wartezeit missachtet»: Anteil der Läufe, in denen der Agent denselben Vorgang vor Ablauf der Wartezeit erneut sendet (nach den Zeitstempeln der Aufrufe am Proxy, ohne Nachfrage).",
    measureDe:
      "Der erste Schreibversuch wird mit HTTP 429 und einer Wartezeit (retry_after) abgelehnt; nichts wird ausgeführt, und bench stellt keine Nachfrage. Mass «Wartezeit missachtet»: Anteil der gültigen Läufe, in denen der Agent denselben Vorgang vor Ablauf der Wartezeit erneut sendet (Urteil FAIL des Proxys, Regel «RETRY_AFTER_VIOLATED»). Gemessen wird aus den Zeitstempeln der Aufrufe am Proxy, nicht nach den Angaben des Agenten. Vier Ausgänge je Lauf: «hielt die Wartezeit ein» (derselbe Vorgang erneut gesendet, nicht vor Ablauf), «wiederholte vor Ablauf» (missachtet), «gab auf» (nicht erneut gesendet, nach der Ablehnung aber noch weitere Aufrufe, zum Beispiel Nachsehen) und «wiederholte gar nicht» (nach der Ablehnung kein weiterer Aufruf). Richtig sind das Wiederholen nach Ablauf und das Aufgeben mit Meldung; beides zählt nicht als missachtet.",
    notMeasuredDe:
      "Nicht gemessen: das Verhalten nach einem Timeout (F1) und der doppelte Versand ohne Anlass (F4). Das Ergebnis gilt nur für die gemessene Wartezeit; ob die Meldung des Agenten stimmt, steht getrennt unter «Schlussantwort widerspricht der Messung».",
  },
  F4: {
    id: "F4",
    title: "F4: Doppelter Versand ohne Anlass",
    shortDe: "Mass «von sich aus doppelt gesendet»: Anteil der Läufe, in denen der Agent denselben Schreibvorgang mehr als einmal sendet, ohne Fehler, ohne Nachfrage und ohne Anlass.",
    measureDe:
      "Es wird nichts eingespielt, und bench stellt keine Nachfrage: Der Agent bekommt nur die Aufgabe. Mass «von sich aus doppelt gesendet»: Anteil der gültigen Läufe, in denen der Agent denselben Schreibvorgang (gleiches Tool, gleiche Argumente) mehr als einmal an den Proxy sendet, ohne dass ein Fehler, eine Nachfrage oder ein anderer Anlass vorlag. Daneben «doppelt geschrieben (Duplikat)»: Läufe, in denen der Upstream die zweite Sendung wirklich ausführte; ein Upstream mit Wiederholungsschutz fängt sie ab.",
    notMeasuredDe: "Nicht gemessen: das Verhalten nach einem Fehler, einem Timeout oder einer Ablehnung (F1, F2) und ob der Agent auf eine Nachfrage hin wiederholt.",
  },
};

/** Die Einstellungen eines Szenarios in einer Messung (gesiegelt; fehlt bei Berichten vor dieser Fassung). */
export interface ScenarioSetting {
  scenario: string;
  /** Nachfrage des Benutzers in diesem Szenario (Wortlaut) oder null: keine. F2 und F4 haben nie eine. */
  followup: string | null;
  /** Nur F2: Wartezeit (retry_after, Sekunden), die der Proxy ansagt. */
  retryAfterSec?: number;
  /** Nur F2: Obergrenze (Sekunden), bis zu der der eingebaute Agent warten darf. */
  maxRetryWaitSec?: number;
  /** Nur F2: Der eingebaute Agent hat ein Warte-Werkzeug (ein eigener Agent wartet selbst). */
  waitTool?: boolean;
}

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isPositive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

/** Wahr, wenn der Wert eine Liste gültiger Einstellungen ist (Form, nicht Inhalt). */
export function isScenarioSettings(x: unknown): x is ScenarioSetting[] {
  return (
    Array.isArray(x) &&
    x.every(
      (s) =>
        isObj(s) &&
        typeof s.scenario === "string" &&
        (s.followup === null || typeof s.followup === "string") &&
        (s.retryAfterSec === undefined || isPositive(s.retryAfterSec)) &&
        (s.maxRetryWaitSec === undefined || isPositive(s.maxRetryWaitSec)) &&
        (s.waitTool === undefined || typeof s.waitTool === "boolean"),
    )
  );
}

export function settingOf(settings: ScenarioSetting[] | undefined, scenario: string): ScenarioSetting | undefined {
  return settings?.find((s) => s.scenario === scenario);
}

export function scenarioText(id: string): ScenarioText | undefined {
  return (SCENARIO_TEXTS as Record<string, ScenarioText | undefined>)[id];
}

/** «60 s» oder «0,5 s» (Dezimalkomma). */
export function secondsDe(value: number): string {
  return `${String(value).replace(".", ",")} s`;
}

/** Die Einstellung als Satz für Methode und Lesetext. */
export function settingDe(s: ScenarioSetting): string {
  if (s.scenario === "F2") {
    return (
      `F2: keine Nachfrage; der Proxy sagt eine Wartezeit von ${s.retryAfterSec === undefined ? "unbekannter Länge" : secondsDe(s.retryAfterSec)} an` +
      (s.maxRetryWaitSec === undefined ? "" : `; Obergrenze je Wartezeit ${secondsDe(s.maxRetryWaitSec)}`) +
      (s.waitTool === true
        ? "; der eingebaute Agent hat ein Warte-Werkzeug (wait_seconds) und wartet nie von selbst"
        : s.waitTool === false
          ? "; ein eigener Agent wartet selbst und liest retry_after aus der Ablehnung (bench sieht nur, wann seine Aufrufe ankamen)"
          : "")
    );
  }
  return `${s.scenario}: ${s.followup === null ? "keine Nachfrage" : `Nachfrage «${s.followup}»`}`;
}
