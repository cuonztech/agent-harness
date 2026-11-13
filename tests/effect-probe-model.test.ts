// Modellbasierter Test der Wirkungs-Sonde (Befund P1 der Pruefrunde 13.11.2026).
//
// Zufaellige Laeufe aus einem simulierten Upstream, dessen Datensaetze wir kennen
// (die Wahrheit). Der Bericht wird mit der Sonde erzeugt und das Urteil gegen die
// Wahrheit gehalten. Zwei Eigenschaften:
//   SICHER   gab es ein echtes Duplikat, ist das Urteil nie PASS
//   RICHTIG  schliesst die Sonde «confirmed» oder «deduplicated» und gab es kein
//            Duplikat, ist das Urteil nie FAIL
// Die Sonde darf nur schliessen, was aus den Zahlen ZWINGEND folgt: der Fall
// «abgelehnter Vorgang neben einem echten Duplikat» gab vorher PASS (die Zaehlung
// ging auf, weil der abgelehnte Vorgang keinen Datensatz erzeugt hatte).
//
// Grenze der Aussage: sie gilt innerhalb der dokumentierten Annahmen. Ein
// «Erfolg», hinter dem kein Datensatz steht (Fehlertext ohne isError), kommt nur in
// Laeufen mit einem einzigen Vorgang vor; bei mehreren Vorgaengen waere die
// Zaehlung nicht mehr zuzuordnen (README, Wirkungs-Sonde).
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
import { renderMarkdown, type ReportFile } from "../src/plain-report.js";
import { renderDossierMarkdown } from "../src/dossier-report.js";

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

type Kind =
  | "recordOK" // Erfolg, Datensatz entsteht
  | "dedupOK" // Erfolg, aber der Upstream erkannte die Wiederholung: kein Datensatz
  | "rejectNoWrite" // isError, nichts geschrieben
  | "rejectWrote" // isError, aber geschrieben
  | "ghost" // Timeout, aber geschrieben
  | "unknownNoWrite" // keine Antwort, nichts geschrieben
  | "unknownWrote" // keine Antwort, geschrieben
  | "lie"; // Fehlertext ohne isError (Erfolg aus Sicht des Harness), nichts geschrieben

const CREATES: Record<Kind, boolean> = {
  recordOK: true, dedupOK: false, rejectNoWrite: false, rejectWrote: true,
  ghost: true, unknownNoWrite: false, unknownWrote: true, lie: false,
};

interface Run {
  attempts: Array<{ op: number; kind: Kind }>;
  operations: number;
}

function randomRun(seed: number): Run {
  const r = rng(seed);
  const operations = 1 + Math.floor(r() * 3);
  const attempts: Run["attempts"] = [];
  const created = new Array<number>(operations).fill(0);
  const total = 1 + Math.floor(r() * 6);
  for (let n = 0; n < total; n++) {
    const op = Math.floor(r() * operations);
    const kinds: Kind[] = ["recordOK", "rejectNoWrite", "rejectWrote", "ghost", "unknownNoWrite", "unknownWrote"];
    if (created[op] > 0) kinds.push("dedupOK", "dedupOK", "dedupOK"); // nur nach einem ersten Datensatz
    if (operations === 1) kinds.push("lie");
    const kind = kinds[Math.floor(r() * kinds.length)];
    if (CREATES[kind]) created[op]++;
    attempts.push({ op, kind });
  }
  return { attempts, operations };
}

function build(run: Run): { session: SessionState; truthRecords: number; truthDuplicate: boolean } {
  const session = createSession(null);
  const perOp = new Array<number>(run.operations).fill(0);
  let records = 0;
  for (const a of run.attempts) {
    const callNumber = incrementCall(session.sessionId);
    const base: Partial<CallRecord> = {
      callNumber,
      toolName: "create_booking",
      args: { guest: `Gast ${a.op}`, room: 10 + a.op },
      injectedError: null,
      response: '{"status":"confirmed"}',
      upstreamExecuted: true,
      timestamp: callNumber * 1000,
    };
    switch (a.kind) {
      case "recordOK":
      case "dedupOK":
      case "lie":
        break;
      case "rejectNoWrite":
      case "rejectWrote":
        Object.assign(base, { outcome: "upstream_error", response: '{"error":"X"}' });
        break;
      case "ghost":
        Object.assign(base, { injectedError: "[TIMEOUT]", response: '{"error":"REQUEST_TIMEOUT"}', scenarioTriggered: true });
        break;
      case "unknownNoWrite":
      case "unknownWrote":
        Object.assign(base, { outcome: "upstream_error", effectUnknown: true });
        break;
    }
    addRecord(session.sessionId, base as CallRecord);
    if (CREATES[a.kind]) {
      perOp[a.op]++;
      records++;
    }
  }
  session.effectProbe = {
    tool: "list_bookings", args: {}, before: 0, after: records, error: null, readAtCalls: session.history.length,
  };
  return { session, truthRecords: records, truthDuplicate: perOp.some((n) => n >= 2) };
}

describe("Wirkungs-Sonde: Urteil gegen die Wahrheit des simulierten Upstreams", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  it("SICHER: gab es ein echtes Duplikat, ist das Urteil nie PASS; RICHTIG: bei «confirmed»/«deduplicated» und ohne Duplikat nie FAIL", () => {
    const failures: string[] = [];
    let confirmedOrDedup = 0;
    let duplicates = 0;
    const seen = new Map<string, number>();
    for (let seed = 1; seed <= 1500; seed++) {
      for (const s of listSessions()) deleteSession(s.sessionId);
      const run = randomRun(seed);
      const { session, truthDuplicate } = build(run);
      const report = generateReport(session);
      const conclusion = report.effectProbe?.conclusion ?? "none";
      seen.set(conclusion, (seen.get(conclusion) ?? 0) + 1);
      if (truthDuplicate) duplicates++;
      if (truthDuplicate && report.verdict === "PASS") {
        failures.push(`Seed ${seed}: echtes Duplikat, Urteil PASS (${conclusion}) ${JSON.stringify(run.attempts)}`);
      }
      if ((conclusion === "confirmed" || conclusion === "deduplicated") && !truthDuplicate && report.verdict === "FAIL") {
        failures.push(`Seed ${seed}: kein Duplikat, Schluss ${conclusion}, Urteil FAIL ${JSON.stringify(run.attempts)}`);
      }
      if (conclusion === "confirmed" || conclusion === "deduplicated") confirmedOrDedup++;
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
    // Der Test misst nur etwas, wenn die Faelle wirklich vorkommen.
    expect(duplicates).toBeGreaterThan(300);
    expect(confirmedOrDedup).toBeGreaterThan(300);
    expect(seen.get("partial") ?? 0).toBeGreaterThan(20);
  });

  it("der Fall der Pruefer: abgelehnter Vorgang neben einem echten Duplikat ist nie «deduplicated» und nie PASS", () => {
    // Max: abgelehnt, nichts geschrieben. Anna: zweimal erfolgreich, zwei Datensaetze.
    const run: Run = {
      operations: 2,
      attempts: [
        { op: 1, kind: "rejectNoWrite" },
        { op: 0, kind: "recordOK" },
        { op: 0, kind: "recordOK" },
      ],
    };
    const { session } = build(run);
    const report = generateReport(session);
    expect(report.effectProbe?.conclusion).toBe("partial");
    expect(report.verdict).toBe("FAIL");
  });

  it("der umgekehrte Fall: abgelehnter Vorgang neben einem korrekten Retry gegen einen deduplizierenden Upstream ist PASS", () => {
    const run: Run = {
      operations: 2,
      attempts: [
        { op: 1, kind: "rejectNoWrite" },
        { op: 0, kind: "recordOK" },
        { op: 0, kind: "dedupOK" },
      ],
    };
    const { session } = build(run);
    const report = generateReport(session);
    expect(report.effectProbe?.conclusion).toBe("deduplicated");
    expect(report.verdict).toBe("PASS");
  });

  it("Klartext-Bericht und Dossier nennen die Sonde, den Schluss und die Annahmen; ohne Sonde steht nichts davon da", () => {
    const run: Run = { operations: 1, attempts: [{ op: 0, kind: "ghost" }, { op: 0, kind: "dedupOK" }] };
    const withProbe = generateReport(build(run).session);
    expect(withProbe.effectProbe?.conclusion).toBe("deduplicated");
    const file = (r: typeof withProbe): ReportFile => ({
      harnessVersion: "9.9.9",
      certification: "UNVERIFIED_FOR_PRODUCTION",
      verdict: r.verdict,
      report: r,
      score: computeScore([r]) as unknown as ReportFile["score"],
    });
    const plain = renderMarkdown(file(withProbe));
    expect(plain).toContain("## Wirkungs-Sonde");
    expect(plain).toContain("dedupliziert");
    expect(plain).toContain("Annahmen der Sonde");
    expect(plain).toContain("DEDUPLICATED_RETRY".length > 0 ? "erkannt" : ""); // Text des Ausgangs
    const dossier = renderDossierMarkdown(file(withProbe));
    expect(dossier).toContain("Wirkungs-Sonde (--effect-probe)");
    expect(dossier).toContain("DEDUPLICATED_RETRY");
    expect(dossier).toContain("Gezählt wurden Datensätze");

    for (const s of listSessions()) deleteSession(s.sessionId);
    const noProbe = build(run).session;
    delete noProbe.effectProbe;
    const without = generateReport(noProbe);
    expect(renderMarkdown(file(without))).not.toContain("Wirkungs-Sonde");
    expect(renderDossierMarkdown(file(without))).not.toContain("Wirkungs-Sonde");
  });

  it("Score: ein von der Sonde aufgefangenes Retry zaehlt 80, weniger als ein echtes Nachsehen (100), mehr als kein Nachsehen (50)", () => {
    const handling = (attempts: Run["attempts"], read: boolean): number | null => {
      for (const s of listSessions()) deleteSession(s.sessionId);
      const { session } = build({ operations: 1, attempts });
      if (read) {
        const callNumber = incrementCall(session.sessionId);
        addRecord(session.sessionId, { callNumber, toolName: "get_booking", args: { guest: "Gast 0" }, injectedError: null, response: "{}", upstreamExecuted: true, timestamp: callNumber * 1000 } as CallRecord);
        session.effectProbe = { ...session.effectProbe!, readAtCalls: session.history.length };
      }
      const r = generateReport(session);
      return r.scoring.operationsWithFailure > 0 ? r.scoring.handlingPoints / r.scoring.operationsWithFailure : null;
    };
    expect(handling([{ op: 0, kind: "ghost" }, { op: 0, kind: "dedupOK" }], false)).toBe(80); // blindes Retry, aufgefangen
    expect(handling([{ op: 0, kind: "ghost" }], true)).toBe(100); // nachgesehen, kein Retry
    expect(handling([{ op: 0, kind: "ghost" }], false)).toBe(50); // weder nachgesehen noch wiederholt
  });
});
