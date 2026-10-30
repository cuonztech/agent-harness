// Geführte Oberfläche für Menschen ohne Terminal. Kleiner lokaler Server
// (nur 127.0.0.1, Zufalls-Token, Host-Prüfung), der dieselben Bausteine nutzt wie
// die Kommandozeile: doctor, report, benchmark. Keine Abhängigkeiten.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectDoctor } from "../doctor.js";
import { renderHtml, renderHtmlBody, type ReportFile } from "../plain-report.js";
import { renderDossierHtml } from "../dossier-report.js";
import { discoverMcpServers } from "./discover.js";
import { evaluateAgentClaim } from "../core/claim-check.js";
import { runCampaign, renderCampaignDemoBody, followupSummary } from "../campaign/runner.js";
import { runBenchmark, defaultConfig, type ReferenceRun } from "../benchmark/runner.js";
import { VERSION } from "../version.js";
import { PAGE_HTML } from "./page.js";
import { resolveLicense, verifyLicense, resolveProGate, lockedNotice } from "../license/index.js";

const MAX_BODY = 64 * 1024;
const MAX_NAME = 200;
const MAX_AGENT_RESPONSE = 10_000;
const UI_SCENARIOS = ["F1", "F2", "F3", "F4", "F5"] as const;
type UiScenario = (typeof UI_SCENARIOS)[number];

// Angaben der laufenden Prüfung: wohin der Proxy schreibt und was in das Dossier gehört.
interface UiSession {
  reportFile: string;
  scenario: UiScenario;
  customerName?: string;
  systemName?: string;
  agentResponse?: string;
}

export interface UiOptions {
  port?: number;
  open?: boolean;
  licenseKey?: string;
}

export interface UiHandle {
  url: string;
  close(): Promise<void>;
}

function cliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");
}

function bundledTestsystem(): string | null {
  const candidate = resolve(dirname(cliPath()), "..", "examples", "testsystem", "server.mjs");
  return existsSync(candidate) ? candidate : null;
}

// Ein Argument so quoten, dass es in Terminal-Befehlen mit Leerzeichen funktioniert.
function quoteArg(arg: string): string {
  return /^[A-Za-z0-9_@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("Anfrage zu gross");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Ungültige Anfrage");
  return value as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ...extra,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8");
}

// "a, b,c" -> ["a","b","c"]; optional text field of the page.
function patternList(value: unknown, what: string): string[] {
  if (value === undefined || value === "") return [];
  if (typeof value !== "string" || value.length > 1000) throw new Error(`${what} ist ungültig`);
  return value.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
}

// Der Agent startet den Harness oft aus einem anderen Ordner: ein relativer
// Pfad zu einer vorhandenen Datei wird hier festgeschrieben.
function absolutizeExisting(args: string[]): string[] {
  return args.map((a) => (a !== "" && !a.startsWith("-") && !isAbsolute(a) && existsSync(resolve(a)) ? resolve(a) : a));
}

// Freitextfeld der Seite: leer = nicht angegeben; zu lang oder kein Text = Fehler.
function optionalText(value: unknown, what: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length > max) throw new Error(`${what} ist ungültig`);
  const text = value.trim();
  return text === "" ? undefined : text;
}

function scenarioOf(value: unknown): UiScenario {
  if (value === undefined) return "F1";
  if (typeof value !== "string" || !(UI_SCENARIOS as readonly string[]).includes(value)) throw new Error("Szenario ist ungültig");
  return value as UiScenario;
}

function stringArray(value: unknown, what: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some((v) => typeof v !== "string" || v.length > 1000)) {
    throw new Error(`${what} ist ungültig`);
  }
  return value as string[];
}

function demoFile(run: ReferenceRun): ReportFile {
  const report = run.reports[0]!;
  return {
    harnessVersion: VERSION,
    certification: "UNVERIFIED_FOR_PRODUCTION",
    verdict: report.verdict,
    report,
    score: run.score,
    patches: run.patches,
    generatedAt: new Date().toISOString(),
  } as ReportFile;
}

export async function startUi(options: UiOptions = {}): Promise<UiHandle> {
  const token = randomBytes(16).toString("hex");
  let port = 0;
  let session: UiSession | null = null;

  const readSessionReport = async (): Promise<ReportFile | null> => {
    if (!session) return null;
    try {
      return JSON.parse(await readFile(session.reportFile, "utf8")) as ReportFile;
    } catch {
      return null; // noch nicht da oder gerade im Schreiben
    }
  };

  // Der Proxy schreibt die Datei nach jedem Aufruf neu und kennt die Antwort des Agenten nicht:
  // Eine in der Oberfläche eingetragene Antwort wird daher beim Anzeigen gegen den aktuellen Bericht geprüft.
  const withSessionClaim = (file: ReportFile): ReportFile => {
    if (session?.agentResponse && file.report && !file.claim_check) {
      return { ...file, claim_check: evaluateAgentClaim(session.agentResponse, file.report) };
    }
    return file;
  };

  let currentLicenseVerdict = resolveLicense(options.licenseKey);
  // Nur ein ausdrücklich übergebener, gültiger Schlüssel wird in die erzeugte Agenten-Konfiguration übernommen
  // (damit der Proxy des Agenten die Pro-Teile in den Report schreibt); aus der Umgebung stammende nie.
  let explicitLicenseKey: string | undefined = options.licenseKey;

  const dossierOptions = (): {
    customerName?: string;
    systemName?: string;
    agentResponse?: string;
    licenseVerdict?: typeof currentLicenseVerdict;
  } => ({
    customerName: session?.customerName,
    systemName: session?.systemName,
    agentResponse: session?.agentResponse,
    licenseVerdict: currentLicenseVerdict,
  });

  // Gleiche Vorsicht wie der Proxy: erst in eine eigene Datei, dann darüber umbenennen.
  const writeReportFile = async (path: string, file: ReportFile): Promise<void> => {
    const tmp = `${path}.ui-${randomBytes(6).toString("hex")}.tmp`;
    const text = JSON.stringify(file, null, 2);
    try {
      await writeFile(tmp, text, { encoding: "utf8", flag: "wx" });
      await rename(tmp, path);
    } catch {
      await unlink(tmp).catch(() => undefined);
      await writeFile(path, text, "utf8");
    }
  };

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "Fehler" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return sendJson(res, 403, { error: "Host nicht erlaubt" });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    const queryToken = url.searchParams.get("t") ?? undefined;
    const headerToken = req.headers["x-harness-token"];
    const given = typeof headerToken === "string" ? headerToken : queryToken;
    if (!sameToken(given, token)) {
      return sendJson(res, 403, { error: "Zugriff nur über den ausgegebenen Link möglich" });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, PAGE_HTML.replace("__TOKEN__", token), "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/api/info") {
      return sendJson(res, 200, {
        version: VERSION,
        bundledTestsystem: bundledTestsystem(),
        discoveredServers: discoverMcpServers(),
        license: {
          valid: currentLicenseVerdict.valid,
          tier: currentLicenseVerdict.tier ?? "evaluation",
          claims: currentLicenseVerdict.claims,
          reason: currentLicenseVerdict.reason,
        },
      });
    }
    if (req.method === "POST" && url.pathname === "/api/license") {
      const body = await readJson(req);
      const key = typeof body.key === "string" ? body.key.trim() : "";
      currentLicenseVerdict = verifyLicense(key);
      explicitLicenseKey = key;
      return sendJson(res, 200, {
        valid: currentLicenseVerdict.valid,
        tier: currentLicenseVerdict.tier ?? "evaluation",
        claims: currentLicenseVerdict.claims,
        reason: currentLicenseVerdict.reason,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/doctor") {
      const body = await readJson(req);
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (command.length > 300) throw new Error("Programm ist zu lang");
      const result = await collectDoctor({
        command,
        upstreamArgs: absolutizeExisting(stringArray(body.args, "Argumente")),
        writeTools: patternList(body.writeTools, "Schreib-Tools"),
        readTools: patternList(body.readTools, "Lese-Tools"),
      });
      return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readJson(req);
      const command = typeof body.command === "string" ? body.command.trim() : "";
      if (!command) throw new Error("Programm fehlt");
      // Die Bestätigung gilt auch hier, nicht nur als Schalter im Browser: ohne sie entsteht keine Konfiguration, die Schreibvorgänge ausführt.
      if (body.confirmedTestsystem !== true) throw new Error("Bestätigung fehlt: Der Test führt echte Schreibvorgänge aus und darf nur gegen ein Testsystem laufen");
      const scenario = scenarioOf(body.scenario);
      const customerName = optionalText(body.customerName, "Auftraggeber", MAX_NAME);
      const systemName = optionalText(body.systemName, "System", MAX_NAME);
      const args = absolutizeExisting(stringArray(body.args, "Argumente"));
      const writeTools = patternList(body.writeTools, "Schreib-Tools");
      const readTools = patternList(body.readTools, "Lese-Tools");
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const baseDir = process.env.CUONZTECH_HARNESS_DIR ?? join(homedir(), "CuonzTech-Agent-Harness");
      const runDir = join(baseDir, stamp);
      await mkdir(runDir, { recursive: true });
      const reportFile = join(runDir, "harness-report.json");
      session = { reportFile, scenario, customerName, systemName };

      const proxyArgs = [
        cliPath(), "proxy",
        "--upstream-command", command,
        ...args.flatMap((a) => ["--upstream-arg", a]),
        // Das mitgelieferte Testsystem schreibt in den Lauf-Ordner, nicht neben das Programm.
        ...(args.includes(bundledTestsystem() ?? "\0") ? ["--upstream-env-var", `TESTSYSTEM_DATA=${join(runDir, "bookings.json")}`] : []),
        ...(writeTools.length > 0 ? ["--write-tools", writeTools.join(",")] : []),
        ...(readTools.length > 0 ? ["--read-tools", readTools.join(",")] : []),
        "--scenario", scenario,
        "--allow-writes",
        "--audit-tools", "off",
        "--report-file", reportFile,
        ...(currentLicenseVerdict.valid && explicitLicenseKey ? ["--license", explicitLicenseKey] : []),
      ];
      const claudeCode = ["claude mcp add --scope user agent-harness --", process.execPath, ...proxyArgs].map((p, i) => (i === 0 ? p : quoteArg(p))).join(" ");
      const claudeDesktop = JSON.stringify({ mcpServers: { "agent-harness": { command: process.execPath, args: proxyArgs } } }, null, 2);
      return sendJson(res, 200, { claudeCode, claudeDesktop, reportFile, scenario });
    }
    if (req.method === "POST" && url.pathname === "/api/dossier-meta") {
      const body = await readJson(req);
      if (!session) throw new Error("Es läuft noch keine Prüfung: bitte zuerst Schritt 3 abschliessen");
      // Erst alles prüfen, dann übernehmen: ein ungültiges Feld ändert nichts.
      const next = {
        customerName: "customerName" in body ? optionalText(body.customerName, "Auftraggeber", MAX_NAME) : session.customerName,
        systemName: "systemName" in body ? optionalText(body.systemName, "System", MAX_NAME) : session.systemName,
        agentResponse: "agentResponse" in body ? optionalText(body.agentResponse, "Antwort des Agenten", MAX_AGENT_RESPONSE) : session.agentResponse,
      };
      Object.assign(session, next);
      const file = await readSessionReport();
      if (!file?.report) return sendJson(res, 200, { ok: true, claimCheck: null });
      // Nur claim_check ändert sich; report, schema_audit und call_forensics bleiben, damit der Integritäts-Nachweis gültig bleibt.
      if (session.agentResponse) file.claim_check = evaluateAgentClaim(session.agentResponse, file.report);
      else delete file.claim_check;
      await writeReportFile(session.reportFile, file);
      return sendJson(res, 200, { ok: true, claimCheck: file.claim_check ?? null, body: renderHtmlBody(file).join("\n") });
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      if (!session) return sendJson(res, 200, { state: "waiting" });
      const file = await readSessionReport();
      if (!file) return sendJson(res, 200, { state: "waiting" });
      if (typeof file.startupError === "string" && file.startupError !== "") {
        return sendJson(res, 200, { state: "error", startupError: file.startupError, body: renderHtmlBody(file).join("\n") });
      }
      if (!file.report) return sendJson(res, 200, { state: "connected" });
      return sendJson(res, 200, { state: "result", verdict: file.verdict, body: renderHtmlBody(withSessionClaim(file)).join("\n") });
    }
    if (req.method === "GET" && url.pathname === "/api/report.html") {
      const file = await readSessionReport();
      if (!file) return sendJson(res, 404, { error: "Noch kein Bericht vorhanden" });
      return send(res, 200, renderHtml(withSessionClaim(file)), "text/html; charset=utf-8", {
        "content-disposition": 'attachment; filename="agent-test-bericht.html"',
      });
    }
    // Das Dossier wird im Browser angezeigt (und von dort gedruckt), nicht als Datei geladen.
    if (req.method === "GET" && (url.pathname === "/api/dossier" || url.pathname === "/dossier")) {
      const file = await readSessionReport();
      if (!file) return sendJson(res, 404, { error: "Noch kein Bericht vorhanden" });
      return send(res, 200, renderDossierHtml(file, dossierOptions()), "text/html; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/api/demo") {
      const config = defaultConfig();
      config.scenarios = ["F1"];
      const result = await runBenchmark(config);
      // Der Vorher/Nachher-Vergleich mit Nutzer-Nachdruck im 2. Zug (Kampagne, alle Szenarien, je ein Lauf).
      const campaign = runCampaign({ runsPerScenario: 1 });
      return sendJson(res, 200, {
        careful: renderHtmlBody(demoFile(result.careful)).join("\n"),
        naive: renderHtmlBody(demoFile(result.naive)).join("\n"),
        campaignHtml: renderCampaignDemoBody(campaign),
        pressure: { summary: campaign.beforeAfterSummaryDe, followup: followupSummary(campaign) },
      });
    }
    sendJson(res, 404, { error: "Nicht gefunden" });
  }

  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(options.port ?? 0, "127.0.0.1", () => ok());
  });
  const address = server.address();
  port = typeof address === "object" && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}/?t=${token}`;

  if (options.open !== false) openBrowser(url);
  return {
    url,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]]
    : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // Der Link steht auch im Terminal.
  }
}

export async function runUiMode(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Nutzung: ui [--port <n>] [--no-open] [--license <key>]\n\n" +
        "Startet die geführte Oberfläche im Browser (nur auf diesem Rechner, mit Zufalls-Schlüssel im Link).\n" +
        "Die Oberfläche gehört zum Pro-Umfang und braucht einen gültigen Lizenzschlüssel (oder AGENT_AUDIT_LICENSE).\n" +
        "  --port <n>      feste Port-Nummer (Standard: ein freier Port)\n" +
        "  --no-open       den Browser nicht automatisch öffnen\n" +
        "  --license <key> CuonzTech Agent Audit Pro Lizenzschlüssel (oder Umgebungsvariable AGENT_AUDIT_LICENSE)\n",
    );
    return 0;
  }
  let port: number | undefined;
  let open = true;
  let licenseKey: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--no-open") open = false;
    else if (token === "--license") {
      licenseKey = argv[++i] ?? "";
    } else if (token === "--port") {
      if (port !== undefined) {
        process.stderr.write("Error: option --port was given more than once.\n");
        return 1;
      }
      const raw = argv[++i] ?? "";
      if (!/^\d+$/.test(raw) || Number(raw) > 65535) {
        process.stderr.write(`Error: --port must be a number between 0 and 65535, got "${raw}".\n`);
        return 1;
      }
      port = Number(raw);
    } else {
      process.stderr.write(`Error: unknown option ${token}\nUsage: ui [--port <n>] [--no-open]\n`);
      return 1;
    }
  }
  // Pro-Umfang: ohne gültige Lizenz startet die Oberfläche nicht (klarer Hinweis, Exit 1 wie jeder nicht ausgeführte Befehl).
  // Das Frei-Paket bleibt über die Kommandozeile vollständig nutzbar (proxy, doctor, report).
  const gate = resolveProGate(licenseKey);
  if (!gate.pro) {
    process.stderr.write(lockedNotice("ui", gate.verdict));
    return 1;
  }
  const handle = await startUi({ port, open, licenseKey });
  process.stdout.write(`Oberfläche: ${handle.url}\n`);
  process.stdout.write("Läuft nur auf diesem Rechner. Beenden mit Strg+C.\n");
  await new Promise<void>((ok) => {
    const stop = (): void => {
      void handle.close().then(ok);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
