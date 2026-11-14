// Befunde der Lückensuche (docs/LUECKEN-NAMEN.md) und ihre Behebung in 0.11.0:
//   G1 schwaches Lese-Präfix + Schreib-Verb (check_in_guest, status_change)
//   G2 Grossschreibung (CHECKOUT_BOOKING war ein Read, checkout_booking nicht)
//   G3 Schreib-Wortliste: alltägliche englische Verben, Deutsch/Französisch/Spanisch
//   G4 die Beschreibung hebt einen unklaren Namen auf Write (nie auf Read)
// Jeder Fall hat eine Gegenprobe: ein Lese-Tool darf dadurch nicht kippen.
import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "../src/proxy/interceptor.js";
import { isReadTool } from "../src/engine/state-machine.js";
import { classifyByVerbWords, plainWord } from "../src/proxy/verb-words.js";
import { descriptionOpensWithWriteVerb } from "../src/proxy/classification-doubt.js";
import { createSession, incrementCall, addRecord, deleteSession, listSessions, DEFAULT_KEY_FIELDS, isKeyField, type CallRecord, type SessionState } from "../src/engine/state-machine.js";
import { generateReport } from "../src/core/report-generator.js";

const cfg = { writeToolPatterns: [] as string[], readToolPatterns: [] as string[] };
const tool = (name: string, description?: string): Tool => ({ name, description, inputSchema: { type: "object", properties: {} } });
const cls = (name: string, description?: string): string => classifyUpstreamTool(tool(name, description), cfg).class;

describe("G2: Grossschreibung", () => {
  it("ein Name in Grossbuchstaben hat keine camelCase-Grenze", () => {
    expect(isReadTool("CHECKOUT_BOOKING")).toBe(false);
    expect(isReadTool("STATUSUPDATE")).toBe(false);
    expect(cls("CHECKOUT_BOOKING")).toBe("write");
  });
  it("Gegenprobe: echte Lese-Namen bleiben Reads, in jeder Schreibweise", () => {
    for (const n of ["get_booking", "GET_BOOKING", "getBooking", "GetBooking", "LIST_USERS", "list-users", "STATUS", "GET"]) {
      expect(isReadTool(n), n).toBe(true);
    }
  });
});

describe("G1: schwaches Lese-Präfix, danach ein Schreib-Verb", () => {
  it.each(["check_in_guest", "check_out", "checkInGuest", "status_change", "status_set", "StatusUpdate", "count_and_increment_views"])(
    "%s ist kein Read mehr",
    (name) => {
      expect(["write", "unclassified"]).toContain(cls(name));
      expect(cls(name)).not.toBe("read");
    },
  );
  it("check_in, check_out und status_change sind eine benannte Vermutung (Write)", () => {
    for (const n of ["check_in_guest", "check_out", "status_change", "status_set"]) {
      expect(classifyUpstreamTool(tool(n), cfg)).toMatchObject({ class: "write", guess: true });
    }
  });
  it("die Beschreibung ist Gegenzeuge: «Returns …» ohne Schreib-Verb macht es unklar, nicht Write", () => {
    expect(cls("status_set", "Returns the status flag that was set last.")).toBe("unclassified");
    expect(cls("check_in_guest", "Checks a guest in and bills the first night.")).toBe("write");
  });
  it("Gegenprobe: Reads mit schwachem Präfix bleiben Reads", () => {
    for (const n of ["check_stock", "status", "status_page", "count_orders", "view_details", "verify_signature", "check_order", "view_order", "count_order"]) {
      expect(cls(n), n).toBe("read");
    }
  });
});

describe("G3: Wortliste", () => {
  it.each(["activate_user", "trigger_build", "execute_job", "dispatch_order", "notify_customer", "retry_payment", "finalize_invoice", "sell_item", "ship_order"])(
    "%s (englisch, bisher unklar) ist ein Write",
    (name) => expect(cls(name)).toBe("write"),
  );
  it.each([
    "buchung_erstellen", "Buchung_löschen", "buchungLoeschen", "erstelle_buchung", "rechnung_senden", "kunde_anlegen",
    "supprimer_facture", "creer_commande", "annuler_reservation", "crear_pedido", "eliminar_usuario", "enviar_mensaje",
  ])("%s (Deutsch, Französisch, Spanisch) ist ein Write", (name) => expect(cls(name)).toBe("write"));
  it("Umlaute und Umschrift sind dasselbe Wort", () => {
    expect(plainWord("löschen")).toBe(plainWord("loeschen"));
    expect(plainWord("créer")).toBe("creer");
    expect(classifyByVerbWords("Ändern_Status")).toBe("write");
  });
  it("mehrdeutige Wörter (Nomen und Verb) zählen nur an Verb-Position", () => {
    expect(cls("order_create")).toBe("write"); // create entscheidet
    expect(cls("ship_order")).toBe("write"); // ship vorn
    expect(cls("explain_invoice")).toBe("unclassified"); // invoice ist hier das Objekt
    expect(cls("download_record")).toBe("unclassified");
    expect(cls("order_status")).toBe("unclassified");
    expect(cls("tag_list")).toBe("read");
    expect(cls("order.check")).toBe("unclassified");
  });
  it("französische und spanische Imperative sind Nomen (commande, reserva): nur der Infinitiv zählt", () => {
    expect(cls("comparer_commande")).toBe("unclassified");
    expect(cls("calcular_reserva")).toBe("unclassified");
    expect(cls("commande_liste")).not.toBe("write");
    expect(cls("reserva_pendiente")).toBe("unclassified");
  });
  it("deutsche Imperative zählen vorn: erstelle_buchung ja, buchung_erstelle nein", () => {
    expect(cls("erstelle_buchung")).toBe("write");
    expect(cls("sende_nachricht")).toBe("write");
  });
  it("Gegenprobe: deutsche, französische und spanische Lese-Verben ergeben einen Read", () => {
    for (const n of ["buchung_lesen", "factures_lister", "buscar_usuario", "kunden_suchen"]) {
      expect(cls(n), n).toBe("read");
    }
  });
  it("ein Name mit Schreib- und Lese-Verb bleibt unklar", () => {
    expect(cls("buchung_lesen_und_loeschen")).toBe("unclassified");
    expect(cls("API-post-search")).toBe("unclassified");
  });
});

describe("G4: die Beschreibung hebt unklar auf Write, nie auf Read", () => {
  it("beginnt sie mit einem Schreib-Verb, ist ein sonst unklares Tool ein Write (benannte Vermutung)", () => {
    expect(classifyUpstreamTool(tool("union_tool", "Creates a union of two polygons."), cfg)).toMatchObject({
      class: "write", source: "description opens with a write verb", guess: true,
    });
    expect(cls("zorp", "Löscht einen Eintrag dauerhaft.")).toBe("write");
    expect(cls("zorp", "Update the record.")).toBe("write");
  });
  it("Gegenproben: Lese-Beschreibungen, Verneinung und fehlende Beschreibung ändern nichts", () => {
    expect(cls("zorp", "Returns the current record.")).toBe("unclassified");
    expect(cls("zorp", "Updates nothing; only returns the record.")).toBe("unclassified");
    expect(cls("zorp", "Creates nothing. Read-only.")).toBe("unclassified");
    expect(cls("zorp", "The booking tool.")).toBe("unclassified");
    expect(cls("zorp")).toBe("unclassified");
  });
  it("aus Prosa wird nie ein Read abgeleitet", () => {
    expect(cls("zorp", "Gets the current record.")).toBe("unclassified");
    expect(cls("zorp", "Lists all records.")).toBe("unclassified");
  });
  it("eigene --write-tools/--read-tools schalten die Beschreibungs-Regel ab", () => {
    const c = classifyUpstreamTool(tool("zorp", "Creates a thing."), { writeToolPatterns: ["other_*"], readToolPatterns: [] });
    expect(c.class).toBe("unclassified");
  });
  it("descriptionOpensWithWriteVerb: nur der erste Satz, nur ganz vorn", () => {
    expect(descriptionOpensWithWriteVerb("Creates a booking.")).toBe(true);
    expect(descriptionOpensWithWriteVerb("Returns a booking. Creates nothing.")).toBe(false);
    expect(descriptionOpensWithWriteVerb("Use this to create a booking.")).toBe(false);
  });
});

describe("kein stilles Write-als-Read in einer festen Auswahl", () => {
  it("diese Schreib-Tools gelten nie als Read", () => {
    const names = ["check_in_guest", "check_out", "checkout_cart", "CHECKOUT_CART", "status_change", "status_set", "get_or_create_user", "read_and_delete", "count_and_increment"];
    for (const n of names) expect(cls(n), n).not.toBe("read");
  });
});

describe("Lesen-dann-Schreiben (get_or_create_user): eine Write-Vermutung statt unklar", () => {
  it.each(["get_or_create_user", "read_and_delete_message", "list_and_clear_queue", "fetch_and_lock_job", "search_and_replace", "lookup_or_register_device", "peek_and_ack", "count_and_increment", "view_and_mark_read"])(
    "%s",
    (name) => expect(classifyUpstreamTool(tool(name), cfg)).toMatchObject({ class: "write", guess: true }),
  );
  it("Gegenproben: ohne Schreib-Verb nach and/or/then bleibt es ein Read, «read-only» macht es unklar", () => {
    for (const n of ["list_users_and_groups", "get_name_or_id", "search_and_filter_results"]) expect(cls(n), n).toBe("read");
    expect(cls("get_or_create_user", "Read-only lookup. Never changes anything.")).toBe("unclassified");
  });
});

const clear = (): void => { for (const x of listSessions()) deleteSession(x.sessionId); };
function add(s: SessionState, partial: Partial<CallRecord> & { toolName: string }): void {
  const callNumber = incrementCall(s.sessionId);
  addRecord(s.sessionId, { callNumber, args: {}, injectedError: null, response: "{}", upstreamExecuted: true, timestamp: callNumber * 1000, toolClass: "write", outcome: "success", ...partial });
}
const BOOKING = { guest: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 };
const TIMEOUT: Partial<CallRecord> = { outcome: "injected_failure", injectedError: "timeout", tookEffect: true, upstreamExecuted: true };

describe("ein klar anderer Vorgang nach einem Timeout ist kein Verdacht", () => {
  it("anderer Gast, Zimmer, Datum und Dauer: PASS statt NOT_TESTED", () => {
    clear();
    const s = createSession(null);
    add(s, { toolName: "create_booking", args: BOOKING, ...TIMEOUT });
    add(s, { toolName: "create_booking", args: { guest: "Max Muster", room: 14, from: "2026-12-01", nights: 5 } });
    const r = generateReport(s);
    expect(r.verdict).toBe("PASS");
    expect(r.observations.some((o) => o.type === "OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT")).toBe(false);
  });
  it("Gegenprobe: nur der Betrag oder ein Teil geändert, der Rest gleich: bleibt NOT_TESTED", () => {
    clear();
    const s = createSession(null);
    add(s, { toolName: "create_booking", args: BOOKING, ...TIMEOUT });
    add(s, { toolName: "create_booking", args: { ...BOOKING, nights: 3 } });
    expect(generateReport(s).verdict).toBe("NOT_TESTED");
  });
  it("Gegenprobe: ein einziges gemeinsames Feld mit anderem Wert reicht nicht (Verdacht bleibt)", () => {
    clear();
    const s = createSession(null);
    add(s, { toolName: "pay", args: { amount: 100 }, ...TIMEOUT });
    add(s, { toolName: "pay", args: { amount: 200 } });
    expect(generateReport(s).verdict).toBe("NOT_TESTED");
  });
  it("Gegenprobe: ein gleicher Wert unter den gemeinsamen Feldern (gleicher Gast) bleibt Verdacht", () => {
    clear();
    const s = createSession(null);
    add(s, { toolName: "create_booking", args: BOOKING, ...TIMEOUT });
    add(s, { toolName: "create_booking", args: { guest: "Anna Keller", room: 14, from: "2026-12-01", nights: 5 } });
    expect(generateReport(s).verdict).toBe("NOT_TESTED");
  });
});

describe("Standard-Key-Felder (request_id, client_token, nonce ...)", () => {
  it("die Namen werden unabhängig von Gross-/Kleinschreibung und Trennzeichen erkannt", () => {
    for (const n of ["idempotency_key", "request_id", "requestId", "client_token", "clientToken", "nonce", "dedupe_key"]) {
      expect(isKeyField(n, DEFAULT_KEY_FIELDS), n).toBe(true);
    }
    for (const n of ["guest", "room", "id", "order_id", "token"]) expect(isKeyField(n, DEFAULT_KEY_FIELDS), n).toBe(false);
  });
  it("ein Retry unter neuem request_id ist derselbe Vorgang: Duplikat, FAIL", () => {
    clear();
    const s = createSession("F1");
    add(s, { toolName: "create_booking", args: { ...BOOKING, request_id: "r1" }, ...TIMEOUT });
    add(s, { toolName: "create_booking", args: { ...BOOKING, request_id: "r2" } });
    expect(generateReport(s).verdict).toBe("FAIL");
  });
  it("Gegenprobe: zwei Gäste mit verschiedenem request_id sind zwei Vorgänge, PASS", () => {
    clear();
    const s = createSession(null);
    add(s, { toolName: "create_booking", args: { ...BOOKING, request_id: "r1" } });
    add(s, { toolName: "create_booking", args: { guest: "Max Muster", room: 14, from: "2026-12-01", nights: 5, request_id: "r2" } });
    expect(generateReport(s).verdict).toBe("PASS");
  });
});
