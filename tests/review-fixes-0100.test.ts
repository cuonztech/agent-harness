// Fixes aus dem kontextfreien Test von 0.10.0 (vor der Veroeffentlichung). Jeder Test hier ist die
// Gegenprobe zu einem Befund und schlaegt ohne den Fix fehl.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "../src/proxy/interceptor.js";
import { classifyByVerbWords, nameWords, readPrefixThenWrites } from "../src/proxy/verb-words.js";
import { looksLikeErrorAnswer } from "../src/proxy/error-answer.js";
import { createSession, incrementCall, addRecord, deleteSession, listSessions, type CallRecord, type SessionState } from "../src/engine/state-machine.js";
import { generateReport } from "../src/core/report-generator.js";
import { buildCallForensics } from "../src/core/call-forensics.js";

const cfg = { writeToolPatterns: [] as string[], readToolPatterns: [] as string[] };
const tool = (name: string, description = ""): Tool => ({ name, description, inputSchema: { type: "object", properties: {} } });
const clear = (): void => { for (const s of listSessions()) deleteSession(s.sessionId); };
function add(s: SessionState, partial: Partial<CallRecord> & { toolName: string }): void {
  const callNumber = incrementCall(s.sessionId);
  addRecord(s.sessionId, { callNumber, args: {}, injectedError: null, response: "{}", upstreamExecuted: true, timestamp: callNumber * 1000, ...partial });
}

describe("Befund 1: ein Write wird nie still als Read geraten", () => {
  it("Substantive wie status, view, resolve machen ein Tool nicht zum Read", () => {
    expect(classifyByVerbWords("change_status")).toBe("write"); // change schreibt
    expect(classifyByVerbWords("increment_view_count")).toBe("write");
    expect(classifyByVerbWords("resolve_incident")).toBe("unclassified"); // resolve ist weder Schreib- noch starkes Lesewort
    expect(classifyByVerbWords("order_status")).toBe("unclassified");
    expect(classifyByVerbWords("view_orders")).toBe("unclassified");
    expect(classifyByVerbWords("count_stock")).toBe("unclassified");
  });

  it("Namen in anderen Schriften werden ganz zerlegt, nicht an Nicht-ASCII-Zeichen", () => {
    expect(nameWords("Ändern_Status")).toEqual(["ändern", "status"]);
    expect(nameWords("создать_booking")).toEqual(["создать", "booking"]);
    expect(nameWords("創建_status")).toEqual(["創建", "status"]);
    for (const n of ["Ändern_Status", "создать_booking", "創建_status"]) {
      expect(classifyByVerbWords(n), n).toBe("unclassified");
    }
  });

  it("starke Lese-Verben ordnen weiter als Read ein", () => {
    for (const n of ["slack_get_users", "API-retrieve-a-page", "kubectl_describe", "web_fetch_exa", "subscription_list", "elastic_search_docs"]) {
      expect(classifyByVerbWords(n), n).toBe("read");
    }
  });

  it("die Beschreibung ist ein zweiter Zeuge: widerspricht sie der Vermutung, bleibt das Tool unklar", () => {
    expect(classifyByVerbWords("commit_history")).toBe("write"); // nur der Name: Vermutung
    expect(classifyByVerbWords("commit_history", "Returns the commit history of a branch.")).toBe("unclassified");
    expect(classifyByVerbWords("close_price", "Gets the closing price of a stock.")).toBe("unclassified");
    expect(classifyByVerbWords("sync_state", "Read-only view of the sync state.")).toBe("unclassified");
    expect(classifyByVerbWords("fetch_feedback", "Submit feedback about a search result.")).toBe("unclassified");
    expect(classifyByVerbWords("slack_post_message", "Post a new message to a Slack channel")).toBe("write");
  });

  it("firecrawl_search_feedback: mit Beschreibung unklar (vorher still als Read), ohne Beschreibung eine benannte Vermutung", () => {
    expect(classifyUpstreamTool(tool("firecrawl_search_feedback", "Submit feedback about a search result so the results improve."), cfg).class).toBe("unclassified");
    expect(classifyUpstreamTool(tool("firecrawl_search_feedback"), cfg)).toMatchObject({ class: "read", source: "verb word in name", guess: true });
  });

  it("jede geratene Einordnung ist als Vermutung markiert, bisher Eingeordnetes nicht", () => {
    expect(classifyUpstreamTool(tool("slack_post_message"), cfg).guess).toBe(true);
    expect(classifyUpstreamTool(tool("create_booking"), cfg).guess).toBeUndefined();
    expect(classifyUpstreamTool(tool("get_booking"), cfg).guess).toBeUndefined();
  });

  it("der Bericht nennt ein aufgerufenes, nur geratenes Tool", () => {
    clear();
    const s = createSession(null);
    s.verbWordGuesses = new Set(["slack_post_message", "slack_other"]);
    add(s, { toolName: "slack_post_message", args: { text: "a" } });
    const notes = generateReport(s).coverage.notes.join("\n");
    expect(notes).toContain("Classification by name only (a guess): slack_post_message was classified");
    expect(notes).not.toContain("slack_other");
  });
});

describe("Befund 2: get_or_create_user und Verwandte", () => {
  it.each(["get_or_create_user", "read_and_delete", "fetch_and_store", "search_and_replace", "list_then_cancel"])("%s bleibt unklar, kein stiller Read", (name) => {
    expect(readPrefixThenWrites(name)).toBe(true);
    expect(classifyUpstreamTool(tool(name), cfg).class).toBe("unclassified");
  });
  it("Lese-Namen mit «and» ohne folgendes Schreibverb bleiben Reads", () => {
    for (const n of ["list_users_and_groups", "get_name_or_id", "search_and_filter_results"]) {
      expect(readPrefixThenWrites(n), n).toBe(false);
      expect(classifyUpstreamTool(tool(n), cfg).class, n).toBe("read");
    }
  });
  it("mit eigenen --write-tools entscheidet der Aufrufer (get_or_create bleibt, was die Muster sagen)", () => {
    expect(classifyUpstreamTool(tool("get_or_create_user"), { writeToolPatterns: ["zzz_*"], readToolPatterns: [] }).class).toBe("read");
  });
});

describe("Befunde 5 und 6: Fehlerformen und Fehlalarme", () => {
  it("bekannte Luecke: ein Fehlertext ohne Marker am Anfang wird nicht erkannt", () => {
    expect(looksLikeErrorAnswer("Die Buchung wurde abgelehnt, das Zimmer ist belegt.")).toBe(false);
    expect(looksLikeErrorAnswer("Zimmer belegt")).toBe(false);
  });

  it.each([
    "Request failed with status code 500", "Not found", "Sorry, that room is taken", "Rejected: room taken", "Unfortunately the booking failed",
    "Nicht gefunden", "Leider nicht möglich", "Abgelehnt: Zimmer belegt",
    '{"statusCode":409}', '{"status":404}', '{"code":500,"message":"x"}', '{"errorMessage":"boom"}', '{"error_message":"boom"}',
    '{"result":{"error":"x"}}', '{"data":{"success":false}}', '{"status":"rejected"}', '{"status":"declined"}', '{"ok":0}',
  ])("erkannt: %s", (t) => expect(looksLikeErrorAnswer(t)).toBe(true));

  it.each([
    '{"id":1,"error":0}', '{"error":"none"}', '{"error":{}}', '{"error":""}', '{"errors":[]}', '{"status":"confirmed","error":null}',
    "Error: none. Booking B-1 created", "Error: 0", "Error handling summary: 0 problems", "Error handling was skipped",
    "Booking confirmed. No errors.", '{"status":200}', '{"code":201}', "ok",
  ])("nicht erkannt: %s", (t) => expect(looksLikeErrorAnswer(t)).toBe(false));
});

describe("Befund 7: respelltes Retry nach isError-nach-Schreiben bleibt mit Sonde ein Verdacht", () => {
  it("zwei Datensaetze fuer zwei Versuche (confirmed), der zweite nur anders geschrieben → NOT_TESTED, nicht PASS", () => {
    clear();
    const s = createSession(null);
    add(s, { toolName: "create_booking", args: { guest: "Muster", room: 1 }, outcome: "upstream_error", response: '{"error":"MAIL_FAILED"}' }); // schrieb, meldete isError
    add(s, { toolName: "create_booking", args: { guest: "muster ", room: 1 } });
    s.effectProbe = { tool: "list_bookings", args: {}, before: 0, after: 2, error: null, readAtCalls: s.history.length };
    const r = generateReport(s);
    expect(r.effectProbe?.conclusion).toBe("confirmed");
    expect(r.verdict).toBe("NOT_TESTED");
    expect(r.observations.map((o) => o.type)).toContain("LOOKALIKE_WRITE_AFTER_SUCCESS");
  });
});

describe("Befunde 8 und 9: die Zeitleiste widerspricht Bericht und Sonde nicht", () => {
  it("von der Sonde als aufgefangen erkanntes Retry heisst nicht «Doppelausfuehrung»", () => {
    clear();
    const s = createSession("F1");
    const args = { guest: "Anna", room: 1, idempotency_key: "k" };
    add(s, { toolName: "create_booking", args, injectedError: "[TIMEOUT]", response: '{"error":"REQUEST_TIMEOUT"}', scenarioTriggered: true });
    add(s, { toolName: "create_booking", args });
    s.effectProbe = { tool: "list_bookings", args: {}, before: 0, after: 1, error: null, readAtCalls: s.history.length };
    const f = buildCallForensics(s);
    expect(f.entries[1].summaryDe).toContain("keinen neuen Datensatz");
    expect(f.entries[1].summaryDe).not.toContain("Doppelausführung");
  });

  it("ein Retry mit nur einem geaenderten Feld sagt «moegliche Doppelausfuehrung», nicht «Doppelausfuehrung»", () => {
    clear();
    const s = createSession("F1");
    add(s, { toolName: "create_booking", args: { guest: "Muster", room: 1, date: "2026-11-03" }, injectedError: "[TIMEOUT]", scenarioTriggered: true });
    add(s, { toolName: "create_booking", args: { guest: "Meier", room: 1, date: "2026-11-03" } });
    const t = buildCallForensics(s).entries[1].summaryDe;
    expect(t).toContain("mögliche Doppelausführung");
    expect(t).toContain("Wiederholung von Aufruf #1");
  });

  it("gleiche Argumente bleiben «Doppelausfuehrung»", () => {
    clear();
    const s = createSession("F4");
    const args = { guest: "Anna", room: 1 };
    add(s, { toolName: "create_booking", args, scenarioTriggered: true });
    add(s, { toolName: "create_booking", args, scenarioTriggered: true });
    expect(buildCallForensics(s).entries[1].summaryDe).toBe("Wiederholung von Aufruf #1: erneut im Zielsystem ausgeführt (Doppelausführung).");
  });
});

describe("Befund 11: doctor kennt --upstream-env-var und --upstream-env", () => {
  function runDoctor(args: string[]): Promise<{ out: string; code: number | null }> {
    const env = { ...process.env };
    delete env.HARNESS_NEEDS_ENV;
    const child = spawn(process.execPath, ["dist/index.js", "doctor", "--upstream-command", process.execPath, "--upstream-arg", "tests/fixtures/upstream-needs-env.mjs", ...args], { env });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    return new Promise((res) => child.on("exit", (code) => res({ out, code })));
  }
  it("--upstream-env-var KEY=VALUE reicht die Variable an den Upstream", async () => {
    const r = await runDoctor(["--upstream-env-var", "HARNESS_NEEDS_ENV=1"]);
    expect(r.out).toContain("Upstream-Server startet und antwortet");
    expect(r.out).not.toContain("Unbekannte Option");
  }, 40_000);
  it("--upstream-env K=V,K2=V2", async () => {
    const r = await runDoctor(["--upstream-env", "OTHER=1,HARNESS_NEEDS_ENV=1"]);
    expect(r.out).toContain("Upstream-Server startet und antwortet");
  }, 40_000);
  it("ein Eintrag ohne = wird abgelehnt", async () => {
    const r = await runDoctor(["--upstream-env-var", "NOEQUALS"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Option(en) ohne Wert");
  }, 40_000);
});
