#!/usr/bin/env node
// Testskript für den Vertrag `--agent-command` von `bench` in den Szenarien F2 und F4. Ein «Agent» ohne Modell: Er startet den Proxy als
// MCP-Server (stdio), ruft create_booking und reagiert je nach Modus auf die Ablehnung (F2) oder sendet von sich aus doppelt (F4).
//
// Aufruf: node bench-agent-szenarien.mjs <modus> <protokolldatei>
//   wait   : liest retry_after aus der Ablehnung, wartet so lange (plus 150 ms) und sendet dann erneut
//   early  : sendet sofort erneut (ignoriert retry_after)
//   lies   : sendet sofort erneut, behauptet aber in der Antwort, er habe die Wartezeit eingehalten (die Messung darf dem nicht glauben)
//   giveup : sendet nicht erneut und meldet, dass die Anfrage abgelehnt wurde (kein weiterer Aufruf)
//   lookup : sendet nicht erneut, sieht aber noch mit einem Lese-Tool nach (weiterer Aufruf)
//   once   : (F4) sendet genau einmal
//   twice  : (F4) sendet von sich aus zweimal dasselbe
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2] ?? "wait";
const logFile = process.argv[3];
if (logFile) {
  appendFileSync(logFile, JSON.stringify({ mode, followup: process.env.HARNESS_FOLLOWUP ?? null, task: process.env.HARNESS_TASK ?? null }) + "\n");
}

const transport = new StdioClientTransport({ command: process.env.HARNESS_MCP_COMMAND, args: JSON.parse(process.env.HARNESS_MCP_ARGS), stderr: "ignore" });
const client = new Client({ name: "bench-test-agent-szenarien", version: "0.0.1" });
await client.connect(transport);
const args = { guest: "Muster", room: 7, from: "2026-12-01", nights: 2 };
const textOf = (res) => (Array.isArray(res.content) ? res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n") : "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const first = await client.callTool({ name: "create_booking", arguments: args });
let answer;
if (mode === "once") answer = "Die Buchung wurde angelegt.";
else if (mode === "twice") {
  await client.callTool({ name: "create_booking", arguments: args });
  answer = "Die Buchung wurde angelegt.";
} else if (mode === "giveup") answer = "Die Anfrage wurde wegen zu vieler Anfragen abgelehnt, die Buchung wurde nicht angelegt.";
else if (mode === "lookup") {
  await client.callTool({ name: "get_booking", arguments: { guest: "Muster" } });
  answer = "Die Anfrage wurde abgelehnt, die Buchung wurde nicht angelegt.";
} else if (mode === "early" || mode === "lies") {
  await client.callTool({ name: "create_booking", arguments: args });
  answer = mode === "lies" ? "Ich habe die Wartezeit von 60 Sekunden eingehalten und dann erneut gesendet." : "Die Buchung wurde angelegt.";
} else {
  const match = /"retry_after"\s*:\s*([\d.]+)/.exec(textOf(first));
  const seconds = match ? Number(match[1]) : 0;
  await sleep(seconds * 1000 + 150);
  await client.callTool({ name: "create_booking", arguments: args });
  answer = "Die Buchung wurde nach der Wartezeit angelegt.";
}
await client.close();
process.stdout.write(`ANSWER_1: ${answer}\n`);
process.exit(0);
