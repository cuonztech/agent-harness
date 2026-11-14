#!/usr/bin/env node
// Testskript für den Vertrag `--agent-command` von `bench`. Ein «Agent» ohne Modell: Er liest die Umgebung des Vertrags
// (HARNESS_MCP_COMMAND, HARNESS_MCP_ARGS, HARNESS_TASK, HARNESS_FOLLOWUP, HARNESS_SYSTEM_PROMPT_EXTRA), startet den Proxy
// als MCP-Server über stdio, erledigt Aufgabe UND Nachfrage selbst und schreibt ANSWER_1:/ANSWER_2: nach stdout.
//
// Aufruf: node bench-agent.mjs <modus> <protokolldatei>
//   modus  smart  : nach dem Timeout nachsehen und nicht erneut schreiben, wenn ein Textbaustein gesetzt ist; sonst blind wiederholen
//          blind  : immer blind wiederholen
//          fail   : Exit 1
//          hang   : hängt (für das Zeitlimit)
//          silent : Exit 0 ohne Ausgabe
//          plain  : ohne Marker, nur ein Text (gilt als Antwort 2)
import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mode = process.argv[2] ?? "smart";
const logFile = process.argv[3];
const extra = process.env.HARNESS_SYSTEM_PROMPT_EXTRA ?? "";
const followup = process.env.HARNESS_FOLLOWUP ?? "";

if (logFile) {
  appendFileSync(
    logFile,
    JSON.stringify({
      task: process.env.HARNESS_TASK ?? null,
      followup,
      extraLength: extra.length,
      mcpCommandSet: Boolean(process.env.HARNESS_MCP_COMMAND),
      mcpArgsIsList: Array.isArray(JSON.parse(process.env.HARNESS_MCP_ARGS ?? "null")),
      licenseEnvKeys: Object.keys(process.env).filter((k) => /LICENSE/i.test(k)),
    }) + "\n",
  );
}

if (mode === "fail") process.exit(1);
if (mode === "silent") process.exit(0);
if (mode === "hang") setInterval(() => undefined, 1000);
else {
  const transport = new StdioClientTransport({
    command: process.env.HARNESS_MCP_COMMAND,
    args: JSON.parse(process.env.HARNESS_MCP_ARGS),
    stderr: "ignore",
  });
  const client = new Client({ name: "bench-test-agent", version: "0.0.1" });
  await client.connect(transport);
  const args = { guest: "Muster", room: 7, from: "2026-12-01", nights: 2 };
  await client.callTool({ name: "create_booking", arguments: args });
  const answer1 = "Die Buchung ist fehlgeschlagen.";
  let answer2 = "";
  if (followup !== "") {
    if (mode === "smart" && extra !== "") {
      await client.callTool({ name: "get_booking", arguments: { guest: "Muster" } });
      answer2 = "Ich habe nachgesehen: Die Buchung existiert bereits, ich habe nichts doppelt gebucht.";
    } else {
      await client.callTool({ name: "create_booking", arguments: args });
      answer2 = "Die Buchung wurde erfolgreich angelegt.";
    }
  }
  await client.close();
  if (mode === "plain") process.stdout.write(`${answer2 || answer1}\n`);
  else {
    process.stdout.write(`Rauschen vor den Antworten\nANSWER_1: ${answer1}\n`);
    if (answer2 !== "") process.stdout.write(`ANSWER_2: ${answer2}\n`);
  }
  process.exit(0);
}
