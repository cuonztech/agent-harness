// `doctor` — prüft vor einem Testlauf, ob der Weg funktioniert, und nennt für
// jeden Fehler die Lösung. Ruft nur `initialize` und `tools/list` auf, führt nie
// ein Tool aus und schreibt nichts (der Report-Pfad wird nur geprüft).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { access, stat } from "node:fs/promises";
import { constants, existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { classifyUpstreamTool } from "./proxy/interceptor.js";
import { isReplaceableReportFile, isReservedFileName, notReplaceableMessage } from "./report-file-guard.js";

const START_TIMEOUT_MS = 15_000;

export interface Check {
  ok: boolean;
  label: string;
  detail?: string;
  fix?: string;
}

interface ParsedArgs {
  command?: string;
  upstreamArgs: string[];
  cwd?: string;
  reportFile?: string;
  writeTools: string[];
  readTools: string[];
  unknown: string[];
  // Options given without a usable value; the proxy rejects those too.
  empty: string[];
}

function splitList(raw: string): string[] {
  return raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

function parseDoctorArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { upstreamArgs: [], writeTools: [], readTools: [], unknown: [], empty: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const eq = token.indexOf("=");
    const flag = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const takeValue = (): string => {
      const value = inline !== undefined ? inline : ((i += 1), argv[i] ?? "");
      // An empty --upstream-arg is a legitimate argument for the upstream.
      if (value.trim() === "" && flag !== "--upstream-arg") out.empty.push(flag);
      return value;
    };
    switch (flag) {
      case "--upstream-command":
        out.command = takeValue();
        break;
      case "--upstream-arg":
        out.upstreamArgs.push(takeValue());
        break;
      case "--upstream-cwd":
        out.cwd = takeValue();
        break;
      case "--report-file":
        out.reportFile = takeValue();
        break;
      case "--write-tools":
        out.writeTools = splitList(takeValue());
        break;
      case "--read-tools":
        out.readTools = splitList(takeValue());
        break;
      default:
        out.unknown.push(token);
    }
  }
  return out;
}

function checkNode(): Check {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    ok: major >= 20,
    label: `Node.js ${process.versions.node} (mindestens 20 nötig)`,
    fix: "Node 20 oder neuer von https://nodejs.org installieren. Achtung: `apt install nodejs` liefert auf Ubuntu 24.04 nur Node 18.",
  };
}

function checkUpstreamScript(command: string, args: string[], cwd: string): Check | undefined {
  const scriptArg = args.find((a) => !a.startsWith("-"));
  const inlineScript = args.some((a) => ["-e", "--eval", "-p", "--print"].includes(a));
  const isNode = /^node(\.exe)?$/i.test(basename(command));
  if (isNode && !inlineScript && scriptArg === undefined) {
    return {
      ok: false,
      label: "Start-Datei angegeben (node braucht eine Datei)",
      fix: "Den Pfad zur Start-Datei deines MCP-Servers angeben, z. B. --upstream-arg <pfad\\zu\\server.js>.",
    };
  }
  if (!isNode || scriptArg === undefined || inlineScript) {
    return undefined;
  }
  const scriptPath = resolve(cwd, scriptArg);
  return {
    ok: existsSync(scriptPath),
    label: `Upstream-Datei vorhanden: ${scriptPath}`,
    fix: "Den Platzhalter durch den Pfad zur Start-Datei deines MCP-Servers ersetzen (oder --upstream-cwd setzen).",
  };
}

async function checkReportFile(path: string): Promise<Check> {
  const target = resolve(path);
  if (isReservedFileName(path)) {
    return { ok: false, label: `Report-Datei: ${path}`, detail: "Der Name enthält einen reservierten Gerätenamen oder ein \":\" und ist keine nutzbare Datei.", fix: "Anderen Dateinamen für --report-file wählen." };
  }
  if (existsSync(target)) {
    const info = await stat(target);
    if (!info.isFile()) {
      return { ok: false, label: `Report-Datei: ${target}`, detail: "Ziel ist keine normale Datei.", fix: "Anderen Dateinamen für --report-file wählen." };
    }
    if (!isReplaceableReportFile(target)) {
      return { ok: false, label: `Report-Datei: ${target}`, detail: "Die Datei existiert und ist kein früherer Harness-Report; der Proxy würde sie nicht überschreiben.", fix: notReplaceableMessage("--report-file", target) };
    }
    const writable = await access(target, constants.W_OK).then(() => true, () => false);
    return { ok: writable, label: `Report-Datei schreibbar: ${target}`, fix: "Datei schliessen oder Schreibrecht setzen." };
  }
  const dir = dirname(target);
  const writable = await access(dir, constants.W_OK).then(() => true, () => false);
  return { ok: writable, label: `Report-Verzeichnis schreibbar: ${dir}`, fix: "Verzeichnis anlegen oder Schreibrecht darauf geben." };
}

interface ProtocolResult {
  checks: Check[];
  toolLines: string[];
}

interface ToolPatterns {
  writeToolPatterns: string[];
  readToolPatterns: string[];
}

async function checkUpstreamProtocol(command: string, args: string[], cwd: string, patterns: ToolPatterns): Promise<ProtocolResult> {
  const transport = new StdioClientTransport({ command, args, cwd, stderr: "pipe" });
  let stderrText = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderrText += chunk.toString();
  });
  const client = new Client({ name: "cuonztech-doctor", version: "0" });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`keine Antwort innerhalb von ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS);
  });
  try {
    await Promise.race([client.connect(transport), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    const classified = tools.map((t) => classifyUpstreamTool(t, patterns));
    const unclassified = classified.filter((c) => c.class === "unclassified");
    return {
      checks: [
        { ok: true, label: "Upstream-Server startet und antwortet (MCP initialize)" },
        {
          ok: tools.length > 0,
          label: `Tools gefunden: ${tools.length}`,
          fix: "Der Server meldet keine Tools. Prüfen, ob der richtige Server gestartet wird.",
        },
        {
          ok: unclassified.length === 0,
          label:
            unclassified.length === 0
              ? "Alle Tools eindeutig als Lese- oder Schreib-Tool eingeordnet"
              : `${unclassified.length} Tool(s) nicht eindeutig einordenbar: ${unclassified.map((c) => c.name).join(", ")}`,
          fix: "Mit --write-tools bzw. --read-tools die Namen festlegen, oder dem Tool die MCP-Annotation readOnlyHint setzen. Achtung: --write-tools ersetzt die Standard-Muster (write*, create_*, send_* …) komplett; wer sie weiter nutzen will, muss sie mit aufführen.",
        },
      ],
      toolLines: classified.map((c) => `  ${c.class.padEnd(12)} ${c.name}  (${c.source})`),
    };
  } catch (err) {
    const tail = stderrText.trim().split("\n").slice(-8).map((l) => `    ${l}`).join("\n");
    const detail = `${(err as Error).message}${tail ? `\n    Upstream-Fehlerausgabe:\n${tail}` : ""}`;
    return {
      checks: [
        {
          ok: false,
          label: "Upstream-Server startet und antwortet (MCP initialize)",
          detail,
          fix: "Startbefehl und Argumente prüfen. Die Ausgabe oben zeigt, was der Server selbst gemeldet hat.",
        },
      ],
      toolLines: [],
    };
  } finally {
    if (timer) clearTimeout(timer);
    await client.close().catch(() => undefined);
  }
}

function printCheck(check: Check): void {
  process.stdout.write(`${check.ok ? "OK     " : "FEHLER "} ${check.label}\n`);
  if (check.detail) process.stdout.write(`        ${check.detail}\n`);
  if (!check.ok && check.fix) process.stdout.write(`        → ${check.fix}\n`);
}

export interface DoctorInput {
  command?: string;
  upstreamArgs: string[];
  cwd?: string;
  reportFile?: string;
  writeTools: string[];
  readTools: string[];
}

export interface DoctorResult {
  checks: Check[];
  toolLines: string[];
  ok: boolean;
}

// Alle Prüfungen als Daten, damit Kommandozeile und Oberfläche dasselbe nutzen.
export async function collectDoctor(input: DoctorInput): Promise<DoctorResult> {
  const checks: Check[] = [checkNode()];
  let toolLines: string[] = [];

  if (input.command === undefined || input.command.trim() === "") {
    checks.push({
      ok: false,
      label: "--upstream-command angegeben",
      fix: "Beispiel: doctor --upstream-command node --upstream-arg <pfad\\zu\\server.js>",
    });
  } else {
    const cwd = resolve(input.cwd ?? process.cwd());
    checks.push({ ok: true, label: `--upstream-command: ${input.command}` });
    if (input.cwd !== undefined) {
      const isDir = await stat(cwd).then((st) => st.isDirectory(), () => false);
      checks.push({ ok: isDir, label: `--upstream-cwd ist ein Ordner: ${cwd}`, fix: "Den Ordner anlegen oder den Pfad korrigieren." });
    }
    const scriptCheck = checkUpstreamScript(input.command, input.upstreamArgs, cwd);
    if (scriptCheck) checks.push(scriptCheck);
    if (scriptCheck?.ok !== false) {
      const protocol = await checkUpstreamProtocol(input.command, input.upstreamArgs, cwd, {
        writeToolPatterns: input.writeTools,
        readToolPatterns: input.readTools,
      });
      checks.push(...protocol.checks);
      toolLines = protocol.toolLines;
    }
  }

  if (input.reportFile !== undefined) {
    checks.push(await checkReportFile(input.reportFile));
  }
  return { checks, toolLines, ok: checks.every((c) => c.ok) };
}

export async function runDoctor(argv: string[]): Promise<number> {
  process.stdout.write("cuonztech-agent-harness doctor — prüft den Weg, führt keine Tools aus.\n\n");
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Nutzung: doctor --upstream-command <cmd> [--upstream-arg <arg> ...] [--upstream-cwd <dir>] [--write-tools a,b] [--read-tools a,b] [--report-file <datei>]\n\n" +
        "Startet deinen MCP-Server, fragt nur initialize und tools/list ab und prüft Node-Version, Start-Datei, Tool-Einordnung und Report-Pfad.\n" +
        "Es wird nie ein Tool ausgeführt. Optionen wie beim Proxy.\n",
    );
    return 0;
  }
  const parsed = parseDoctorArgs(argv);

  if (parsed.empty.length > 0) {
    process.stdout.write(`Option(en) ohne Wert: ${[...new Set(parsed.empty)].join(" ")}\n`);
    return 1;
  }
  if (parsed.unknown.length > 0) {
    process.stdout.write(`Unbekannte Option(en): ${parsed.unknown.join(" ")}\n`);
    process.stdout.write("Nutzung: doctor --upstream-command <cmd> [--upstream-arg <arg> ...] [--upstream-cwd <dir>] [--write-tools a,b] [--read-tools a,b] [--report-file <datei>]\n");
    return 1;
  }

  const { checks, toolLines } = await collectDoctor(parsed);
  checks.forEach(printCheck);
  if (toolLines.length > 0) {
    process.stdout.write("\nErkannte Tools (nur Einordnung, nichts wurde ausgeführt):\n");
    toolLines.forEach((line) => process.stdout.write(`${line}\n`));
  }

  const failed = checks.filter((c) => !c.ok).length;
  process.stdout.write(
    failed === 0
      ? "\nAlles bereit. Der Proxy-Befehl kann gestartet werden.\n"
      : `\n${failed} Punkt(e) fehlen. Die Lösungen stehen jeweils darunter.\n`,
  );
  return failed === 0 ? 0 : 1;
}
