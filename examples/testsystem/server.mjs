// TESTSYSTEM — Mietbuchungs-Attrappe für den Agent-Harness-Kaltstart-Test.
// Keine echten Daten, keine Abhängigkeiten. Speichert Buchungen in bookings.json
// neben dieser Datei (oder in der Datei aus TESTSYSTEM_DATA), damit jeder
// Schreibvorgang nachprüfbar bleibt.
// Start: node server.mjs   (MCP über stdio, JSON-RPC, Zeile für Zeile)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = process.env.TESTSYSTEM_DATA ?? join(dirname(fileURLToPath(import.meta.url)), "bookings.json");
const PROTOCOL = "2024-11-05";

function load() {
  return existsSync(DATA) ? JSON.parse(readFileSync(DATA, "utf8")) : [];
}
function save(list) {
  writeFileSync(DATA, JSON.stringify(list, null, 2) + "\n");
}

const TOOLS = [
  {
    name: "create_booking",
    description: "Legt eine neue Mietbuchung an (schreibt in das Testsystem).",
    inputSchema: {
      type: "object",
      properties: {
        customer: { type: "string", description: "Name des Kunden" },
        date: { type: "string", description: "Datum, z. B. 2026-11-03" },
        amount_chf: { type: "number", description: "Betrag in CHF" },
        idempotency_key: { type: "string", description: "Optional: gleicher Key = gleiche Buchung, kein Doppel" },
      },
      required: ["customer", "date", "amount_chf"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "list_bookings",
    description: "Listet alle Buchungen eines Kunden (nur lesend).",
    inputSchema: {
      type: "object",
      properties: { customer: { type: "string" } },
      required: ["customer"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "get_booking",
    description: "Liefert eine Buchung anhand ihrer ID (nur lesend).",
    inputSchema: {
      type: "object",
      properties: { booking_id: { type: "string" } },
      required: ["booking_id"],
    },
    annotations: { readOnlyHint: true },
  },
];

function callTool(name, args) {
  const list = load();
  if (name === "create_booking") {
    if (args.idempotency_key) {
      const known = list.find((b) => b.idempotency_key === args.idempotency_key);
      if (known) return { booking: known, duplicate_prevented: true };
    }
    const booking = {
      idempotency_key: args.idempotency_key ?? null,
      booking_id: `B-${String(list.length + 1).padStart(4, "0")}`,
      customer: args.customer,
      date: args.date,
      amount_chf: args.amount_chf,
      created_at: new Date().toISOString(),
    };
    list.push(booking);
    save(list);
    return { booking };
  }
  if (name === "list_bookings") {
    return { bookings: list.filter((b) => b.customer === args.customer) };
  }
  if (name === "get_booking") {
    const booking = list.find((b) => b.booking_id === args.booking_id);
    return booking ? { booking } : { error: `booking ${args.booking_id} not found` };
  }
  throw new Error(`unknown tool ${name}`);
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return replyError(null, -32700, "parse error");
  }
  if (msg.id === undefined) return; // Notifications brauchen keine Antwort.
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: "testsystem-mietbuchung", version: "0.1.0" },
      });
    case "tools/list":
      return reply(msg.id, { tools: TOOLS });
    case "tools/call": {
      try {
        const data = callTool(msg.params.name, msg.params.arguments ?? {});
        return reply(msg.id, { content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (err) {
        return reply(msg.id, {
          content: [{ type: "text", text: String(err.message) }],
          isError: true,
        });
      }
    }
    default:
      return replyError(msg.id, -32601, `method not found: ${msg.method}`);
  }
});
