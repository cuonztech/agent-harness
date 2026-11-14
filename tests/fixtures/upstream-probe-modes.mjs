// Test-Upstream für die Wirkungs-Sonde von `bench` (Stufe D): ein kleines MCP-Testsystem über stdio, ohne Abhängigkeiten, ohne Dateien
// (alle Datensätze liegen im Speicher des Prozesses; jeder Lauf bekommt einen frischen Prozess).
//
// Werkzeuge: create_booking (schreibt), list_bookings (liest, verlangt `customer`), search_bookings (liest, verlangt `customer` und `from`), count_bookings (liest, liefert {"count": n}),
// list_text (liest, Antwort ist kein JSON), list_opaque (liest, JSON ohne Liste oder Zahl), list_error (liest, immer ein Fehler).
// Umgebung:
//   PS_FAIL_TAGS  regulärer Ausdruck: passt PS_TAG darauf, antwortet list_bookings nach dem ersten Schreibvorgang mit einem Fehler
//                 (die Sonde ist dann «mitten im Lauf» nicht lesbar). PS_TAG steht in der Regel für {RUN_ID}.
import { createInterface } from "node:readline";

const records = [];
const failTags = process.env.PS_FAIL_TAGS ? new RegExp(process.env.PS_FAIL_TAGS) : null;
const failNow = () => failTags !== null && failTags.test(process.env.PS_TAG ?? "") && records.length > 0;

const TOOLS = [
  {
    name: "create_booking",
    description: "Legt eine neue Buchung an (schreibt).",
    inputSchema: {
      type: "object",
      properties: { customer: { type: "string" }, date: { type: "string" }, amount_chf: { type: "number" } },
      required: ["customer", "date", "amount_chf"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "list_bookings",
    description: "Listet alle Buchungen eines Kunden (nur lesend).",
    inputSchema: { type: "object", properties: { customer: { type: "string" } }, required: ["customer"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "search_bookings",
    description: "Sucht Buchungen eines Kunden ab einem Datum (nur lesend).",
    inputSchema: { type: "object", properties: { customer: { type: "string" }, from: { type: "string" } }, required: ["customer", "from"] },
    annotations: { readOnlyHint: true },
  },
  { name: "count_bookings", description: "Zählt alle Buchungen (nur lesend).", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "list_text", description: "Liefert Text statt JSON (nur lesend).", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "list_opaque", description: "Liefert JSON ohne Liste oder Zahl (nur lesend).", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "list_error", description: "Antwortet immer mit einem Fehler (nur lesend).", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];

const text = (value, isError = false) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

function callTool(name, args) {
  switch (name) {
    case "create_booking":
      records.push({ ...args, booking_id: `B-${records.length + 1}` });
      return text({ booking: records[records.length - 1] });
    case "list_bookings":
      if (failNow()) return text("backend down", true);
      return text({ bookings: records.filter((r) => r.customer === args.customer) });
    case "search_bookings":
      return text({ bookings: records.filter((r) => r.customer === args.customer) });
    case "count_bookings":
      return text({ count: records.length });
    case "list_text":
      return text("keine Buchungen vorhanden");
    case "list_opaque":
      return text({ status: "ok" });
    case "list_error":
      return text("customer required", true);
    default:
      return text(`unknown tool ${name}`, true);
  }
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "probe-modes", version: "0.1.0" } });
    case "tools/list":
      return reply(msg.id, { tools: TOOLS });
    case "tools/call":
      return reply(msg.id, callTool(msg.params.name, msg.params.arguments ?? {}));
    default:
      return process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }) + "\n");
  }
});
