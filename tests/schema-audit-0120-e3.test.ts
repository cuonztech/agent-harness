// 0.12.0, Stufe E3c und E3b (Pro-Gate, Befunde B8 und A7): Das Schema-Gutachten verpasste drei Fälle (read-only im zweiten Satz der
// Beschreibung, readOnlyHint zusammen mit destructiveHint, optionaler Schlüssel); die Schema-Vorschläge sind eine Schablone und stehen
// nur bei Schreib-Tools. Die Tool-Listen sind synthetisch (nach den Eingaben des Prüfers, pro-test/work/schema/bad.json).
import { describe, it, expect } from "vitest";
import { auditToolSchemas } from "../src/schema-audit.js";
import { descriptionSaysReadOnlyLater } from "../src/proxy/classification-doubt.js";
import type { ToolInput } from "../src/types.js";

const lookup = (name: string, extra: Record<string, unknown> = {}): ToolInput =>
  ({ name, description: "Returns the entries.", inputSchema: { type: "object", properties: { customer: { type: "string" } } }, annotations: { readOnlyHint: true }, ...extra }) as ToolInput;
const entryOf = (tools: ToolInput[], name: string) => auditToolSchemas(tools).tools.find((t) => t.name === name)!;

describe("E3c: «read-only» im zweiten Satz der Beschreibung", () => {
  const payment = (description: string): ToolInput =>
    ({ name: "create_payment", description, inputSchema: { type: "object", properties: { to: { type: "string" }, amount: { type: "number" } }, required: ["to", "amount"] } }) as ToolInput;

  it("«Creates a payment. Read-only, does not modify anything.» ist ein Widerspruch zwischen Name und Beschreibung", () => {
    const e = entryOf([payment("Creates a payment. Read-only, does not modify anything.")], "create_payment");
    expect(e.classification).toBe("ambiguous");
    expect(e.classificationNoteDe).toContain("späterer Satz der Beschreibung");
    expect(e.riskLevel).not.toBe("HIGH");
    expect(e.findingsDe.join(" ")).toContain("Zweifel an der Einordnung");
  });

  it.each([
    "Creates a payment. This tool is read-only.",
    "Creates a payment. This tool only reads data.",
    "Creates a payment. Does not modify anything.",
    "Erstellt eine Zahlung. Nur lesend.",
    "Erstellt eine Zahlung. Schreibgeschützt, ändert nichts.",
    "Creates a payment.\nRead only.",
  ])("«%s»", (description) => {
    expect(descriptionSaysReadOnlyLater(description)).toBe(true);
    expect(entryOf([payment(description)], "create_payment").classificationNoteDe).toContain("späterer Satz");
  });

  it.each([
    "Creates a payment. The id field is read-only.",
    "Creates a payment. Does not change existing payments.",
    "Creates a payment. Has no side effects.",
    "Creates a payment. Returns the payment id. Fails if the account is read-only.",
    "Creates a payment.",
    "Creates a payment. Needs an API key.",
  ])("kein Zweifel bei «%s» (Parameter oder bestehende Daten, kein Satz über das Tool)", (description) => {
    expect(descriptionSaysReadOnlyLater(description)).toBe(false);
    const e = entryOf([payment(description)], "create_payment");
    expect(e.classification).toBe("write");
    expect(e.classificationNoteDe).toBeUndefined();
  });

  it("die bisherige Regel für den ersten Satz bleibt", () => {
    const e = entryOf([payment("Read-only. Creates nothing.")], "create_payment");
    expect(e.classificationNoteDe).toContain("nur liest");
  });
});

describe("E3c: readOnlyHint zusammen mit destructiveHint", () => {
  const tool = (name: string, annotations: Record<string, unknown>): ToolInput =>
    ({ name, description: "Does the housekeeping.", inputSchema: { type: "object", properties: { scope: { type: "string" } } }, annotations }) as ToolInput;

  it("auch bei einem Namen, der nicht löscht: Widerspruch in den Annotationen, Risiko HOCH", () => {
    const e = entryOf([tool("cache_status", { readOnlyHint: true, destructiveHint: true })], "cache_status");
    expect(e.riskLevel).toBe("HIGH");
    expect(e.findingsDe.join(" ")).toContain("readOnlyHint=true zusammen mit destructiveHint=true");
  });

  it("readOnlyHint=true allein bleibt NIEDRIG, destructiveHint=true bei readOnlyHint=false ist kein Widerspruch", () => {
    expect(entryOf([tool("cache_status", { readOnlyHint: true })], "cache_status").riskLevel).toBe("LOW");
    expect(entryOf([tool("cache_status", { readOnlyHint: false, destructiveHint: true })], "cache_status").findingsDe.join(" ")).not.toContain("readOnlyHint=true zusammen");
  });

  it("der Name löscht und beide Hinweise stehen: weiterhin HOCH, beide Befunde", () => {
    const e = entryOf([tool("purge_data", { readOnlyHint: true, destructiveHint: true })], "purge_data");
    expect(e.riskLevel).toBe("HIGH");
    expect(e.findingsDe.join(" ")).toContain("readOnlyHint=true zusammen mit destructiveHint=true");
  });
});

describe("E3c: optionaler Schlüssel", () => {
  const bookRoom = (required: string[], annotations: Record<string, unknown> = { readOnlyHint: false }): ToolInput =>
    ({
      name: "book_room",
      description: "Books a room.",
      inputSchema: { type: "object", properties: { room: { type: "string" }, idempotency_key: { type: "string" } }, required },
      annotations,
    }) as ToolInput;
  const withLookup = (t: ToolInput): ToolInput[] => [t, lookup("list_rooms")];

  it("ein Schlüssel, der nicht unter required steht, ist ein Befund", () => {
    const e = entryOf(withLookup(bookRoom(["room"])), "book_room");
    const text = e.findingsDe.join(" ");
    expect(text).toContain("optional");
    expect(text).toContain("idempotency_key");
    expect(e.hasIdempotencyKey).toBe(true);
  });

  it("mit idempotentHint=true steht dazu, dass der Hinweis nichts belegt", () => {
    const e = entryOf(withLookup(bookRoom(["room"], { readOnlyHint: false, idempotentHint: true })), "book_room");
    expect(e.findingsDe.join(" ")).toContain("idempotentHint=true belegt nicht");
  });

  it("ein Pflicht-Schlüssel hat den Befund nicht", () => {
    const e = entryOf(withLookup(bookRoom(["room", "idempotency_key"])), "book_room");
    expect(e.findingsDe.join(" ")).not.toContain("optional");
  });

  it("die Risikostufe ändert sich dadurch nicht (nur ein Befund): Schlüssel vorhanden und Nachsehen möglich bleibt NIEDRIG", () => {
    expect(entryOf(withLookup(bookRoom(["room"])), "book_room").riskLevel).toBe("LOW");
  });

  it("ein Schlüssel, den die Beschreibung als ignoriert nennt, bekommt nur den Befund «ignoriert», nicht zusätzlich «optional»", () => {
    const t = { ...bookRoom(["room"]), description: "Books a room. The idempotency_key is ignored." } as ToolInput;
    const text = entryOf(withLookup(t), "book_room").findingsDe.join(" ");
    expect(text).toContain("ignoriere");
    expect(text).not.toContain("ist im Schema optional");
  });
});

describe("E3b: Schema-Vorschläge nur bei Schreib-Tools", () => {
  it("Lese-Tools (nach Name oder Annotation) bekommen keinen Vorschlag und keinen Befund zum Schlüssel", () => {
    const tools: ToolInput[] = [
      lookup("list_bookings"),
      lookup("get_booking", { annotations: undefined }),
      lookup("fetch_report", { annotations: { readOnlyHint: true } }),
    ];
    const audit = auditToolSchemas(tools);
    for (const t of audit.tools) {
      expect(t.classification).toBe("read");
      expect(t.recommendedSchemaPatch).toBeNull();
      expect(t.recommendedFieldName).toBeUndefined();
      expect(t.findingsDe.join(" ")).not.toContain("Idempotenz-Schlüssel");
    }
  });

  it("ein Schreib-Tool bekommt den Vorschlag, mit dem Namen des Tools", () => {
    const t = entryOf([{ name: "create_booking", description: "Creates a booking.", inputSchema: { type: "object", properties: { guest: { type: "string" } }, required: ["guest"] } } as ToolInput], "create_booking");
    expect(t.recommendedSchemaPatch).not.toBeNull();
    expect(JSON.stringify(t.recommendedSchemaPatch)).toContain("create_booking");
    expect(JSON.stringify(t.recommendedSchemaPatch)).not.toContain("Nur nötig");
  });

  it("bei unklarer Einordnung (Name sagt «lesen», Beschreibung «schreibt») sagt der Vorschlag, dass er nur bei einem Schreib-Tool nötig ist", () => {
    const t = entryOf(
      [{ name: "get_next_id", description: "Allocates and returns the next free id (increments the counter).", inputSchema: { type: "object", properties: {} } } as ToolInput],
      "get_next_id",
    );
    expect(t.classification).toBe("ambiguous");
    expect(JSON.stringify(t.recommendedSchemaPatch)).toContain("Nur nötig, wenn dieses Tool tatsächlich etwas schreibt");
  });
});
