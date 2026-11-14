// Einordnung nach dem Verb im Namen (src/proxy/verb-words.ts) und Erkennung einer
// Erfolgsantwort, die wie ein Fehler aussieht (src/proxy/error-answer.ts). Beides ist an echten
// MCP-Servern gemessen (docs/MESSUNG-ECHTE-SERVER.md); hier die Regeln.
import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "../src/proxy/interceptor.js";
import { classifyByVerbWords, nameWords } from "../src/proxy/verb-words.js";
import { looksLikeErrorAnswer } from "../src/proxy/error-answer.js";

const cfg = { writeToolPatterns: [] as string[], readToolPatterns: [] as string[] };
const tool = (name: string, annotations?: Tool["annotations"]): Tool => ({
  name,
  description: "",
  inputSchema: { type: "object", properties: {} },
  ...(annotations ? { annotations } : {}),
});

describe("Verb im Namen (nur fuer Tools, die sonst nicht einzuordnen waeren)", () => {
  it("zerlegt Namen in Woerter (snake, kebab, camelCase, Gross-/Kleinschreibung)", () => {
    expect(nameWords("slack_post_message")).toEqual(["slack", "post", "message"]);
    expect(nameWords("API-post-page")).toEqual(["api", "post", "page"]);
    expect(nameWords("slackPostMessage")).toEqual(["slack", "post", "message"]);
    expect(nameWords("kubectl.apply")).toEqual(["kubectl", "apply"]);
  });

  it.each([
    ["slack_post_message", "write"],
    ["pipelines_create", "write"],
    ["ps_scale", "write"],
    ["kubectl_apply", "write"],
    ["API-patch-page", "write"],
    ["pg_kill", "write"],
    ["merge_pull_request", "write"],
    ["slack_get_users", "read"],
    ["API-retrieve-a-page", "read"],
    ["kubectl_describe", "read"],
    ["web_fetch_exa", "read"],
    ["subscription_list", "read"],
  ])("%s → %s", (name, expected) => {
    expect(classifyByVerbWords(name)).toBe(expected);
  });

  it("Lese- UND Schreibverb im Namen bleibt unklar (nie raten), ausser das Schreib-Verb folgt nach and/or/then", () => {
    for (const name of ["API-post-search", "post_get", "search_post"]) {
      expect(classifyByVerbWords(name), name).toBe("unclassified");
    }
    // 0.11.0: «get_or_create», «list_then_delete» sprechen das Schreib-Verb aus.
    for (const name of ["get_or_create_user", "list_then_delete"]) {
      expect(classifyByVerbWords(name), name).toBe("write");
    }
  });

  it("kein Verb im Namen bleibt unklar", () => {
    for (const name of ["echo", "whoami", "union_tool", "sequentialthinking"]) {
      expect(classifyByVerbWords(name), name).toBe("unclassified");
    }
  });

  it("was bisher schon eingeordnet war, aendert sich nicht (Annotation, Praefix, Lesepraefix)", () => {
    expect(classifyUpstreamTool(tool("slack_post_message", { readOnlyHint: true }), cfg)).toMatchObject({ class: "read", source: "annotation readOnlyHint=true" });
    expect(classifyUpstreamTool(tool("create_booking"), cfg)).toMatchObject({ class: "write", source: "default write pattern" });
    expect(classifyUpstreamTool(tool("get_booking"), cfg)).toMatchObject({ class: "read", source: "read prefix" });
  });

  it("neu eingeordnete Tools nennen die Quelle", () => {
    expect(classifyUpstreamTool(tool("slack_post_message"), cfg)).toMatchObject({ class: "write", source: "verb word in name" });
  });

  it("mit eigenen --write-tools/--read-tools entscheidet der Aufrufer: keine Verb-Erkennung", () => {
    expect(classifyUpstreamTool(tool("slack_post_message"), { writeToolPatterns: ["create_*"], readToolPatterns: [] }).class).toBe("unclassified");
    expect(classifyUpstreamTool(tool("slack_get_users"), { writeToolPatterns: [], readToolPatterns: ["list_*"] }).class).toBe("unclassified");
  });

  it("ein Lese-Wort im Namen eines Tools, das schreibt: mit Beschreibung bleibt es unklar, ohne eine benannte Vermutung", () => {
    // 0.11.0: eine Beschreibung, die mit einem Schreib-Verb beginnt («Submit …»), hebt unklar auf Write.
    const withDescription: Tool = { ...tool("firecrawl_search_feedback"), description: "Submit feedback about a search result." };
    expect(classifyUpstreamTool(withDescription, cfg)).toMatchObject({ class: "write", source: "description opens with a write verb" });
    const consistent: Tool = { ...tool("firecrawl_search_feedback"), description: "Returns the feedback given for a search result." };
    expect(classifyUpstreamTool(consistent, cfg).class).toBe("read");
    expect(classifyUpstreamTool(tool("firecrawl_search_feedback"), cfg)).toMatchObject({ class: "read", guess: true });
  });
});

describe("Erfolgsantwort, die wie ein Fehler aussieht", () => {
  it.each([
    "Fehler: Zimmer belegt",
    "Error: database unavailable",
    "error: nope",
    "Failed to create booking",
    "Could not book the room",
    "Ungültige Eingabe",
    '{"error":"DB_UNAVAILABLE"}',
    '{"error":{"code":500}}',
    '{"success":false,"message":"no"}',
    '{"ok":false}',
    '{"status":"error"}',
    '{"status":"FAILED"}',
  ])("erkannt: %s", (text) => {
    expect(looksLikeErrorAnswer(text)).toBe(true);
  });

  it.each([
    '{"status":"confirmed","booking_id":"B-1","error":null}',
    '{"result":"ok","errors":[]}',
    '{"success":true}',
    "Buchung B-0001 bestaetigt",
    "Booking confirmed. No errors.",
    "Die Buchung enthaelt kein Fehler-Feld.",
    '{"note":"error handling was skipped"}',
    "",
    "[]",
    '[{"error":"x"}]', // ein Array ist keine Fehlerantwort des Aufrufs
  ])("nicht erkannt: %s", (text) => {
    expect(looksLikeErrorAnswer(text)).toBe(false);
  });

  it("null und undefined sind keine Fehlerantwort", () => {
    expect(looksLikeErrorAnswer(null)).toBe(false);
    expect(looksLikeErrorAnswer(undefined)).toBe(false);
  });

  it("eine sehr lange JSON-Antwort wird nicht geparst (Laufzeit)", () => {
    const big = '{"error":"x","data":"' + "a".repeat(2_000_000) + '"}';
    const t0 = performance.now();
    looksLikeErrorAnswer(big);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});
