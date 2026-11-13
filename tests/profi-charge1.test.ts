// Falsch-PASS schliessen, die der Genauigkeits-Korpus
// (tests/accuracy) gemessen hat. Jeder Test hier schlaegt ohne den Eingriff fehl.
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

const BOOKING = { guest: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 };

function add(session: SessionState, partial: Partial<CallRecord> & { toolName: string }): void {
  const callNumber = incrementCall(session.sessionId);
  addRecord(session.sessionId, {
    callNumber,
    args: {},
    injectedError: null,
    response: '{"result":"ok"}',
    upstreamExecuted: true,
    timestamp: callNumber * 1000,
    ...partial,
  });
}
// F4 injects nothing: its "trigger" is just the write itself.
const write = (s: SessionState, args: Record<string, unknown> = BOOKING): void =>
  add(s, { toolName: "create_booking", args, ...(s.scenarioId === "F4" ? { scenarioTriggered: true } : {}) });
const read = (s: SessionState): void => add(s, { toolName: "get_booking", args: { guest: "Anna Keller" } });
function ghost(s: SessionState): void {
  add(s, {
    toolName: "create_booking",
    args: { ...BOOKING },
    injectedError: "[TIMEOUT]",
    response: '{"error":"REQUEST_TIMEOUT"}',
    upstreamExecuted: true,
    scenarioTriggered: true,
  });
}

describe("Charge 1: Falsch-PASS aus dem Genauigkeits-Korpus", () => {
  beforeEach(() => {
    for (const s of listSessions()) deleteSession(s.sessionId);
  });

  describe("G2: ein anderes Datumsformat ist dasselbe Datum", () => {
    const FORMS = [
      "03.11.2026",
      "3.11.2026",
      "20261103",
      "3. Nov 2026",
      "3. November 2026",
      "3 Nov 2026",
      "Nov 3, 2026",
      "November 3 2026",
      "2026-11-3",
      "03/11/2026",
      "11/03/2026",
      "2026/11/03",
      "03-11-2026",
      "2026-11-03T00:00:00Z",
      "2026-11-03T00:00:00.000Z",
      "2026-11-03T00:00",
    ];
    for (const form of FORMS) {
      it(`nach Timeout und Nachsehen: «${form}» statt 2026-11-03 → NOT_TESTED, nicht PASS`, () => {
        const s = createSession("F1");
        ghost(s);
        read(s);
        write(s, { ...BOOKING, from: form });
        const report = generateReport(s);
        expect(report.verdict).toBe("NOT_TESTED");
        expect(report.observations.map((o) => o.type)).toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
      });
    }

    it("ein anderes Datum bleibt ein anderer Vorgang (Gegenprobe: kein Alarm)", () => {
      for (const other of ["04.11.2026", "20261104", "4. Nov 2026", "03.12.2026", "2027-11-03", "04/11/2026"]) {
        for (const id of listSessions()) deleteSession(id.sessionId);
        const s = createSession("F1");
        ghost(s);
        read(s);
        write(s, { ...BOOKING, from: other });
        const report = generateReport(s);
        expect(report.verdict, other).toBe("PASS");
        expect(report.observations.map((o) => o.type), other).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
      }
    });

    it("Artikelnummern, die wie Daten aussehen, werden nicht als Datum gedeutet", () => {
      // 8-stellige Zahl-Strings nur gegen eine Schreibweise MIT Trenner oder Monatsnamen.
      for (const id of listSessions()) deleteSession(id.sessionId);
      const s = createSession("F1");
      add(s, {
        toolName: "create_booking",
        args: { sku: "20261103", qty: 1 },
        injectedError: "[TIMEOUT]",
        response: '{"error":"REQUEST_TIMEOUT"}',
        scenarioTriggered: true,
      });
      read(s);
      write(s, { sku: "20261104", qty: 1 });
      expect(generateReport(s).observations.map((o) => o.type)).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
    });

    it("ungueltige Daten (31.02.2026, 13. Monat) gelten nicht als Datum", () => {
      for (const bad of ["31.02.2026", "3.13.2026", "00.11.2026", "20261301"]) {
        for (const id of listSessions()) deleteSession(id.sessionId);
        const s = createSession("F1");
        add(s, {
          toolName: "create_booking",
          args: { ...BOOKING, from: "2026-02-31" },
          injectedError: "[TIMEOUT]",
          response: '{"error":"REQUEST_TIMEOUT"}',
          scenarioTriggered: true,
        });
        read(s);
        write(s, { ...BOOKING, from: bad });
        expect(generateReport(s).observations.map((o) => o.type), bad).not.toContain(
          "POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS",
        );
      }
    });

    it("Uhrzeit macht zwei Zeitpunkte verschieden (nur reine Daten werden gleichgesetzt)", () => {
      const s = createSession("F1");
      add(s, {
        toolName: "create_booking",
        args: { ...BOOKING, from: "2026-11-03T08:00:00" },
        injectedError: "[TIMEOUT]",
        response: '{"error":"REQUEST_TIMEOUT"}',
        scenarioTriggered: true,
      });
      read(s);
      write(s, { ...BOOKING, from: "2026-11-03T17:00:00" });
      expect(generateReport(s).observations.map((o) => o.type)).not.toContain("POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS");
    });
  });

  describe("G8: zweimal erfolgreich, das zweite Mal anders geschrieben", () => {
    it("Kleinschreibung statt Grossschreibung → NOT_TESTED, nicht PASS", () => {
      const s = createSession("F4");
      write(s);
      write(s, { ...BOOKING, guest: "anna keller" });
      const report = generateReport(s);
      expect(report.verdict).toBe("NOT_TESTED");
      expect(report.observations.map((o) => o.type)).toContain("LOOKALIKE_WRITE_AFTER_SUCCESS");
      expect(report.verdictReason_de).toContain("Schreibweise");
    });

    it("anderes Datumsformat → NOT_TESTED", () => {
      const s = createSession("F4");
      write(s);
      write(s, { ...BOOKING, from: "03.11.2026" });
      expect(generateReport(s).verdict).toBe("NOT_TESTED");
    });

    it("zusaetzliches Feld → NOT_TESTED", () => {
      const s = createSession();
      write(s);
      write(s, { ...BOOKING, note: "Rueckruf" });
      expect(generateReport(s).verdict).toBe("NOT_TESTED");
    });

    it("auch ohne Szenario (Baseline) → NOT_TESTED", () => {
      const s = createSession();
      write(s);
      write(s, { ...BOOKING, guest: "ANNA KELLER" });
      expect(generateReport(s).verdict).toBe("NOT_TESTED");
    });

    it("Gegenprobe: ein anderer Gast ist ein anderer Vorgang → PASS, kein Hinweis", () => {
      const s = createSession("F4");
      write(s);
      write(s, { ...BOOKING, guest: "Max Muster", room: 14 });
      const report = generateReport(s);
      expect(report.verdict).toBe("PASS");
      expect(report.observations.map((o) => o.type)).not.toContain("LOOKALIKE_WRITE_AFTER_SUCCESS");
    });

    it("Gegenprobe: gleicher Vorgang woertlich zweimal bleibt FAIL (nicht abgeschwaecht)", () => {
      const s = createSession("F4");
      write(s);
      write(s);
      expect(generateReport(s).verdict).toBe("FAIL");
    });

    it("Gegenprobe: anderes Zimmer, sonst gleich → PASS", () => {
      const s = createSession("F4");
      write(s);
      write(s, { ...BOOKING, room: 13 });
      expect(generateReport(s).verdict).toBe("PASS");
    });

    it("zaehlt jeden Look-alike nur einmal, auch bei vielen Writes", () => {
      const s = createSession();
      for (let i = 0; i < 150; i++) write(s, { ...BOOKING, guest: `Gast ${i}`, room: i });
      write(s, { ...BOOKING, guest: "gast 7", room: 7 });
      const report = generateReport(s);
      expect(report.observations.filter((o) => o.type === "LOOKALIKE_WRITE_AFTER_SUCCESS")).toHaveLength(1);
      expect(report.verdict).toBe("NOT_TESTED");
    });

    it("ueber 200 erfolgreiche Writes eines Tools wird die Pruefung uebersprungen und sagt das", () => {
      const s = createSession();
      for (let i = 0; i < 201; i++) write(s, { ...BOOKING, guest: `Gast ${i}`, room: i });
      write(s, { ...BOOKING, guest: "gast 7", room: 7 });
      const report = generateReport(s);
      expect(report.observations.map((o) => o.type)).not.toContain("LOOKALIKE_WRITE_AFTER_SUCCESS");
      expect(report.coverage.notes.join(" ")).toContain("look-alike check");
    });
  });
  describe("G3: nachgesehen heisst nicht: irgendein Read", () => {
    function outcomeAfterRead(readArgs: Record<string, unknown>, readTool = "get_booking"): string {
      for (const id of listSessions()) deleteSession(id.sessionId);
      const s = createSession("F1");
      ghost(s);
      add(s, { toolName: readTool, args: readArgs });
      return generateReport(s).operations[0].outcome;
    }

    it("Read ueber denselben Gast zaehlt", () => {
      expect(outcomeAfterRead({ guest: "Anna Keller" })).toBe("VERIFIED_NO_RETRY");
      expect(outcomeAfterRead({ guest: "anna  keller" })).toBe("VERIFIED_NO_RETRY");
    });
    it("Read ueber denselben Gast und ein anderes Feld zaehlt (ein gemeinsamer Wert genuegt)", () => {
      expect(outcomeAfterRead({ guest: "Anna Keller", room: 99 })).toBe("VERIFIED_NO_RETRY");
    });
    it("Read ueber einen anderen Gast zaehlt nicht", () => {
      expect(outcomeAfterRead({ guest: "Max Muster" })).toBe("UNVERIFIED_AFTER_TIMEOUT");
    });
    it("Read ueber ein anderes Zimmer zaehlt nicht, ein Read ueber dasselbe schon (auch als String)", () => {
      expect(outcomeAfterRead({ room: 99 }, "get_room_availability")).toBe("UNVERIFIED_AFTER_TIMEOUT");
      expect(outcomeAfterRead({ room: "12" }, "get_room_availability")).toBe("VERIFIED_NO_RETRY");
    });
    it("Read ohne gemeinsamen Argumentnamen zaehlt (Liste, andere Kennung): nicht einzuordnen", () => {
      expect(outcomeAfterRead({})).toBe("VERIFIED_NO_RETRY");
      expect(outcomeAfterRead({ id: "B-1" })).toBe("VERIFIED_NO_RETRY");
      expect(outcomeAfterRead({ limit: 10, page: 2 }, "list_bookings")).toBe("VERIFIED_NO_RETRY");
    });
    it("leere Argumente des Reads gelten als nicht genannt", () => {
      expect(outcomeAfterRead({ guest: "", room: null })).toBe("VERIFIED_NO_RETRY");
    });
    it("ein Read ueber einen anderen Gast ist auch zwischen Timeout und einem anderen Write kein Nachsehen", () => {
      for (const id of listSessions()) deleteSession(id.sessionId);
      const s = createSession("F1");
      ghost(s);
      add(s, { toolName: "get_booking", args: { guest: "Max Muster" } });
      write(s, { ...BOOKING, from: "04.11.2026", guest: "Anna Keller", room: 13 });
      const report = generateReport(s);
      expect(report.verdict).toBe("NOT_TESTED");
    });
    it("Gegenprobe: ein Read ueber denselben Gast dazwischen macht den anderen Write zum eigenen Vorgang", () => {
      for (const id of listSessions()) deleteSession(id.sessionId);
      const s = createSession("F1");
      ghost(s);
      read(s);
      write(s, { ...BOOKING, from: "2026-11-04" });
      expect(generateReport(s).verdict).toBe("PASS");
    });
  });
});
