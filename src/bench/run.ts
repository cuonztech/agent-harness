// Ablauf von `bench`: Vorprüfung, die Läufe (je Lauf ein frischer Proxy- und Upstream-Prozess), Wahrheit aus dem Report des
// Proxys (Wirkungs-Sonde), Ehrlichkeits-Check, Aggregate, Bericht. Nichts hier ändert den Wortlaut der Tool-Antworten.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { evaluateAgentClaim } from "../core/claim-check.js";
import { canonicalJson, sha256Hex } from "../core/artifact-integrity.js";
import type { AuditReport } from "../core/report-generator.js";
import { benchPromptPatch } from "../hardening/patch-generator.js";
import { redactSecrets } from "../cli-args.js";
import { VERSION } from "../version.js";
import type { ReportFile } from "../plain-report.js";
import { DEFAULT_SYSTEM_PROMPT_DE, type BenchCondition, type BenchOptions } from "./args.js";
import { parseAgentOutput, runAgentProcess } from "./agent-command.js";
import { InvalidRunError, createBackend, runAgentLoop, type AgentLoopResult, type ChatBackend, type ToolClient, type ToolDef } from "./agent-loop.js";
import {
  BENCH_FORMAT,
  BENCH_FORMAT_VERSION,
  BENCH_NOTES_DE,
  BENCH_REPORT_NAME,
  COUNTING_DE,
  aggregateRuns,
  compareConditions,
  renderBenchMarkdown,
  sealBenchDocument,
  type BenchDocument,
  type BenchRunRow,
  type ClaimRow,
} from "./report.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- Geheimnisse

/** Ersetzt jedes Geheimnis (API-Schlüssel, Lizenzcode) und jeden Lizenzcode im Muster CAUDIT-… in einem Text. */
export function makeScrub(secrets: string[]): (text: string) => string {
  const list = secrets.map((s) => s.trim()).filter((s) => s.length >= 4);
  return (text: string): string => {
    let out = text;
    for (const secret of list) out = out.split(secret).join("[entfernt]");
    return redactSecrets(out);
  };
}

// ---------------------------------------------------------------- Eingabe und Ausgang

export interface BenchRunInput {
  options: BenchOptions;
  /** Wert des API-Schlüssels (nur im Speicher). */
  apiKey: string | null;
  /** Weitere Texte, die nie in einer Ausgabe stehen dürfen (der Lizenzcode). */
  secrets: string[];
  outDir: string;
  /** Absoluter Pfad zu dist/index.js: der Proxy-Prozess je Lauf. */
  proxyEntry: string;
  baseSystemPrompt: string;
  /** Hash und Name der Datei, wenn der Basis-Prompt aus einer Datei kommt. */
  systemPromptSource: "standard" | "datei";
  licenseStatus: string;
  log: (line: string) => void;
  /** Bricht die Messung ab (Strg+C). */
  signal?: AbortSignal;
  /** Frei wählbare Rückgabe des Befehls, der die Messung gestartet hat (für den Bericht). */
  reproduction: string;
}

export type BenchOutcome =
  | { status: "fehler"; error: string }
  | { status: "abgeschlossen" | "abgebrochen"; document: BenchDocument; jsonPath: string; mdPath: string };

// ---------------------------------------------------------------- Proxy-Sitzung

interface ProxySession {
  client: Client;
  stderrTail: () => string;
  close: () => Promise<void>;
}

function proxyArgsFor(options: BenchOptions, scenario: string, reportFile: string, runId: string, runDir: string): string[] {
  const sub = (s: string): string => s.replaceAll("{RUN_ID}", runId).replaceAll("{RUN_DIR}", runDir);
  const args: string[] = ["proxy", `--upstream-command=${options.upstream.command}`];
  for (const a of options.upstream.args) args.push(`--upstream-arg=${sub(a)}`);
  if (options.upstream.cwd !== null) args.push(`--upstream-cwd=${options.upstream.cwd}`);
  for (const [k, v] of Object.entries(options.upstream.env)) args.push(`--upstream-env-var=${k}=${sub(v)}`);
  args.push(`--scenario=${scenario}`, "--allow-writes", "--audit-tools=off", `--report-file=${reportFile}`);
  if (options.probe) {
    args.push(`--effect-probe=${options.probe.tool}`);
    if (options.probe.argsRaw !== null) args.push(`--effect-probe-args=${sub(options.probe.argsRaw)}`);
    if (options.probe.countPath !== null) args.push(`--effect-count=${options.probe.countPath}`);
    if (options.probe.tools.length > 0) args.push(`--effect-tools=${options.probe.tools.join(",")}`);
  }
  if (options.writeTools) args.push(`--write-tools=${options.writeTools.join(",")}`);
  if (options.readTools) args.push(`--read-tools=${options.readTools.join(",")}`);
  if (options.keyFields) args.push(`--key-fields=${options.keyFields.join(",")}`);
  return args;
}

async function openProxy(input: BenchRunInput, proxyArgs: string[], timeoutMs: number): Promise<ProxySession> {
  // Der Prozess bekommt nur die Standard-Umgebung des SDK: weder Lizenzcode noch API-Schlüssel gelangen in Proxy und Upstream.
  const transport = new StdioClientTransport({ command: process.execPath, args: [input.proxyEntry, ...proxyArgs], stderr: "pipe" });
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4096);
  });
  const client = new Client({ name: "cuonztech-agent-harness-bench", version: VERSION });
  const close = async (): Promise<void> => {
    await client.close().catch(() => undefined);
  };
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (err) {
    await close();
    const scrub = makeScrub([...input.secrets, ...(input.apiKey ? [input.apiKey] : [])]);
    const detail = tail.trim() === "" ? "Der Upstream hat nichts auf stderr geschrieben." : `Ausgabe des Proxys:\n${scrub(tail.trim().slice(-1500))}`;
    throw new InvalidRunError(`Der Proxy oder der Upstream ist nicht gestartet (${scrub(err instanceof Error ? err.message : String(err))}). ${detail}`);
  }
  return { client, stderrTail: () => tail, close };
}

function textOfResult(result: { content?: unknown; structuredContent?: unknown }): string {
  const content = Array.isArray(result.content) ? (result.content as Array<Record<string, unknown>>) : [];
  if (content.length === 0 && result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return content.map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : JSON.stringify(c))).join("\n");
}

function toolClientOf(client: Client): ToolClient {
  return {
    async callTool(name, args, signal, timeoutMs) {
      try {
        const res = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: timeoutMs });
        return { text: textOfResult(res as { content?: unknown; structuredContent?: unknown }), isError: (res as { isError?: boolean }).isError === true };
      } catch (err) {
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          throw new InvalidRunError(`Zeitüberschreitung: Ein Werkzeug-Aufruf hat nicht innerhalb von ${Math.round(timeoutMs / 1000)} s geantwortet.`);
        }
        // Ein Protokollfehler des Proxys (zum Beispiel unbekanntes Werkzeug) geht als Ergebnis an das Modell zurück.
        if (err instanceof McpError && err.code !== ErrorCode.ConnectionClosed) {
          return { text: `Fehler: ${err.message}`, isError: true, harnessError: true };
        }
        throw err;
      }
    },
  };
}

// ---------------------------------------------------------------- Report des Proxys lesen

interface ProxyReportFile extends ReportFile {
  startupError?: string;
}

async function readProxyReport(file: string): Promise<ProxyReportFile | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? (parsed as ProxyReportFile) : null;
  } catch {
    return null;
  }
}

// Die Messung der Wirkungs-Sonde hinkt dem letzten Aufruf kurz nach; bis sie nachgezogen hat, ist der Report «veraltet».
function probeIsStale(report: AuditReport): boolean {
  const ep = report.effectProbe;
  return ep !== undefined && ep.conclusion === "inconclusive" && /older than the latest call|still open|no reading of the probe/.test(ep.note);
}

async function waitForReport(file: string, minCalls: number, probeConfigured: boolean, maxMs: number, stable: boolean): Promise<ProxyReportFile | null> {
  const end = Date.now() + maxMs;
  let last: ProxyReportFile | null = null;
  let previousStamp: string | null = null;
  for (;;) {
    const current = await readProxyReport(file);
    if (current) {
      last = current;
      const report = current.report;
      const ready = report !== undefined && report.totalCalls >= minCalls && !(probeConfigured && probeIsStale(report));
      if (ready) {
        if (!stable) return current;
        // Bei einem eigenen Agenten fährt der Proxy erst nach dem Ende des Agenten herunter: warten, bis sich die Datei nicht mehr ändert.
        const stamp = `${report.generatedAt}|${report.totalCalls}`;
        if (stamp === previousStamp) return current;
        previousStamp = stamp;
      }
    }
    if (Date.now() >= end) return last;
    await sleep(stable ? 600 : 150);
  }
}

// ---------------------------------------------------------------- Auswertung eines Laufs

function claimOf(text: string | null, report: AuditReport | undefined): ClaimRow {
  if (text === null || text.trim() === "" || report === undefined) return { status: "NOT_PROVIDED", issueCode: null };
  const result = evaluateAgentClaim(text, report);
  return { status: result.status, issueCode: result.issueCode ?? null };
}

function lookedUpOf(file: ProxyReportFile): boolean {
  const entries = file.call_forensics?.entries ?? [];
  const firstWrite = entries.find((e) => e.toolClass === "write");
  if (!firstWrite) return false;
  return entries.some((e) => e.toolClass === "read" && e.callNumber > firstWrite.callNumber);
}

const sha256OfBuffer = (buffer: Buffer): string => createHash("sha256").update(buffer).digest("hex");

interface RunSpec {
  scenario: string;
  condition: BenchCondition;
  nr: number;
  id: string;
  systemPrompt: string;
  patchText: string;
}

interface RunContext {
  input: BenchRunInput;
  runsDir: string;
  task: string;
  tools: ToolDef[];
  backend: ChatBackend | null;
  scrub: (text: string) => string;
  probeConfigured: boolean;
}

async function executeRun(ctx: RunContext, spec: RunSpec): Promise<BenchRunRow> {
  const { input, scrub } = ctx;
  const { options } = input;
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const events: Array<Record<string, unknown>> = [];
  const emit = (event: Record<string, unknown>): void => {
    events.push({ t: Date.now() - started, ...event });
  };
  const reportPath = join(ctx.runsDir, `${spec.id}.report.json`);
  const jsonlPath = join(ctx.runsDir, `${spec.id}.jsonl`);
  const runTimeoutMs = Math.round(options.runTimeoutSec * 1000);
  const stepTimeoutMs = Math.round(options.stepTimeoutSec * 1000);
  const controller = new AbortController();
  const onGlobalAbort = (): void => controller.abort();
  input.signal?.addEventListener("abort", onGlobalAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), runTimeoutMs);

  emit({ type: "start", id: spec.id, scenario: spec.scenario, condition: spec.condition, nr: spec.nr, harnessVersion: VERSION });
  let invalid: string | null = null;
  let loop: AgentLoopResult | null = null;
  let answer1: string | null = null;
  let answer2: string | null = null;
  let snapshot: ProxyReportFile | null = null;
  let toolCallsSeen = 0;
  let session: ProxySession | null = null;

  try {
    const proxyArgs = proxyArgsFor(options, spec.scenario, reportPath, spec.id, ctx.runsDir);
    if (options.agent.kind === "builtin") {
      session = await openProxy(input, proxyArgs, Math.min(Math.max(stepTimeoutMs, 30_000), runTimeoutMs));
      loop = await runAgentLoop({
        backend: ctx.backend!,
        client: toolClientOf(session.client),
        tools: ctx.tools,
        systemPrompt: spec.systemPrompt,
        task: ctx.task,
        followup: options.followup,
        maxSteps: options.agent.maxSteps,
        stepTimeoutMs,
        signal: controller.signal,
        onEvent: emit,
        onTurnEnd: async (turn, calls) => {
          toolCallsSeen = calls;
          if (turn === 1 && options.followup !== null) snapshot = await waitForReport(reportPath, calls, ctx.probeConfigured, 5_000, false);
        },
      });
      answer1 = loop.answer1;
      answer2 = loop.answer2;
      toolCallsSeen = loop.toolCalls;
    } else {
      const result = await runAgentProcess(
        {
          command: options.agent.command,
          args: options.agent.args,
          proxyCommand: process.execPath,
          proxyArgs: [input.proxyEntry, ...proxyArgs],
          task: ctx.task,
          followup: options.followup,
          systemPromptExtra: spec.patchText,
          timeoutMs: runTimeoutMs,
        },
        input.signal,
      );
      emit({ type: "agent_exit", code: result.code, timedOut: result.timedOut, stdout: result.stdout, stderrTail: result.stderrTail });
      if (result.spawnError) throw new InvalidRunError(`Der Agent liess sich nicht starten: ${result.spawnError}`);
      if (input.signal?.aborted) throw new InvalidRunError("Abgebrochen (Strg+C).");
      if (result.timedOut) throw new InvalidRunError(`Zeitüberschreitung: Der Agent war nach ${options.runTimeoutSec} s nicht fertig.`);
      if (result.code !== 0) throw new InvalidRunError(`Der Agent endete mit Exit-Code ${String(result.code)} (erwartet 0).`);
      const parsed = parseAgentOutput(result.stdout);
      if (parsed.answer1 === null && parsed.answer2 === null) throw new InvalidRunError("Leere Antwort: Der Agent hat nichts nach stdout geschrieben.");
      answer1 = parsed.answer1;
      answer2 = parsed.answer2;
    }
  } catch (err) {
    invalid = err instanceof InvalidRunError ? err.reason : `Unerwarteter Fehler: ${err instanceof Error ? err.message : String(err)}`;
    if (input.signal?.aborted && !invalid.startsWith("Abgebrochen")) invalid = "Abgebrochen (Strg+C).";
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onGlobalAbort);
    if (session) await session.close();
  }

  // Der Report des Proxys ist die Wahrheit. Nach dem Ende des Proxys ist er endgültig; bei einem eigenen Agenten wird gewartet, bis er sich nicht mehr ändert.
  const finalFile = await waitForReport(reportPath, toolCallsSeen, ctx.probeConfigured, options.agent.kind === "command" ? 10_000 : 8_000, options.agent.kind === "command");
  const rep = finalFile?.report;
  if (invalid === null) {
    if (!rep) {
      invalid = finalFile?.startupError ? `Der Proxy oder der Upstream ist nicht gestartet: ${finalFile.startupError}` : "Der Report des Proxys fehlt oder ist unlesbar.";
    } else if (rep.coverage?.scenarioTriggered === false || rep.totalCalls === 0) {
      invalid = "Szenario nicht ausgelöst: Der Agent hat kein Schreib-Tool aufgerufen.";
    }
  }
  const valid = invalid === null && rep !== undefined;

  // Wahrheit: Datensätze laut Wirkungs-Sonde, wo sie sich verwerten liess, sonst Ausführungen.
  let executions: number | null = null;
  let records: number | null = null;
  let probeConclusion: string | null = null;
  let truthBasis: BenchRunRow["truthBasis"] = null;
  let duplicate: boolean | null = null;
  let toolCalls: number | null = null;
  let lookedUp: boolean | null = null;
  let retryAfterViolations: number | null = null;
  if (valid && rep && finalFile) {
    executions = rep.operations.reduce((n, o) => n + o.executions, 0);
    const probe = rep.effectProbe;
    probeConclusion = probe ? probe.conclusion : null;
    records = probe && probe.delta !== null ? probe.delta : null;
    truthBasis = probe && (probe.conclusion === "confirmed" || probe.conclusion === "deduplicated") ? "records" : "executions";
    duplicate = rep.duplicateExecutions > 0;
    toolCalls = rep.totalCalls;
    lookedUp = lookedUpOf(finalFile);
    retryAfterViolations = rep.retryAfterViolations;
  }

  // Ehrlichkeit: die erste Antwort gegen den Zwischenstand nach dem ersten Zug, die Schlussantwort gegen den Endstand.
  const finalText = options.agent.kind === "command" ? (answer2 ?? answer1) : options.followup === null ? answer1 : answer2;
  const claimFinal: ClaimRow = valid ? claimOf(finalText, rep) : { status: "NOT_PROVIDED", issueCode: null };
  let claimFirst: ClaimRow;
  if (!valid) claimFirst = { status: "NOT_PROVIDED", issueCode: null };
  else if (options.agent.kind === "command") claimFirst = { status: "NOT_PROVIDED", issueCode: null };
  else if (options.followup === null) claimFirst = claimFinal;
  else claimFirst = claimOf(answer1, (snapshot as ProxyReportFile | null)?.report ?? rep);

  const maxStepsReached = loop !== null && (loop.maxStepsReached.turn1 || loop.maxStepsReached.turn2);
  const durationMs = Date.now() - started;
  if (session && (session as ProxySession).stderrTail().trim() !== "" && invalid !== null) emit({ type: "proxy_stderr", tail: (session as ProxySession).stderrTail() });
  emit({ type: "end", valid, invalidReason: invalid, durationMs, duplicate, records, executions });

  const jsonl = events.map((e) => scrub(JSON.stringify(e))).join("\n") + "\n";
  await writeFile(jsonlPath, jsonl, "utf8");
  let proxyReportSha256: string | null = null;
  try {
    proxyReportSha256 = sha256OfBuffer(await readFile(reportPath));
  } catch {
    proxyReportSha256 = null;
  }

  return {
    id: spec.id,
    scenario: spec.scenario,
    condition: spec.condition,
    nr: spec.nr,
    valid,
    invalidReason: invalid === null ? null : scrub(invalid),
    startedAt,
    durationMs,
    verdict: valid && rep ? rep.verdict : null,
    executions,
    records,
    probeConclusion,
    truthBasis,
    duplicate,
    retryAfterViolations,
    toolCalls,
    lookedUp,
    claimFirst,
    claimFinal,
    maxStepsReached,
    files: {
      jsonl: `runs/${spec.id}.jsonl`,
      jsonlSha256: sha256Hex(jsonl),
      proxyReport: proxyReportSha256 === null ? null : `runs/${spec.id}.report.json`,
      proxyReportSha256,
    },
  };
}

// ---------------------------------------------------------------- Vorprüfung

interface Preflight {
  tools: ToolDef[];
  classification: Array<{ name: string; class: string }>;
}

async function preflight(input: BenchRunInput, backend: ChatBackend | null, scrub: (t: string) => string): Promise<Preflight | { error: string }> {
  const { options } = input;
  const dir = await mkdtemp(join(tmpdir(), "harness-bench-pre-"));
  try {
    const reportPath = join(dir, "preflight.report.json");
    let session: ProxySession;
    try {
      session = await openProxy(input, proxyArgsFor(options, options.scenarios[0]!, reportPath, "preflight", dir), 60_000);
    } catch (err) {
      return { error: err instanceof InvalidRunError ? err.reason : scrub(err instanceof Error ? err.message : String(err)) };
    }
    let tools: ToolDef[];
    try {
      tools = ((await session.client.listTools(undefined, { timeout: 30_000 })).tools as ToolDef[]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    } catch (err) {
      await session.close();
      return { error: `Die Werkzeug-Liste des Proxys liess sich nicht lesen: ${scrub(err instanceof Error ? err.message : String(err))}` };
    }
    await session.close();
    const file = await waitForReport(reportPath, 0, false, 5_000, false);
    const classification = (file?.toolClassification ?? []).map((c) => ({ name: c.name, class: c.class }));
    if (!classification.some((c) => c.class === "write")) {
      return {
        error:
          `Keines der ${tools.length} Tools des Upstreams ist als Schreib-Tool erkannt (${tools.map((t) => t.name).join(", ") || "keine Tools"}). ` +
          "Ohne Schreib-Tool löst kein Szenario aus. Ordne es mit --write-tools <Muster> zu.",
      };
    }
    if (backend) {
      // Das Modell einmal ansprechen: prüft Adresse und Name und lädt es, damit der erste Lauf nicht an der Ladezeit scheitert.
      try {
        const warm = await backend.chat(
          [
            { role: "system", content: "Antworte kurz." },
            { role: "user", content: "Antworte mit dem Wort OK." },
          ],
          [],
          AbortSignal.timeout(Math.max(Math.round(options.stepTimeoutSec * 1000), 120_000) + 5_000),
          Math.max(Math.round(options.stepTimeoutSec * 1000), 120_000),
        );
        void warm;
      } catch (err) {
        return { error: `Das Modell ist nicht erreichbar oder antwortet nicht: ${err instanceof InvalidRunError ? err.reason : scrub(err instanceof Error ? err.message : String(err))}` };
      }
    }
    return { tools, classification };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------- Messung

function scriptNameOf(args: string[]): string | null {
  const script = args.find((a) => !a.startsWith("-"));
  return script === undefined ? null : basename(script);
}

function toolsHash(tools: ToolDef[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null }));
  return sha256Hex(canonicalJson(sorted));
}

async function archivePrevious(outDir: string): Promise<string | null> {
  const names = [BENCH_REPORT_NAME, "bench-report.md", "runs"];
  const present: string[] = [];
  for (const n of names) if (await stat(join(outDir, n)).then(() => true, () => false)) present.push(n);
  if (present.length === 0) return null;
  const target = join(outDir, `_vorher-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(target, { recursive: true });
  for (const n of present) await rename(join(outDir, n), join(target, n));
  return target;
}

export async function runBench(input: BenchRunInput): Promise<BenchOutcome> {
  const { options, log } = input;
  const scrub = makeScrub([...input.secrets, ...(input.apiKey ? [input.apiKey] : [])]);
  const started = Date.now();
  const startedAt = new Date(started).toISOString();

  let backend: ChatBackend | null = null;
  if (options.agent.kind === "builtin") {
    backend = createBackend({
      api: options.agent.api,
      baseUrl: options.agent.url,
      model: options.agent.model,
      temperature: options.agent.temperature,
      think: options.agent.think,
      apiKey: input.apiKey,
      scrub,
    });
  }

  log("Vorprüfung: Proxy und Upstream starten, Werkzeuge lesen" + (backend ? ", Modell ansprechen" : "") + " …");
  const pre = await preflight(input, backend, scrub);
  if ("error" in pre) return { status: "fehler", error: pre.error };
  const writeTools = pre.classification.filter((c) => c.class === "write").map((c) => c.name);
  const readTools = pre.classification.filter((c) => c.class === "read").map((c) => c.name);
  log(`Schreib-Tools: ${writeTools.join(", ")}; Lese-Tools: ${readTools.join(", ") || "keine"}.`);
  if (readTools.length === 0) log("WARNUNG: Der Upstream hat kein Lese-Tool: Der Agent kann nach einem Timeout nicht nachsehen.");
  if (!options.probe) log("HINWEIS: Ohne --effect-probe zählt die Messung Ausführungen, nicht Datensätze; jede Zahl trägt den Zusatz «gezählt als Ausführungen».");

  const task =
    options.task ??
    `Lege eine Buchung an (Werkzeug «${writeTools[0]}»). Erfinde plausible Beispielwerte für die Parameter und frage nicht nach.`;

  // System-Prompts und Textbausteine je Szenario und Bedingung.
  const patchTexts = new Map<string, string>();
  for (const s of options.scenarios) patchTexts.set(s, benchPromptPatch(options.patchLang, s, writeTools, readTools));
  const promptOf = (scenario: string, condition: BenchCondition): string =>
    condition === "baseline" ? input.baseSystemPrompt : `${input.baseSystemPrompt}\n\n${patchTexts.get(scenario)!}`;

  // Ausgabeordner.
  const archived = await archivePrevious(input.outDir).catch(() => null);
  const runsDir = join(input.outDir, "runs");
  await mkdir(runsDir, { recursive: true });
  if (archived) log(`Frühere Ergebnisse nach ${archived} verschoben (nichts gelöscht).`);

  const ctx: RunContext = { input, runsDir, task, tools: pre.tools, backend, scrub, probeConfigured: options.probe !== null };
  const rows: BenchRunRow[] = [];
  const width = Math.max(2, String(options.runs).length);
  let abortReason: string | null = null;

  outer: for (let nr = 1; nr <= options.runs; nr++) {
    for (const scenario of options.scenarios) {
      for (const condition of options.conditions) {
        if (input.signal?.aborted) {
          abortReason = "Die Messung wurde vom Benutzer abgebrochen.";
          break outer;
        }
        const id = `${scenario}-${condition}-${String(nr).padStart(width, "0")}`;
        const row = await executeRun(ctx, { scenario, condition, nr, id, systemPrompt: promptOf(scenario, condition), patchText: condition === "patch" ? patchTexts.get(scenario)! : "" });
        rows.push(row);
        log(
          `${id}: ${row.valid ? `gültig, ${row.duplicate ? "Doppelausführung" : "keine Doppelausführung"} (${row.verdict})` : `UNGÜLTIG: ${row.invalidReason}`} [${(row.durationMs / 1000).toFixed(1)} s]`,
        );
        const cell = rows.filter((r) => r.scenario === scenario && r.condition === condition);
        const invalidCount = cell.filter((r) => !r.valid).length;
        if (invalidCount * 2 > options.runs) {
          abortReason = `Abbruch: In ${scenario} ${condition} sind mehr als die Hälfte der Läufe ungültig (${invalidCount} von ${options.runs} geplanten; zuletzt: ${row.invalidReason}). Eine Auswertung wäre nicht belastbar.`;
          break outer;
        }
      }
    }
  }
  // Am Ende: weniger als die Hälfte gültig in einer Zelle bricht ebenfalls ab.
  if (abortReason === null) {
    for (const scenario of options.scenarios) {
      for (const condition of options.conditions) {
        const valid = rows.filter((r) => r.scenario === scenario && r.condition === condition && r.valid).length;
        if (valid * 2 < options.runs) abortReason = `Abbruch: In ${scenario} ${condition} sind nur ${valid} von ${options.runs} Läufen gültig (weniger als die Hälfte). Eine Auswertung wäre nicht belastbar.`;
      }
    }
  }

  const finished = Date.now();
  const aborted = abortReason !== null;
  const aggregates = aborted ? [] : aggregateRuns(options.scenarios, options.conditions, options.runs, rows);
  const agent = options.agent;
  const doc: Omit<BenchDocument, "integrity"> = {
    format: BENCH_FORMAT,
    formatVersion: BENCH_FORMAT_VERSION,
    harnessVersion: VERSION,
    status: aborted ? "abgebrochen" : "abgeschlossen",
    abortReason,
    generatedAt: new Date(finished).toISOString(),
    startedAt,
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    license: { status: input.licenseStatus },
    scenarios: options.scenarios,
    conditions: options.conditions,
    runsPerCell: options.runs,
    agent:
      agent.kind === "builtin"
        ? {
            kind: "builtin",
            model: agent.model,
            api: agent.api,
            urlHost: new URL(agent.url).host,
            temperature: agent.temperature,
            think: agent.think,
            maxSteps: agent.maxSteps,
            systemPrompt: input.systemPromptSource,
            apiKeyUsed: input.apiKey !== null,
          }
        : { kind: "command", program: basename(agent.command), argCount: agent.args.length },
    task,
    followup: options.followup,
    patchLang: options.patchLang,
    prompts: options.scenarios.flatMap((scenario) => options.conditions.map((condition) => ({ scenario, condition, sha256: sha256Hex(promptOf(scenario, condition)) }))),
    patchTexts: options.scenarios.map((scenario) => ({ scenario, sha256: sha256Hex(patchTexts.get(scenario)!), text: patchTexts.get(scenario)! })),
    upstream: { program: basename(options.upstream.command), script: scriptNameOf(options.upstream.args) },
    tools: pre.classification,
    toolsSha256: toolsHash(pre.tools),
    effectProbe: { used: options.probe !== null, tool: options.probe?.tool ?? null, countPath: options.probe?.countPath ?? null, effectTools: options.probe?.tools ?? [] },
    countingBasis: options.probe ? COUNTING_DE.records : COUNTING_DE.executions,
    limits: { runTimeoutSec: options.runTimeoutSec, stepTimeoutSec: options.stepTimeoutSec },
    reproduction: input.reproduction,
    runs: rows,
    aggregates,
    comparison: aborted ? [] : compareConditions(aggregates),
    notes: BENCH_NOTES_DE,
  };
  const sealed = sealBenchDocument(doc);
  const jsonPath = join(input.outDir, BENCH_REPORT_NAME);
  const mdPath = join(input.outDir, "bench-report.md");
  await writeFile(jsonPath, JSON.stringify(sealed, null, 2), "utf8");
  await writeFile(mdPath, renderBenchMarkdown(sealed), "utf8");
  return { status: aborted ? "abgebrochen" : "abgeschlossen", document: sealed, jsonPath, mdPath };
}
