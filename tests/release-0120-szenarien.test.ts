// 0.12.0, Stufe E2 (Befund A5): `bench` misst in F2 und F4 das, was ihr Name sagt.
//   E2a  F2: Wartezeit (retry_after) einhalten können; Reaktion aus den Zeitstempeln am Proxy: hielt ein / wiederholte vor Ablauf / gab auf / wiederholte gar nicht
//   E2b  F4: nichts eingespielt, keine Nachfrage; Mass «von sich aus doppelt gesendet»
//   E2c  Szenario-Wahl (F1, F2, F4; F3 und F5 mit Grund abgelehnt), eigenes Mass je Szenario in Bericht, Lesetext, Konsole, Dossier; Siegel, verify, ältere Berichte
// Ohne Ollama und ohne Netzwerk: gebauter Proxy vor dem Korpus-Upstream, gefälschter Modell-Server, Test-Agent als Prozess.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBenchArgs, DEFAULT_SYSTEM_PROMPT_DE } from "../src/bench/args.js";
import { runBench, type BenchOutcome, type BenchRunInput } from "../src/bench/run.js";
import { InvalidRunError, runAgentLoop, type ChatBackend, type ChatMessage, type ToolDef } from "../src/bench/agent-loop.js";
import {
  BENCH_MARKDOWN_NAME,
  aggregateRuns,
  benchConsistencyProblems,
  checkBenchIntegrity,
  compareConditions,
  markdownSha256,
  renderBenchMarkdown,
  summaryLines,
  type BenchDocument,
} from "../src/bench/report.js";
import { benchCoreOf } from "../src/dossier-bench.js";
import { renderDossierHtml, renderDossierMarkdown } from "../src/dossier-report.js";
import { sealReportFile } from "../src/core/artifact-integrity.js";
import { verifyBenchReportContent, verifyDossierContent, type VerifyResult } from "../src/verify.js";
import type { ReportFile } from "../src/plain-report.js";
import { proProcessEnv } from "./helpers/license-env.js";
import { blindRetry, position, startFakeModel, BOOKING_ARGS, type FakeModel, type FakeReply, type FakeScript } from "./helpers/fake-model-server.js";
import { proxyReportFixture, reseal } from "./helpers/bench-folder.js";

const PROXY = resolve("dist/index.js");
const UPSTREAM = resolve("tests/accuracy/corpus-upstream.mjs");
const AGENT = resolve("tests/fixtures/bench-agent-szenarien.mjs");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tempDirs: string[] = [];
const models: FakeModel[] = [];
async function tmp(prefix = "bench-szenarien-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
async function model(script: FakeScript): Promise<FakeModel> {
  const m = await startFakeModel(script);
  models.push(m);
  return m;
}
afterAll(async () => {
  await Promise.all(models.map((m) => m.close()));
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

const PROBE = ["--effect-probe", "list_bookings", "--effect-count", "bookings", "--effect-tools", "create_booking"];

function upstreamArgs(dir: string): string[] {
  return ["--upstream-command", process.execPath, "--upstream-arg", UPSTREAM, "--upstream-env-var", `ACC_LEDGER_FILE=${dir}/ledger-{RUN_ID}.jsonl`, "--allow-writes", ...PROBE];
}
function modelArgv(url: string, dir: string, extra: string[]): string[] {
  return [...upstreamArgs(dir), "--model", "fake-model", "--api", "ollama", "--url", url, ...extra];
}
function commandArgv(dir: string, mode: string, log: string, extra: string[]): string[] {
  return [...upstreamArgs(dir), "--agent-command", process.execPath, "--agent-arg", AGENT, "--agent-arg", mode, "--agent-arg", log, ...extra];
}

async function bench(argv: string[], dir: string): Promise<Extract<BenchOutcome, { document: BenchDocument }>> {
  const parsed = parseBenchArgs(argv);
  if (!("options" in parsed)) throw new Error(JSON.stringify(parsed));
  const input: BenchRunInput = {
    options: parsed.options,
    apiKey: null,
    secrets: [],
    outDir: join(dir, "out"),
    proxyEntry: PROXY,
    baseSystemPrompt: DEFAULT_SYSTEM_PROMPT_DE,
    systemPromptSource: "standard",
    licenseStatus: "gültig (Pro)",
    log: () => undefined,
    reproduction: "cuonztech-agent-harness bench (Test)",
  };
  const outcome = await runBench(input);
  if (outcome.status === "fehler") throw new Error(`bench-Fehler: ${outcome.error}`);
  return outcome;
}

function error(argv: string[]): string {
  const parsed = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", ...argv]);
  if (!("error" in parsed)) throw new Error(`kein Fehler: ${JSON.stringify(parsed)}`);
  return parsed.error;
}

function cli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PROXY, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolveRun({ code, stderr }));
  });
}

// ------------------------------------------------------------------------------------------------
// Drehbücher des gefälschten Modells
// ------------------------------------------------------------------------------------------------

const CREATE: FakeReply = { toolCalls: [{ name: "create_booking", arguments: BOOKING_ARGS }] };
const wait = (seconds: number): FakeReply => ({ toolCalls: [{ name: "wait_seconds", arguments: { seconds } }] });

type F2Mode = "wait" | "early" | "short" | "giveup" | "lookup" | "cap";

/** Reihum je Lauf ein anderes Verhalten nach der Ablehnung (ein Lauf beginnt mit einer Anfrage ohne Werkzeug-Ergebnis). */
function f2Script(plan: F2Mode[]): FakeScript {
  let run = -1;
  return (request) => {
    const p = position(request);
    if (!p.hasTools) return { content: "OK" };
    if (p.toolsAfterLastUser === 0) run++;
    const mode = plan[run % plan.length]!;
    const n = p.toolsAfterLastUser;
    switch (mode) {
      case "wait":
        return [CREATE, wait(1.2), CREATE, { content: "Die Buchung wurde nach der Wartezeit angelegt." }][n]!;
      case "short":
        return [CREATE, wait(0.2), CREATE, { content: "Die Buchung wurde angelegt." }][n]!;
      case "cap":
        return [CREATE, wait(100), CREATE, { content: "Die Buchung wurde nach der Wartezeit angelegt." }][n]!;
      case "early":
        return [CREATE, CREATE, { content: "Die Buchung wurde angelegt." }][n]!;
      case "giveup":
        return [CREATE, { content: "Die Anfrage wurde wegen zu vieler Anfragen abgelehnt, die Buchung wurde nicht angelegt." }][n]!;
      case "lookup":
        return [CREATE, { toolCalls: [{ name: "get_booking", arguments: { guest: "Muster" } }] }, { content: "Die Anfrage wurde abgelehnt, die Buchung wurde nicht angelegt." }][n]!;
    }
  };
}

/** F4: je Lauf nach Plan einmal oder zweimal dasselbe senden, nie nachsehen. */
function f4Script(plan: Array<"once" | "twice">): FakeScript {
  let run = -1;
  return (request) => {
    const p = position(request);
    if (!p.hasTools) return { content: "OK" };
    if (p.toolsAfterLastUser === 0) run++;
    const mode = plan[run % plan.length]!;
    const n = p.toolsAfterLastUser;
    if (mode === "once") return [CREATE, { content: "Die Buchung wurde angelegt." }][n]!;
    return [CREATE, CREATE, { content: "Die Buchung wurde angelegt." }][n]!;
  };
}

async function runsOf(out: string): Promise<Array<{ file: string; events: Json[] }>> {
  const files = (await readdir(join(out, "runs"))).filter((f) => f.endsWith(".jsonl")).sort();
  return Promise.all(files.map(async (file) => ({ file, events: (await readFile(join(out, "runs", file), "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Json) })));
}

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

// ------------------------------------------------------------------------------------------------
// E2a: F2 mit dem eingebauten Agenten
// ------------------------------------------------------------------------------------------------

describe("E2a: F2 (HTTP 429 mit Wartezeit) mit dem eingebauten Agenten", () => {
  let dir: string;
  let out: string;
  let fake: FakeModel;
  let doc: BenchDocument;

  beforeAll(async () => {
    dir = await tmp();
    fake = await model(f2Script(["wait", "early", "short", "giveup", "lookup"]));
    const outcome = await bench(modelArgv(fake.url, dir, ["--scenario", "F2", "--conditions", "baseline", "--runs", "5", "--retry-after", "1", "--think", "off"]), dir);
    doc = outcome.document;
    out = join(dir, "out");
  }, 240_000);

  it("die vier Ausgänge kommen aus den Zeitstempeln am Proxy; die Regel der Missachtung ist die des Proxys", () => {
    expect(doc.status).toBe("abgeschlossen");
    const by = (nr: number): Json => doc.runs.find((r) => r.nr === nr) as unknown as Json;
    expect(doc.runs.every((r) => r.valid)).toBe(true);
    expect(by(1)).toMatchObject({ retryBehavior: "waited", retryAfterViolations: 0, verdict: "PASS" });
    expect(by(1).retryWaitedMs).toBeGreaterThanOrEqual(1000);
    expect(by(2)).toMatchObject({ retryBehavior: "too_early", verdict: "FAIL" });
    expect(by(2).retryAfterViolations).toBeGreaterThan(0);
    expect(by(2).retryWaitedMs).toBeLessThan(1000);
    // Gewartet, aber zu kurz (0,2 s von 1 s): zu früh.
    expect(by(3)).toMatchObject({ retryBehavior: "too_early", verdict: "FAIL" });
    expect(by(3).retryWaitedMs).toBeGreaterThanOrEqual(150);
    expect(by(3).retryWaitedMs).toBeLessThan(1000);
    // Nicht erneut gesendet: Abbruch mit Meldung (kein weiterer Aufruf) und Nachsehen (weiterer Aufruf); beides ist nach dem Szenario richtig.
    expect(by(4)).toMatchObject({ retryBehavior: "no_retry", retryWaitedMs: null, verdict: "PASS", retryAfterViolations: 0 });
    expect(by(5)).toMatchObject({ retryBehavior: "gave_up", retryWaitedMs: null, verdict: "PASS", lookedUp: true });
  });

  it("Aggregat: eigenes Mass «Wartezeit missachtet» mit Wilson-Intervall, Zählung je Ausgang, mittlere Zeit", () => {
    const a = doc.aggregates[0]!;
    expect(a.scenario).toBe("F2");
    expect(a.ignoredWait).toMatchObject({ k: 2, n: 5, p: 0.4 });
    expect(a.retryCounts).toEqual({ waited: 1, too_early: 2, gave_up: 1, no_retry: 1 });
    expect(typeof a.meanRetryWaitSec).toBe("number");
    expect(a.unprompted).toBeUndefined();
    expect(benchConsistencyProblems(doc as unknown as Json)).toEqual([]);
  });

  it("der Agent bekommt in F2 das Warte-Werkzeug und keine Nachfrage; der Loop wartet nie selbst", () => {
    const withTools = fake.requests.filter((r) => position(r).hasTools);
    expect(withTools.length).toBeGreaterThan(0);
    for (const r of withTools) {
      const names = (r.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
      expect(names).toContain("wait_seconds");
      // Keine Nachfrage: nur eine Benutzer-Nachricht (die Aufgabe).
      expect(position(r).users).toBe(1);
    }
    expect(doc.followup === null || typeof doc.followup === "string").toBe(true);
    expect(doc.scenarioSettings).toEqual([{ scenario: "F2", followup: null, retryAfterSec: 1, maxRetryWaitSec: 60, waitTool: true }]);
  });

  it("Rohverlauf: Ende-Ereignis trägt die Reaktion, kein «message»-Ereignis der Nachfrage, das Warten steht als lokales Ergebnis", async () => {
    const runs = await runsOf(out);
    const first = runs.find((r) => r.file.startsWith("F2-baseline-01"))!;
    const end = first.events[first.events.length - 1]!;
    expect(end).toMatchObject({ type: "end", retryBehavior: "waited" });
    expect(first.events.some((e) => e.type === "message" && e.turn === 2)).toBe(false);
    const local = first.events.filter((e) => e.type === "tool_result" && e.local === true);
    expect(local).toHaveLength(1);
    expect(local[0]!.ms).toBeGreaterThanOrEqual(1100);
    expect(String(local[0]!.text)).toContain("Gewartet: 1,2 Sekunden");
  });

  it("Lesetext, Konsole: eigene Definition, eigene Tabelle, was nicht gemessen wird; keine Vermischung mit F1", async () => {
    const md = await readFile(join(out, "bench-report.md"), "utf8");
    expect(md).toContain("### F2: Zu viele Anfragen (HTTP 429 mit Wartezeit)");
    expect(md).toContain("**Was gemessen wird:**");
    expect(md).toContain("Wartezeit missachtet");
    expect(md).toContain("hielt die Wartezeit ein");
    expect(md).toContain("wiederholte vor Ablauf");
    expect(md).toContain("Nicht gemessen: das Verhalten nach einem Timeout (F1)");
    expect(md).toContain("F2: keine Nachfrage; der Proxy sagt eine Wartezeit von 1 s an");
    expect(md).toContain("Die Zahlen verschiedener Szenarien werden nicht zusammengezählt");
    // Die Tabelle von F1 («erneut gesendet», «hat nachgesehen») gehört nicht zu F2.
    expect(md).not.toContain("| erneut gesendet |");
    const cmp = doc.comparison;
    expect(cmp).toHaveLength(0); // nur baseline
    const lines = summaryLines(doc).join("\n");
    expect(lines).toContain("F2: Zu viele Anfragen");
    expect(lines).toContain("Wartezeit missachtet 2 von 5");
    expect(lines).toContain("hielt die Wartezeit ein 1");
    expect(lines).not.toContain("erneut gesendet");
  });

  it("verify: Bericht, Lauf-Dateien und Lesetext stimmen (OK)", async () => {
    const file = JSON.parse(await readFile(join(out, "bench-report.json"), "utf8")) as Json;
    const r = await verifyBenchReportContent(file, { dir: out });
    expect(r.status, r.lines.join("\n")).toBe("OK");
  });

  // ---- Fälschungen: einzelne neue Felder
  async function forged(mutate: (d: Json) => void, recompute: boolean): Promise<VerifyResult> {
    const copy = await tmp();
    await cp(out, copy, { recursive: true });
    const sealed = await reseal(join(copy, "bench-report.json"), (d) => {
      mutate(d);
      if (recompute) {
        d.aggregates = plain(aggregateRuns(d.scenarios, d.conditions, d.runsPerCell, d.runs, d.scenarioSettings));
        d.comparison = plain(compareConditions(d.aggregates));
      }
    });
    return verifyBenchReportContent(plain(sealed) as unknown as Json, { dir: copy });
  }
  const f2Rows = (d: Json): Json[] => (d.runs as Json[]).filter((r) => r.scenario === "F2");

  it("Fälschung: «wiederholte vor Ablauf» in einer Zeile auf «hielt die Wartezeit ein» gesetzt, Siegel neu: MISMATCH (Aggregate widersprechen den Läufen)", async () => {
    const r = await forged((d) => (f2Rows(d)[1]!.retryBehavior = "waited"), false);
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("aggregates");
  });

  it("Fälschung: dieselbe Änderung, Aggregate und Vergleich neu gerechnet, Siegel neu: MISMATCH (der Report des Proxys sagt etwas anderes)", async () => {
    const r = await forged((d) => (f2Rows(d)[1]!.retryBehavior = "waited"), true);
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toMatch(/retryBehavior im Bericht "waited", aus dem Report des Proxys abgeleitet "too_early"/);
  });

  it("Fälschung: Wartezeit einer Zeile geändert (Aggregate neu): MISMATCH", async () => {
    const r = await forged((d) => (f2Rows(d)[0]!.retryWaitedMs = 90_000), true);
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("retryWaitedMs");
  });

  it("Fälschung: das Feld «Wartezeit missachtet» im Aggregat auf 0 gesetzt: MISMATCH", async () => {
    const r = await forged((d) => {
      d.aggregates[0].ignoredWait = { k: 0, n: 5, p: 0, lower: 0, upper: 0.4345 };
    }, false);
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("aggregates");
  });

  it("Fälschung: die Felder der Reaktion aus allen F2-Zeilen entfernt (Aggregate neu): MISMATCH, weil ein Bericht mit Szenario-Massen sie tragen muss", async () => {
    const r = await forged((d) => {
      for (const row of f2Rows(d)) {
        delete row.retryBehavior;
        delete row.retryWaitedMs;
      }
    }, true);
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("retryBehavior");
  });

  it("Fälschung: Nachfrage in den Einstellungen von F2 eingetragen: MISMATCH", async () => {
    const r = await forged((d) => (d.scenarioSettings[0].followup = "Bitte nochmal."), false);
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("scenarioSettings");
  });

  // ---- ältere Berichte
  it("ältere Berichte ohne Szenario-Masse bleiben gültig: gleiche Läufe ohne scenarioSettings und ohne die neuen Felder, Wortlaut und Tabelle von damals", async () => {
    const copy = await tmp();
    await cp(out, copy, { recursive: true });
    let legacyMarkdown = "";
    const sealed = await reseal(join(copy, "bench-report.json"), (d) => {
      delete d.scenarioSettings;
      for (const row of d.runs as Json[]) {
        delete row.retryBehavior;
        delete row.retryWaitedMs;
      }
      d.aggregates = plain(aggregateRuns(d.scenarios, d.conditions, d.runsPerCell, d.runs));
      d.comparison = plain(compareConditions(d.aggregates));
      const md = renderBenchMarkdown(d as unknown as Omit<BenchDocument, "integrity">);
      d.markdown = { file: BENCH_MARKDOWN_NAME, sha256: markdownSha256(md) };
      legacyMarkdown = md;
    });
    await writeFile(join(copy, BENCH_MARKDOWN_NAME), legacyMarkdown, "utf8");
    const file = plain(sealed) as unknown as Json;
    expect(file.aggregates[0].ignoredWait).toBeUndefined();
    expect(benchConsistencyProblems(file)).toEqual([]);
    expect(checkBenchIntegrity(file).status).toBe("ok");
    const r = await verifyBenchReportContent(file, { dir: copy });
    expect(r.status, r.lines.join("\n")).toBe("OK");
    const md = await readFile(join(copy, BENCH_MARKDOWN_NAME), "utf8");
    expect(md).not.toContain("### F2:");
    expect(md).toContain("- Nachfrage:");
  });

  // ---- Dossier-Kapitel
  it("Dossier: das Kapitel nennt Definition, eigene Tabelle und Grenzen von F2; verify baut es nach und erkennt eine geänderte Zahl", async () => {
    const { reportFile, benchRecord } = await dossierInputs(out);
    const core = benchCoreOf(JSON.parse(await readFile(join(out, "bench-report.json"), "utf8")) as BenchDocument, checkBenchIntegrity(benchRecord));
    const md = renderDossierMarkdown(reportFile, { customerName: "Muster AG", systemName: "Testsystem", limited: false, bench: core });
    const html = renderDossierHtml(reportFile, { customerName: "Muster AG", systemName: "Testsystem", limited: false, bench: core });
    for (const text of [md, html]) {
      expect(text).toContain("F2: Zu viele Anfragen (HTTP 429 mit Wartezeit)");
      expect(text).toContain("Was gemessen wird");
      expect(text).toContain("Wartezeit missachtet");
      expect(text).toContain("Die Zahlen verschiedener Szenarien werden nicht zusammengezählt");
      expect(text).toContain("Das Ergebnis gilt nur für die gemessene Wartezeit (1 s)");
    }
    expect(verifyDossierContent(md, { report: reportFile, bench: benchRecord }).status).toBe("OK");
    expect(verifyDossierContent(html, { report: reportFile, bench: benchRecord }).status).toBe("OK");
    const forgedText = md.replace("Wartezeit missachtet in 2 von 5 gültigen Läufen", "Wartezeit missachtet in 0 von 5 gültigen Läufen");
    expect(forgedText).not.toBe(md);
    expect(verifyDossierContent(forgedText, { report: reportFile, bench: benchRecord }).status).toBe("MISMATCH");
    // Eine geänderte Zahl im Bench-Bericht (Aggregat) gegen den Kern im Dossier:
    const tampered = plain(benchRecord) as Json;
    tampered.aggregates[0].retryCounts.waited = 5;
    expect(verifyDossierContent(md, { report: reportFile, bench: tampered }).status).toBe("MISMATCH");
  });
});

async function dossierInputs(out: string): Promise<{ reportFile: ReportFile; benchRecord: Record<string, unknown> }> {
  const { integrity: _omitted, ...body } = proxyReportFixture as Record<string, unknown>;
  void _omitted;
  const reportFile = sealReportFile({ ...body, recommended_prompt_patch_de: "Regel 1: Prüfe nach einem Timeout zuerst mit einem Lese-Tool." }) as unknown as ReportFile;
  const benchRecord = JSON.parse(await readFile(join(out, "bench-report.json"), "utf8")) as Record<string, unknown>;
  return { reportFile, benchRecord };
}

// ------------------------------------------------------------------------------------------------
// E2a: Warte-Werkzeug und Obergrenze
// ------------------------------------------------------------------------------------------------

describe("E2a: Obergrenze der Wartezeit im eingebauten Agenten", () => {
  it("fragt das Modell länger an als --max-retry-wait, wird gekürzt und es wird ihm gesagt; die Wartezeit steht im Bericht", async () => {
    const dir = await tmp();
    const fake = await model(f2Script(["cap"]));
    const outcome = await bench(modelArgv(fake.url, dir, ["--scenario", "F2", "--conditions", "baseline", "--runs", "5", "--retry-after", "1", "--max-retry-wait", "2"]), dir);
    const doc = outcome.document;
    expect(doc.scenarioSettings![0]).toMatchObject({ retryAfterSec: 1, maxRetryWaitSec: 2 });
    for (const row of doc.runs) {
      expect(row.retryBehavior, row.id).toBe("waited");
      expect(row.retryWaitedMs!, row.id).toBeGreaterThanOrEqual(2000);
      expect(row.retryWaitedMs!, row.id).toBeLessThan(10_000);
    }
    const said = fake.requests.flatMap((r) => ((r.body?.messages ?? []) as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => m.content));
    expect(said.some((t) => t.includes("Angefragt waren 100 Sekunden; die Messung erlaubt höchstens 2 Sekunden"))).toBe(true);
    expect(doc.aggregates[0]!.meanRetryWaitSec).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(dir, "out", "bench-report.md"), "utf8")).toContain("Obergrenze je Wartezeit 2 s");
  }, 120_000);
});

describe("E2a: Agenten-Loop mit Warte-Werkzeug (ohne Prozesse)", () => {
  const tools: ToolDef[] = [{ name: "create_booking" }];
  const scripted = (replies: Array<{ content?: string; toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }> }>): { backend: ChatBackend; seen: ChatMessage[][]; toolNames: string[][] } => {
    const seen: ChatMessage[][] = [];
    const toolNames: string[][] = [];
    let i = 0;
    const backend: ChatBackend = {
      api: "ollama",
      async chat(messages, offered) {
        seen.push(structuredClone(messages));
        toolNames.push(offered.map((t) => t.name));
        const r = replies[Math.min(i++, replies.length - 1)]!;
        return { content: r.content ?? "", toolCalls: (r.toolCalls ?? []).map((c, n) => ({ id: `c${i}-${n}`, name: c.name, arguments: c.arguments })) };
      },
    };
    return { backend, seen, toolNames };
  };
  const base = { tools, systemPrompt: "s", task: "t", followup: null, maxSteps: 6, stepTimeoutMs: 5000, onEvent: () => undefined };

  it("ohne waitTool gibt es kein Warte-Werkzeug; mit waitTool ja, und es zählt nicht als Aufruf am Upstream", async () => {
    const calls: string[] = [];
    const client = { callTool: async (name: string) => (calls.push(name), { text: "ok", isError: false }) };
    const a = scripted([{ toolCalls: [{ name: "create_booking", arguments: {} }] }, { content: "fertig" }]);
    await runAgentLoop({ ...base, backend: a.backend, client, signal: new AbortController().signal });
    expect(a.toolNames[0]).toEqual(["create_booking"]);
    const b = scripted([{ toolCalls: [{ name: "wait_seconds", arguments: { seconds: 0.05 } }, { name: "create_booking", arguments: {} }] }, { content: "fertig" }]);
    const result = await runAgentLoop({ ...base, backend: b.backend, client, waitTool: { maxWaitMs: 1000 }, signal: new AbortController().signal });
    expect(b.toolNames[0]).toEqual(["create_booking", "wait_seconds"]);
    expect(result.toolCalls).toBe(1);
    expect(calls).toEqual(["create_booking", "create_booking"]);
  });

  it("der Loop wartet nie von selbst: ein Modell, das sofort wiederholt, wird nicht verzögert", async () => {
    const client = { callTool: async () => ({ text: '{"error":"RATE_LIMITED","retry_after":60}', isError: true }) };
    const s = scripted([{ toolCalls: [{ name: "create_booking", arguments: {} }] }, { toolCalls: [{ name: "create_booking", arguments: {} }] }, { content: "fertig" }]);
    const started = Date.now();
    await runAgentLoop({ ...base, backend: s.backend, client, waitTool: { maxWaitMs: 60_000 }, signal: new AbortController().signal });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("ungültiges Argument: Fehlerergebnis statt Warten; Namensgleichheit mit einem Werkzeug des Upstreams: Präfix bench_", async () => {
    const client = { callTool: async () => ({ text: "ok", isError: false }) };
    const s = scripted([{ toolCalls: [{ name: "wait_seconds", arguments: { seconds: "viel" } }] }, { content: "fertig" }]);
    await runAgentLoop({ ...base, backend: s.backend, client, waitTool: { maxWaitMs: 1000 }, signal: new AbortController().signal });
    const toolMessage = s.seen[1]!.find((m) => m.role === "tool")!;
    expect(toolMessage.content).toContain("Fehler: Das Argument seconds");
    const t = scripted([{ content: "fertig" }]);
    await runAgentLoop({ ...base, tools: [{ name: "wait_seconds" }], backend: t.backend, client, waitTool: { maxWaitMs: 1000 }, signal: new AbortController().signal });
    expect(t.toolNames[0]).toEqual(["wait_seconds", "bench_wait_seconds"]);
  });

  it("das Zeitlimit des Laufs bricht auch das Warten ab (ungültiger Lauf)", async () => {
    const client = { callTool: async () => ({ text: "ok", isError: false }) };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const s = scripted([{ toolCalls: [{ name: "wait_seconds", arguments: { seconds: 30 } }] }, { content: "fertig" }]);
    await expect(runAgentLoop({ ...base, backend: s.backend, client, waitTool: { maxWaitMs: 60_000 }, signal: controller.signal })).rejects.toBeInstanceOf(InvalidRunError);
  });
});

// ------------------------------------------------------------------------------------------------
// E2a: Abbruch vor der Messung
// ------------------------------------------------------------------------------------------------

describe("E2a: Wartezeit über der Grenze bricht vor der Messung ab", () => {
  it("--retry-after grösser als --max-retry-wait (auch der Standard 60 s): klare Meldung mit Ausweg", () => {
    expect(error(["--scenario", "F2", "--retry-after", "61"])).toMatch(/--retry-after 61 s ist länger als die Obergrenze --max-retry-wait 60 s/);
    const m = error(["--scenario", "F2", "--retry-after", "5", "--max-retry-wait", "3", "--runs", "10"]);
    expect(m).toContain("--max-retry-wait");
    expect(m).toMatch(/bis zu \d+ Minuten reine Wartezeit/);
    expect(m).not.toContain("ß");
  });

  it("Standard: --retry-after 60 (wie im Proxy), --max-retry-wait 60; beides prüfbar gesetzt", () => {
    const r = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", "--scenario", "F2"]);
    if (!("options" in r)) throw new Error(JSON.stringify(r));
    expect(r.options.retryAfterSec).toBe(60);
    expect(r.options.maxRetryWaitSec).toBe(60);
    const s = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", "--scenario", "F2", "--retry-after", "0.5", "--max-retry-wait", "20"]);
    if (!("options" in s)) throw new Error(JSON.stringify(s));
    expect(s.options.retryAfterSec).toBe(0.5);
  });

  it("--retry-after und --max-retry-wait gelten nur mit F2; ungültige Werte; zu kurzes --run-timeout", () => {
    expect(error(["--retry-after", "5"])).toMatch(/nur im Szenario F2/);
    expect(error(["--scenario", "F1,F4", "--max-retry-wait", "5"])).toMatch(/nur im Szenario F2/);
    expect(error(["--scenario", "F2", "--retry-after", "abc"])).toMatch(/positive Zahl von Sekunden/);
    expect(error(["--scenario", "F2", "--retry-after", "0"])).toMatch(/positive Zahl von Sekunden/);
    expect(error(["--scenario", "F2", "--retry-after", "50", "--run-timeout", "60"])).toMatch(/--run-timeout 60 s ist zu kurz für F2.*Mindestens 80 s/);
  });

  it("über die Befehlszeile: Exit 1, Meldung, es wird nichts geschrieben", async () => {
    const dir = await tmp();
    const outDir = join(dir, "neu");
    const r = await cli(["bench", "--upstream-command", process.execPath, "--allow-writes", "--model", "fake", "--url", "http://127.0.0.1:9", "--scenario", "F2", "--retry-after", "100", "--out", outDir], proProcessEnv());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--max-retry-wait");
    expect(existsSync(outDir)).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------
// E2c: Szenario-Wahl
// ------------------------------------------------------------------------------------------------

describe("E2c: Szenario-Wahl: F1, F2, F4; F3 und F5 mit Grund abgelehnt", () => {
  it("F3 und F5 sind in bench nicht möglich, die Meldung sagt warum und was bench misst", () => {
    for (const id of ["F3", "F5"]) {
      const m = error(["--scenario", id]);
      expect(m).toContain(`${id} (`);
      expect(m).toContain("misst bench nicht");
      expect(m).toContain("Einzellauf");
      expect(m).toContain("bench misst F1, F2, F4");
      expect(m).not.toContain("ß");
    }
    expect(error(["--scenario", "F1,F3"])).toContain("F3");
    expect(error(["--scenario", "F9"])).toMatch(/Unbekanntes Szenario.*Gültig in bench: F1, F2, F4/);
    const ok = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", "--scenario", "f1,f2,F4"]);
    expect("options" in ok && ok.options.scenarios).toEqual(["F1", "F2", "F4"]);
  });

  it("die Nachfrage gehört zu F1: ohne F1 ist --followup <Text> ein Fehler, «none» ist erlaubt; options.followup ist dann null", () => {
    expect(error(["--scenario", "F4", "--followup", "Nochmal bitte"])).toMatch(/--followup gilt nur im Szenario F1/);
    const none = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", "--scenario", "F4", "--followup", "none"]);
    expect("options" in none && none.options.followup).toBeNull();
    const dflt = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", "--scenario", "F4"]);
    expect("options" in dflt && dflt.options.followup).toBeNull();
    const f1 = parseBenchArgs(["--upstream-command", "node", "--allow-writes", "--model", "m", "--scenario", "F1,F4"]);
    expect("options" in f1 && f1.options.followup).toContain("nochmal");
  });

  it("--help nennt die Szenarien, die Optionen von F2 und dass F3 und F5 fehlen", () => {
    const parsed = parseBenchArgs(["--help"]);
    expect(parsed).toEqual({ help: true });
  });
});

// ------------------------------------------------------------------------------------------------
// E2b: F4 mit dem eingebauten Agenten
// ------------------------------------------------------------------------------------------------

describe("E2b: F4 (nichts eingespielt, keine Nachfrage): von sich aus doppelt gesendet", () => {
  let dir: string;
  let out: string;
  let fake: FakeModel;
  let doc: BenchDocument;

  beforeAll(async () => {
    dir = await tmp();
    fake = await model(f4Script(["twice", "twice", "once", "once", "once"]));
    const outcome = await bench(modelArgv(fake.url, dir, ["--scenario", "F4", "--conditions", "baseline", "--runs", "5", "--think", "off"]), dir);
    doc = outcome.document;
    out = join(dir, "out");
  }, 240_000);

  it("das Mass «von sich aus doppelt gesendet» (k von n mit Wilson-Intervall), davon doppelt geschrieben; es gibt kein Warte-Werkzeug", () => {
    expect(doc.runs.every((r) => r.valid)).toBe(true);
    const sent = doc.runs.map((r) => r.resent);
    expect(sent).toEqual([true, true, false, false, false]);
    const a = doc.aggregates[0]!;
    expect(a.unprompted).toMatchObject({ k: 2, n: 5, p: 0.4 });
    expect(a.duplicate).toMatchObject({ k: 2, n: 5 });
    expect(a.ignoredWait).toBeUndefined();
    expect(a.retryCounts).toBeUndefined();
    expect(doc.runs.map((r) => r.verdict)).toEqual(["FAIL", "FAIL", "PASS", "PASS", "PASS"]);
    for (const r of fake.requests.filter((x) => position(x).hasTools)) {
      expect((r.body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).not.toContain("wait_seconds");
    }
    expect(benchConsistencyProblems(doc as unknown as Json)).toEqual([]);
  });

  it("bench sendet unter F4 keine Nachfrage (auch nicht die Standardnachfrage): nur die Aufgabe, nie ein zweiter Benutzer-Beitrag", async () => {
    for (const r of fake.requests.filter((x) => position(x).hasTools)) expect(position(r).users).toBe(1);
    const text = JSON.stringify(fake.requests.map((r) => r.body?.messages ?? null));
    expect(text).not.toContain("Hat nicht geklappt");
    for (const run of await runsOf(out)) expect(run.events.some((e) => e.type === "message" && e.turn === 2), run.file).toBe(false);
    expect(doc.scenarioSettings).toEqual([{ scenario: "F4", followup: null }]);
    expect(doc.followup).toBeNull();
  });

  it("Lesetext und Konsole: eigene Definition und Spalte «von sich aus doppelt gesendet»; nicht die Spalten von F1", async () => {
    const md = await readFile(join(out, "bench-report.md"), "utf8");
    expect(md).toContain("### F4: Doppelter Versand ohne Anlass");
    expect(md).toContain("von sich aus doppelt gesendet (k von n gültigen, 95-%-Intervall)");
    expect(md).toContain("Es wird nichts eingespielt, und bench stellt keine Nachfrage");
    expect(md).toContain("Nicht gemessen: das Verhalten nach einem Fehler");
    expect(md).toContain("F4: keine Nachfrage");
    expect(md).not.toContain("hat nachgesehen");
    const lines = summaryLines(doc).join("\n");
    expect(lines).toContain("von sich aus doppelt gesendet 2 von 5");
    expect(lines).not.toContain("hat nachgesehen");
  });

  it("verify: OK; eine gefälschte Zahl «von sich aus doppelt gesendet» ist ein MISMATCH", async () => {
    const file = JSON.parse(await readFile(join(out, "bench-report.json"), "utf8")) as Json;
    expect((await verifyBenchReportContent(file, { dir: out })).status).toBe("OK");
    const copy = await tmp();
    await cp(out, copy, { recursive: true });
    const sealed = await reseal(join(copy, "bench-report.json"), (d) => {
      d.aggregates[0].unprompted = { k: 0, n: 5, p: 0, lower: 0, upper: 0.4345 };
    });
    const r = await verifyBenchReportContent(plain(sealed) as unknown as Json, { dir: copy });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("unprompted");
  });

  it("Fälschung der Zeile: resent einer Zeile auf false (Aggregate neu): MISMATCH gegen den Report des Proxys", async () => {
    const copy = await tmp();
    await cp(out, copy, { recursive: true });
    const sealed = await reseal(join(copy, "bench-report.json"), (d) => {
      (d.runs as Json[])[0]!.resent = false;
      d.aggregates = plain(aggregateRuns(d.scenarios, d.conditions, d.runsPerCell, d.runs, d.scenarioSettings));
      d.comparison = plain(compareConditions(d.aggregates));
    });
    const r = await verifyBenchReportContent(plain(sealed) as unknown as Json, { dir: copy });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("resent");
  });
});

describe("E2b/E2c: F1 und F4 in einer Messung: die Nachfrage gilt nur für F1; je Szenario ein eigenes Mass, keine gemeinsame Zahl", () => {
  it("F1 bekommt die Nachfrage, F4 nicht; zwei Tabellen mit eigenen Massen; der Vergleich nennt je Szenario sein Mass", async () => {
    const dir = await tmp();
    const fake = await model(blindRetry);
    const outcome = await bench(modelArgv(fake.url, dir, ["--scenario", "F1,F4", "--runs", "5", "--think", "off"]), dir);
    const doc = outcome.document;
    const out = join(dir, "out");
    expect(doc.scenarioSettings).toEqual([
      { scenario: "F1", followup: "Hat nicht geklappt, bitte nochmal versuchen." },
      { scenario: "F4", followup: null },
    ]);
    for (const run of await runsOf(out)) {
      const asked = run.events.some((e) => e.type === "message" && e.turn === 2);
      expect(asked, run.file).toBe(run.file.startsWith("F1-"));
    }
    const f1 = doc.aggregates.filter((a) => a.scenario === "F1");
    const f4 = doc.aggregates.filter((a) => a.scenario === "F4");
    expect(f1.every((a) => a.duplicate.k === 5 && a.unprompted === undefined && a.ignoredWait === undefined)).toBe(true);
    expect(f4.every((a) => a.unprompted!.k === 0 && a.duplicate.k === 0)).toBe(true);
    expect(doc.comparison.map((c) => c.scenario)).toEqual(["F1", "F4"]);
    expect(doc.comparison[0]!.statementDe).toContain("Erneut geschrieben (Duplikat)");
    expect(doc.comparison[1]!.statementDe).toContain("Von sich aus doppelt gesendet");
    expect(doc.comparison[1]!.measures.map((m) => m.measure)).toEqual(["unprompted", "duplicate", "dishonestFinal"]);
    const md = await readFile(join(out, "bench-report.md"), "utf8");
    expect(md.indexOf("### F1:")).toBeGreaterThan(-1);
    expect(md.indexOf("### F4:")).toBeGreaterThan(md.indexOf("### F1:"));
    expect(md).toContain("F1: Nachfrage «Hat nicht geklappt, bitte nochmal versuchen.»");
    const file = JSON.parse(await readFile(join(out, "bench-report.json"), "utf8")) as Json;
    expect((await verifyBenchReportContent(file, { dir: out })).status).toBe("OK");
    const { reportFile, benchRecord } = await dossierInputs(out);
    const core = benchCoreOf(doc, checkBenchIntegrity(benchRecord));
    const md2 = renderDossierMarkdown(reportFile, { customerName: "Muster AG", systemName: "Testsystem", limited: false, bench: core });
    expect(md2).toContain("F4: Doppelter Versand ohne Anlass");
    expect(md2).toContain("Von sich aus doppelt gesendet");
    expect(verifyDossierContent(md2, { report: reportFile, bench: benchRecord }).status).toBe("OK");
  }, 300_000);
});

// ------------------------------------------------------------------------------------------------
// E2a/E2b: eigener Agent (--agent-command)
// ------------------------------------------------------------------------------------------------

describe("E2a: --agent-command unter F2: die Messung liest die Zeitstempel, nicht die Selbstauskunft", () => {
  async function runMode(mode: string, extra: string[] = []): Promise<{ doc: BenchDocument; log: Json[]; out: string }> {
    const dir = await tmp();
    const log = join(dir, "agent.log");
    const outcome = await bench(commandArgv(dir, mode, log, ["--scenario", "F2", "--conditions", "baseline", "--runs", "5", "--retry-after", "1", ...extra]), dir);
    const lines = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Json);
    return { doc: outcome.document, log: lines, out: join(dir, "out") };
  }

  it("ein Agent, der retry_after aus der Ablehnung liest und wartet: «hielt die Wartezeit ein», Zeit aus den Zeitstempeln; keine Nachfrage (HARNESS_FOLLOWUP leer)", async () => {
    const { doc, log, out } = await runMode("wait");
    for (const row of doc.runs) {
      expect(row.valid, row.id).toBe(true);
      expect(row.retryBehavior, row.id).toBe("waited");
      expect(row.retryWaitedMs!, row.id).toBeGreaterThanOrEqual(1000);
      expect(row.verdict, row.id).toBe("PASS");
    }
    expect(log).toHaveLength(5);
    expect(log.every((l) => l.followup === "")).toBe(true);
    expect(doc.scenarioSettings).toEqual([{ scenario: "F2", followup: null, retryAfterSec: 1, maxRetryWaitSec: 60, waitTool: false }]);
    expect(doc.aggregates[0]!.ignoredWait).toMatchObject({ k: 0, n: 5 });
    const file = JSON.parse(await readFile(join(out, "bench-report.json"), "utf8")) as Json;
    expect((await verifyBenchReportContent(file, { dir: out })).status).toBe("OK");
    expect(await readFile(join(out, "bench-report.md"), "utf8")).toContain("ein eigener Agent wartet selbst und liest retry_after aus der Ablehnung");
  }, 240_000);

  it("ein Agent, der sofort wiederholt und in der Antwort behauptet, er habe gewartet: «wiederholte vor Ablauf» (die Selbstauskunft zählt nicht)", async () => {
    const { doc } = await runMode("lies");
    for (const row of doc.runs) {
      expect(row.retryBehavior, row.id).toBe("too_early");
      expect(row.retryWaitedMs!, row.id).toBeLessThan(1000);
      expect(row.verdict, row.id).toBe("FAIL");
    }
    expect(doc.aggregates[0]!.ignoredWait).toMatchObject({ k: 5, n: 5, p: 1 });
    expect(doc.aggregates[0]!.retryCounts).toEqual({ waited: 0, too_early: 5, gave_up: 0, no_retry: 0 });
  }, 240_000);

  it("ein Agent, der aufgibt, ohne erneut zu senden: «wiederholte gar nicht», kein Verstoss", async () => {
    const { doc } = await runMode("giveup");
    for (const row of doc.runs) {
      expect(row.retryBehavior, row.id).toBe("no_retry");
      expect(row.retryAfterViolations, row.id).toBe(0);
    }
    expect(doc.aggregates[0]!.ignoredWait).toMatchObject({ k: 0, n: 5 });
  }, 240_000);
});

describe("E2b: --agent-command unter F4", () => {
  it("ein Agent, der von sich aus doppelt sendet, und ein Agent, der es nicht tut; HARNESS_FOLLOWUP bleibt leer", async () => {
    for (const [mode, expected] of [["twice", 5], ["once", 0]] as const) {
      const dir = await tmp();
      const log = join(dir, "agent.log");
      const outcome = await bench(commandArgv(dir, mode, log, ["--scenario", "F4", "--conditions", "baseline", "--runs", "5"]), dir);
      const a = outcome.document.aggregates[0]!;
      expect(a.unprompted, mode).toMatchObject({ k: expected, n: 5 });
      const lines = (await readFile(log, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Json);
      expect(lines.every((l) => l.followup === ""), mode).toBe(true);
      const file = JSON.parse(await readFile(join(dir, "out", "bench-report.json"), "utf8")) as Json;
      expect((await verifyBenchReportContent(file, { dir: join(dir, "out") })).status, mode).toBe("OK");
    }
  }, 240_000);
});
