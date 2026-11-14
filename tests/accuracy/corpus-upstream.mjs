#!/usr/bin/env node
// Upstream des Genauigkeits-Korpus (tests/accuracy). Ein echter MCP-Server über
// stdio, dessen Verhalten je Fall per Umgebung gewählt wird, und der die WAHRHEIT
// in eine Datei schreibt (ACC_LEDGER_FILE), nicht über den Proxy: jeder Schreibaufruf,
// der ankam, mit der Angabe, ob er einen NEUEN Datensatz erzeugt hat (effective).
// Der Harness sieht diese Datei nie. Die Messung vergleicht sein Urteil mit ihr.
//
//   ACC_DEDUP        none (Standard) | key (idempotency_key) | requestid (request_id)
//                    | natural (guest+room+from, geschrieben egal wie)
//   ACC_FAIL_FIRST   none | text   (1. create_booking: Fehlertext OHNE isError, nichts geschrieben)
//                    | iserror     (1. Aufruf: isError, nichts geschrieben)
//                    | partial     (1. Aufruf: Datensatz geschrieben, dann isError)
//   ACC_TOOLSET      standard (Standard) | odd (Tools mit irrefuehrenden Namen)
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const LEDGER = process.env.ACC_LEDGER_FILE;
const DEDUP = process.env.ACC_DEDUP ?? "none";
const FAIL_FIRST = process.env.ACC_FAIL_FIRST ?? "none";
const TOOLSET = process.env.ACC_TOOLSET ?? "standard";

const server = new Server(
  { name: "accuracy-upstream", version: "0.0.1" },
  { capabilities: { tools: {} } },
);

const records = []; // wirkliche Datensaetze
const seen = new Set(); // Dedup-Schluessel
let bookingCalls = 0;

const bookingSchema = {
  type: "object",
  properties: {
    guest: { type: "string" },
    room: { type: "number" },
    from: { type: "string" },
    nights: { type: "number" },
    phone: { type: "string" },
    email: { type: "string" },
    amount: { type: "number" },
    note: { type: "string" },
    guest_name: { type: "string" },
    idempotency_key: { type: "string" },
    request_id: { type: "string" },
    meta: { type: "object", properties: { request_id: { type: "string" } } },
  },
  required: [],
};
const orderSchema = {
  type: "object",
  properties: {
    customer: { type: "string" },
    items: { type: "array", items: { type: "object" } },
    idempotency_key: { type: "string" },
  },
};
const anySchema = { type: "object", properties: { guest: { type: "string" }, room: { type: "number" }, order_id: { type: "string" } } };

const standardTools = [
  { name: "create_booking", description: "Books a room and charges the card.", inputSchema: bookingSchema },
  { name: "create_order", description: "Creates an order with line items.", inputSchema: orderSchema },
  { name: "get_booking", description: "Reads a booking by guest name.", inputSchema: anySchema },
  // Schreibt, erzeugt aber keinen neuen Datensatz (ein Write, den die Sonde nicht zaehlt).
  { name: "update_booking", description: "Updates the status of a booking.", inputSchema: { type: "object", properties: { guest: { type: "string" }, status: { type: "string" } } } },
  { name: "list_bookings", description: "Lists all bookings.", inputSchema: { type: "object", properties: {} } },
  { name: "get_room_availability", description: "Reads availability of a room.", inputSchema: anySchema },
];
const oddTools = [
  // Schreibt, beginnt aber mit "check": Namensmuster halten es fuer einen Read.
  { name: "check_in_guest", description: "Checks a guest in and bills the first night.", inputSchema: anySchema },
  // Liest nur, beginnt aber mit "update_": Namensmuster halten es fuer einen Write.
  { name: "update_status_view", description: "Refreshes the status view (read only).", inputSchema: { type: "object", properties: {} } },
  // Schreibt unter einem Namen ausserhalb aller Standardmuster, ohne Annotation.
  { name: "process_order", description: "Processes an order and charges it.", inputSchema: anySchema },
  { name: "submitOrder", description: "Submits an order (camelCase).", inputSchema: anySchema },
  { name: "buchung_erstellen", description: "Erstellt eine Buchung (deutscher Name).", inputSchema: anySchema },
  // Nur die Annotation verraet, dass es schreibt.
  { name: "tag_booking", description: "Tags a booking.", inputSchema: anySchema, annotations: { readOnlyHint: false } },
  { name: "get_booking", description: "Reads a booking by guest name.", inputSchema: anySchema },
];
const tools = TOOLSET === "odd" ? oddTools : standardTools;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

function text(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], ...(isError ? { isError: true } : {}) };
}

function dedupKey(name, args) {
  if (DEDUP === "key" && typeof args?.idempotency_key === "string") return `${name}|k|${args.idempotency_key}`;
  if (DEDUP === "requestid" && typeof args?.request_id === "string") return `${name}|r|${args.request_id}`;
  if (DEDUP === "natural") return `${name}|n|${args?.guest ?? args?.customer ?? ""}|${args?.room ?? ""}|${args?.from ?? ""}`;
  return null;
}

// Fuehrt einen Schreibaufruf aus und protokolliert die Wahrheit.
function doWrite(name, args) {
  const key = dedupKey(name, args);
  let effective = true;
  if (key !== null) {
    if (seen.has(key)) effective = false;
    else seen.add(key);
  }
  if (effective) records.push({ name, args });
  const sig = String(args?.guest ?? args?.customer ?? args?.order_id ?? "").toLowerCase();
  if (LEDGER) appendFileSync(LEDGER, JSON.stringify({ tool: name, effective, sig }) + "\n");
  return { effective, id: `R-${records.length}` };
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  if (name === "create_booking") {
    bookingCalls++;
    if (bookingCalls === 1 && FAIL_FIRST === "text") {
      return text("Fehler: Datenbank kurz nicht erreichbar. Bitte erneut versuchen.");
    }
    if (bookingCalls === 1 && FAIL_FIRST === "iserror") {
      return text({ error: "DB_UNAVAILABLE" }, true);
    }
    if (bookingCalls === 1 && FAIL_FIRST === "partial") {
      doWrite(name, args);
      return text({ error: "CONFIRMATION_MAIL_FAILED" }, true);
    }
    const w = doWrite(name, args);
    return text({ status: "confirmed", booking_id: w.id, error: null });
  }
  if (["create_order", "check_in_guest", "process_order", "submitOrder", "buchung_erstellen", "tag_booking"].includes(name)) {
    const w = doWrite(name, args);
    return text({ status: "ok", id: w.id });
  }
  if (name === "update_booking") {
    if (LEDGER) appendFileSync(LEDGER, JSON.stringify({ tool: name, effective: false }) + "\n");
    return text({ status: "updated" });
  }
  if (name === "get_booking") {
    const hit = records.filter((r) => r.args?.guest === args.guest);
    return text({ found: hit.length > 0, count: hit.length });
  }
  if (name === "list_bookings") {
    // ACC_PROBE_DELAY_MS: eine langsame Lesesonde (Befund P2 der Pruefrunde).
    const delay = Number(process.env.ACC_PROBE_DELAY_MS ?? 0);
    if (delay > 0) await new Promise((res) => setTimeout(res, delay));
  }
  if (name === "list_bookings") return text({ count: records.length, bookings: records.map((r) => r.args) });
  if (name === "get_room_availability") return text({ room: args.room ?? null, free: true });
  if (name === "update_status_view") return text({ view: "refreshed" });

  return text({ error: "UNKNOWN_TOOL", name }, true);
});

await server.connect(new StdioServerTransport());
