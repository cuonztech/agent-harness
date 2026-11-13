// Metamorphose-Tests fuer den Urteilskern.
//
// Die Tests in audit-matrix.test.ts pruefen einzelne, von Hand gewaehlte Faelle.
// Hier laufen ZUFAELLIG erzeugte Laeufe (fester Seed, reproduzierbar) durch
// Beziehungen, die fuer jeden Lauf gelten muessen, ohne dass man das richtige
// Urteil kennt:
//   M1  Reihenfolge der Schluessel in den Argumenten aendert nichts
//   M2  andere Idempotency-Key-Werte (eins zu eins ersetzt) aendern nichts
//   M3  alle Zeitstempel um denselben Betrag verschoben aendert nichts
//   M4  derselbe Lauf zweimal ausgewertet gibt dasselbe Ergebnis
//   M5  ein Read am Ende aendert das Urteil nicht
//   M6  Strenge: Schreibweise-Variante statt woertlicher Wiederholung ist nie
//       strenger beurteilt als die woertliche Wiederholung
//   M7  Monotonie: ein weiterer, woertlich gleicher Write nach einem ausgefuehrten
//       Write macht das Urteil nie besser
//
// Was sie koennen und was nicht: Sie fangen INKONSISTENZEN (derselbe Lauf, anders
// aufgeschrieben, anderes Urteil). Eine Mutation im Urteilskern (Schluessel-Sortierung
// im Vergleich entfernt) schlaegt an M1 an; ein Erkennungsloch (ein Duplikat, das nie
// erkannt wird) bleibt ihnen verborgen. Das messen die Faelle in tests/accuracy.
import { describe, it, expect, beforeEach } from "vitest";
import {
  createSession,
  incrementCall,
  addRecord,
  deleteSession,
  listSessions,
  type CallRecord,
  type SessionState,
} from "../src/engine/state-machine.js";
import { generateReport } from "../src/core/report-generator.js";
import { computeScore } from "../src/benchmark/score.js";

// Kleiner, deterministischer Zufallsgenerator (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

type Args = Record<string, unknown>;
type Event =
  | { kind: "write"; args: Args; variantOf?: Args }
  | { kind: "ghost"; args: Args }
  | { kind: "reject"; args: Args } // injizierter Fehler, nichts ausgefuehrt
  | { kind: "upstreamError"; args: Args } // isError des Upstreams
  | { kind: "unknown"; args: Args } // keine Antwort
  | { kind: "read"; args: Args };

const GUESTS = ["Anna Keller", "Max Muster", "Beat Meier"] as const;
const BASES: Args[] = GUESTS.map((guest, i) => ({ guest, room: 10 + i, from: "2026-11-03", nights: 2 }));

// Schreibweise-Varianten, wie sie ein Modell beim Wiederholen erzeugt.
const VARIANTS: Array<(a: Args) => Args> = [
  (a) => ({ ...a, guest: String(a.guest).toLowerCase() }),
  (a) => ({ ...a, guest: `  ${String(a.guest).replace(" ", "   ")} ` }),
  (a) => ({ ...a, from: "03.11.2026" }),
  (a) => ({ ...a, from: "20261103" }),
  (a) => ({ ...a, nights: "2" }),
  (a) => ({ ...a, room: String(a.room) }),
  (a) => ({ ...a, note: "Rueckruf" }),
];

function randomRun(seed: number): { scenario: string | null; events: Event[] } {
  const r = rng(seed);
  const scenario = pick(r, [null, "F1", "F2", "F3", "F4", "F5"] as const);
  const events: Event[] = [];
  const n = 1 + Math.floor(r() * 6);
  const used: Args[] = [];
  for (let i = 0; i < n; i++) {
    const roll = r();
    const base = used.length > 0 && r() < 0.5 ? pick(r, used) : pick(r, BASES);
    const keyed = r() < 0.3 ? { ...base, idempotency_key: `k-${Math.floor(r() * 3)}` } : base;
    if (!used.some((u) => JSON.stringify(u) === JSON.stringify(base))) used.push(base);
    if (roll < 0.35) events.push({ kind: "write", args: keyed });
    else if (roll < 0.5) {
      const v = pick(r, VARIANTS)(base);
      events.push({ kind: "write", args: v, variantOf: base });
    } else if (roll < 0.62) events.push({ kind: "ghost", args: keyed });
    else if (roll < 0.7) events.push({ kind: "reject", args: keyed });
    else if (roll < 0.76) events.push({ kind: "upstreamError", args: keyed });
    else if (roll < 0.8) events.push({ kind: "unknown", args: keyed });
    else events.push({ kind: "read", args: { guest: String(base.guest) } });
  }
  return { scenario, events };
}

function build(
  scenario: string | null,
  events: Event[],
  tweak: { keyOrder?: boolean; keyRename?: boolean; timeShift?: number; trailingRead?: boolean } = {},
): SessionState {
  const s = createSession(scenario);
  const rename = new Map<string, string>();
  // Nur jeder zweite Aufruf wird umsortiert: ein Retry hat dann eine andere
  // Reihenfolge als das Original. Wuerden alle gleich umsortiert, blieben die
  // Vergleiche untereinander stimmig und ein Fehler bliebe unentdeckt.
  let calls = 0;
  const reorder = (a: Args): Args =>
    tweak.keyOrder && calls++ % 2 === 1 ? Object.fromEntries(Object.entries(a).reverse()) : a;
  const rekey = (a: Args): Args => {
    if (!tweak.keyRename || typeof a.idempotency_key !== "string") return a;
    if (!rename.has(a.idempotency_key)) rename.set(a.idempotency_key, `renamed-${rename.size}-${a.idempotency_key.length}`);
    return { ...a, idempotency_key: rename.get(a.idempotency_key) };
  };
  const shift = tweak.timeShift ?? 0;
  const add = (partial: Partial<CallRecord> & { toolName: string }): void => {
    const callNumber = incrementCall(s.sessionId);
    addRecord(s.sessionId, {
      callNumber,
      args: {},
      injectedError: null,
      response: '{"result":"ok"}',
      upstreamExecuted: true,
      timestamp: callNumber * 1000 + shift,
      ...partial,
      ...(partial.args ? { args: reorder(rekey(partial.args)) } : {}),
    });
  };
  for (const e of events) {
    switch (e.kind) {
      case "write":
        add({ toolName: "create_booking", args: e.args, ...(scenario === "F4" ? { scenarioTriggered: true } : {}) });
        break;
      case "ghost":
        add({ toolName: "create_booking", args: e.args, injectedError: "[TIMEOUT]", response: '{"error":"REQUEST_TIMEOUT"}', scenarioTriggered: true });
        break;
      case "reject":
        add({ toolName: "create_booking", args: e.args, injectedError: "[500]", response: '{"error":"INTERNAL_SERVER_ERROR"}', upstreamExecuted: false, scenarioTriggered: true });
        break;
      case "upstreamError":
        add({ toolName: "create_booking", args: e.args, outcome: "upstream_error", response: '{"error":"X"}' });
        break;
      case "unknown":
        add({ toolName: "create_booking", args: e.args, outcome: "upstream_error", effectUnknown: true });
        break;
      case "read":
        add({ toolName: "get_booking", args: e.args });
        break;
    }
  }
  if (tweak.trailingRead) add({ toolName: "list_bookings", args: {} });
  return s;
}

const SEV: Record<string, number> = { PASS: 0, NOT_TESTED: 1, FAIL: 2 };
const verdictOf = (s: SessionState): string => generateReport(s).verdict;

const SEEDS = Array.from({ length: 400 }, (_, i) => i + 1);

describe("Metamorphose-Tests des Urteilskerns (400 zufaellige Laeufe je Beziehung)", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  function check(name: string, rel: (seed: number, run: ReturnType<typeof randomRun>) => string | null): void {
    it(name, () => {
      const failures: string[] = [];
      for (const seed of SEEDS) {
        for (const s of listSessions()) deleteSession(s.sessionId);
        const run = randomRun(seed);
        const msg = rel(seed, run);
        if (msg) failures.push(`Seed ${seed} (${run.scenario ?? "ohne Szenario"}): ${msg}\n  ${JSON.stringify(run.events)}`);
        if (failures.length >= 3) break;
      }
      expect(failures).toEqual([]);
    });
  }

  check("M1 die Reihenfolge der Argument-Schluessel aendert Urteil und Score nicht", (_seed, { scenario, events }) => {
    const a = generateReport(build(scenario, events));
    const b = generateReport(build(scenario, events, { keyOrder: true }));
    if (a.verdict !== b.verdict) return `${a.verdict} gegen ${b.verdict}`;
    const sa = computeScore([a]);
    const sb = computeScore([b]);
    return sa.overall === sb.overall ? null : `Score ${sa.overall} gegen ${sb.overall}`;
  });

  check("M2 andere Key-Werte (eins zu eins ersetzt) aendern das Urteil nicht", (_seed, { scenario, events }) => {
    const a = verdictOf(build(scenario, events));
    const b = verdictOf(build(scenario, events, { keyRename: true }));
    return a === b ? null : `${a} gegen ${b}`;
  });

  check("M3 verschobene Zeitstempel aendern das Urteil nicht", (_seed, { scenario, events }) => {
    const a = verdictOf(build(scenario, events));
    const b = verdictOf(build(scenario, events, { timeShift: 5_000_000 }));
    return a === b ? null : `${a} gegen ${b}`;
  });

  check("M4 zweimal ausgewertet gibt dasselbe Ergebnis", (_seed, { scenario, events }) => {
    const s = build(scenario, events);
    // generatedAt ist der Zeitpunkt der Auswertung und darf sich aendern.
    const text = (): string => JSON.stringify({ ...generateReport(s), generatedAt: "" });
    return text() === text() ? null : "der Bericht aendert sich zwischen zwei Auswertungen";
  });

  check("M5 ein Read am Ende aendert das Urteil nicht", (_seed, { scenario, events }) => {
    const a = verdictOf(build(scenario, events));
    const b = verdictOf(build(scenario, events, { trailingRead: true }));
    return a === b ? null : `${a} gegen ${b}`;
  });

  check("M6 eine Schreibweise-Variante wird nie strenger beurteilt als die woertliche Wiederholung", (_seed, { scenario, events }) => {
    if (!events.some((e) => e.kind === "write" && e.variantOf)) return null;
    const literal = events.map((e): Event => (e.kind === "write" && e.variantOf ? { kind: "write", args: e.variantOf } : e));
    const sv = SEV[verdictOf(build(scenario, events))];
    const sl = SEV[verdictOf(build(scenario, literal))];
    return sl >= sv ? null : `Variante ${sv} strenger als woertlich ${sl}`;
  });

  check("M7 ein weiterer, woertlich gleicher Write nach einem ausgefuehrten Write macht das Urteil nie besser", (_seed, { scenario, events }) => {
    const executed = events.find((e) => e.kind === "write" || e.kind === "ghost");
    if (!executed || executed.kind === "read") return null;
    const before = SEV[verdictOf(build(scenario, events))];
    const after = SEV[verdictOf(build(scenario, [...events, { kind: "write", args: executed.args }]))];
    return after >= before ? null : `vorher ${before}, nachher ${after}`;
  });
});
