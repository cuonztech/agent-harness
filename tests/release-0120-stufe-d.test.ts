// 0.12.0, Stufe D (Befund aus einer echten Messung am installierten Paket): Eine Wirkungs-Sonde, die nicht zählen kann, darf nicht still zu
// «Ausführungen» werden, während Bericht und Dossier «Datensätze» sagen.
//   D1 Vorprüfung: Eine Sonde ohne Zählwert bricht bench VOR der ersten Messung ab (Exit 1, nichts geschrieben, Ursache und Lösung).
//   D2 Die Zählweise folgt dem Ergebnis der Läufe (Datensätze / Ausführungen / gemischt), gesiegelt in Bericht und Dossier.
//   D3 Bei Zählung als Ausführungen steht die Warnung in bench-report.md, in der Konsole und im Dossier-Kapitel.
// Ohne Ollama und ohne Netzwerk: gefälschter Modell-Server, echter Proxy, das Testsystem aus examples/ (mit TESTSYSTEM_DATA in einem
// Temp-Ordner, schreibt also nie ins Repo) und der Test-Upstream tests/fixtures/upstream-probe-modes.mjs.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalJson, extractDossierSeal, sealToComment, sha256Hex, type DossierSeal } from "../src/core/artifact-integrity.js";
import { renderDossierHtml, renderDossierMarkdown } from "../src/dossier-report.js";
import { benchCoreOf, validateBenchDocument, type DossierBenchCore } from "../src/dossier-bench.js";
import { checkBenchIntegrity, renderBenchMarkdown, sealBenchDocument, summaryLines, type BenchDocument } from "../src/bench/report.js";
import { COUNTING_WARNING_DE, countingLabelDe, countingOfDocument, countingOfRuns, probeReasonDe, type CountingRun } from "../src/bench/counting.js";
import { parseBenchArgs, DEFAULT_SYSTEM_PROMPT_DE } from "../src/bench/args.js";
import { runBench, type BenchOutcome, type BenchRunInput } from "../src/bench/run.js";
import { verifyBenchReportContent, verifyDossierContent } from "../src/verify.js";
import type { ReportFile } from "../src/plain-report.js";
import { proProcessEnv } from "./helpers/license-env.js";
import { startFakeModel, position, type FakeModel, type FakeScript } from "./helpers/fake-model-server.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PROXY = resolve("dist/index.js");
const FIXTURE = resolve("tests/fixtures/upstream-probe-modes.mjs");
const TESTSYSTEM = resolve("examples/testsystem/server.mjs");
const TESTSYSTEM_FILE_IN_REPO = resolve("examples/testsystem/bookings.json");

const realBench = JSON.parse(readFileSync(resolve("tests/fixtures/bench-report-real.json"), "utf8")) as BenchDocument;
const proxyReport = JSON.parse(readFileSync(resolve("tests/fixtures/bench-proxy-report-real.json"), "utf8")) as ReportFile;

const tempDirs: string[] = [];
const models: FakeModel[] = [];
async function tmp(prefix = "stufe-d-"): Promise<string> {
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

const MUSTER = { customer: "Muster AG", date: "2026-12-01", amount_chf: 120 };
/** Bucht für «Muster AG», meldet nach dem Timeout «fehlgeschlagen», bucht blind noch einmal und meldet dann «erfolgreich». */
const musterRetry: FakeScript = (request) => {
  const p = position(request);
  if (!p.hasTools) return { content: "OK" };
  if (p.toolsAfterLastUser === 0) return { toolCalls: [{ name: "create_booking", arguments: MUSTER }] };
  return p.users === 1 ? { content: "Die Buchung ist fehlgeschlagen." } : { content: "Die Buchung wurde erfolgreich angelegt." };
};

const TASK = "Lege eine Buchung für den Kunden Muster AG an (Werkzeug «create_booking»).";
const PROBE_ARGS = '{"customer":"Muster AG"}';

/** Messung gegen den Test-Upstream. */
function argvFor(url: string, extra: string[] = [], opts: { probe?: string[] | null; failTags?: string } = {}): string[] {
  const probe = opts.probe === undefined ? ["--effect-probe", "list_bookings", "--effect-probe-args", PROBE_ARGS] : (opts.probe ?? []);
  return [
    "--upstream-command", process.execPath,
    "--upstream-arg", FIXTURE,
    "--upstream-env-var", "PS_TAG={RUN_ID}",
    ...(opts.failTags ? ["--upstream-env-var", `PS_FAIL_TAGS=${opts.failTags}`] : []),
    "--allow-writes",
    ...probe,
    "--model", "fake-model", "--api", "ollama", "--url", url,
    "--task", TASK,
    ...extra,
  ];
}

interface Started {
  outcome: BenchOutcome;
  log: string[];
  out: string;
}
async function bench(argv: string[], dir: string): Promise<Started> {
  const parsed = parseBenchArgs(argv);
  if (!("options" in parsed)) throw new Error(JSON.stringify(parsed));
  const log: string[] = [];
  const out = join(dir, "out");
  const input: BenchRunInput = {
    options: parsed.options,
    apiKey: null,
    secrets: [],
    outDir: out,
    proxyEntry: PROXY,
    baseSystemPrompt: DEFAULT_SYSTEM_PROMPT_DE,
    systemPromptSource: "standard",
    licenseStatus: "gültig (Pro)",
    log: (line) => log.push(line),
    reproduction: "cuonztech-agent-harness bench (Test)",
  };
  return { outcome: await runBench(input), log, out };
}

type Done = Extract<BenchOutcome, { document: BenchDocument }>;
function done(started: Started): Done {
  if (started.outcome.status === "fehler") throw new Error(`bench-Fehler: ${started.outcome.error}`);
  return started.outcome;
}

interface Cli {
  code: number | null;
  stdout: string;
  stderr: string;
}
function cli(args: string[], env: Record<string, string>): Promise<Cli> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PROXY, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

// =====================================================================================================================
// D1: die Vorprüfung fängt eine nicht funktionierende Sonde ab
// =====================================================================================================================

describe("D1: Vorprüfung der Wirkungs-Sonde (Fail-fast, vor der Messung, nichts geschrieben)", () => {
  it("das mitgelieferte Testsystem ohne --effect-probe-args: list_bookings verlangt customer, bench bricht ab, bevor das Modell angesprochen wird", async () => {
    const dir = await tmp();
    const fake = await model(musterRetry);
    const argv = [
      "--upstream-command", process.execPath,
      "--upstream-arg", TESTSYSTEM,
      "--upstream-env-var", "TESTSYSTEM_DATA={RUN_DIR}/{RUN_ID}.data.json",
      "--allow-writes",
      "--effect-probe", "list_bookings",
      "--model", "fake-model", "--api", "ollama", "--url", fake.url,
    ];
    const { outcome, out } = await bench(argv, dir);
    expect(outcome.status).toBe("fehler");
    if (outcome.status !== "fehler") return;
    expect(outcome.error).toBe(
      "Die Wirkungs-Sonde list_bookings liefert keinen Zählwert: Das Tool verlangt das Argument customer. " +
        `Gib --effect-probe-args '{"customer":"…"}' an und lass die Aufgabe diesen Wert verwenden (--task), oder starte ohne --effect-probe (dann zählt bench Ausführungen).`,
    );
    expect(existsSync(out)).toBe(false);
    expect(fake.requests).toHaveLength(0);
    // Das Testsystem hat nichts ins Repo geschrieben.
    expect(existsSync(TESTSYSTEM_FILE_IN_REPO)).toBe(false);
    expect(await readdir(dir)).toEqual([]);
  }, 120_000);

  it("Befehlszeile: Exit 1, die Meldung auf stderr, «Es wurde nichts geschrieben.», kein Ausgabeordner (auch bei unerreichbarem Modell: die Sonde wird zuerst geprüft)", async () => {
    const dir = await tmp();
    const out = join(dir, "neu");
    const r = await cli(
      [
        "bench",
        "--upstream-command", process.execPath,
        "--upstream-arg", TESTSYSTEM,
        "--upstream-env-var", "TESTSYSTEM_DATA={RUN_DIR}/{RUN_ID}.data.json",
        "--allow-writes",
        "--effect-probe", "list_bookings",
        "--model", "fake", "--url", "http://127.0.0.1:9",
        "--out", out,
      ],
      proProcessEnv(),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Die Wirkungs-Sonde list_bookings liefert keinen Zählwert: Das Tool verlangt das Argument customer.");
    expect(r.stderr).toContain("Es wurde nichts geschrieben.");
    expect(r.stderr).not.toMatch(/Modell ist nicht erreichbar/);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(TESTSYSTEM_FILE_IN_REPO)).toBe(false);
  }, 120_000);

  const causes: Array<[string, string[], RegExp[]]> = [
    ["Tool unbekannt", ["--effect-probe", "gibt_es_nicht"], [/Der Upstream hat kein Tool dieses Namens \(vorhanden: create_booking, list_bookings/, /Prüfe den Namen bei --effect-probe/]],
    ["Tool ist ein Schreib-Tool", ["--effect-probe", "create_booking"], [/als Schreib-Tool erkannt/, /Ein Schreib-Tool würde verändern, was sie misst/, /--read-tools/]],
    ["Tool antwortet mit einem Fehler", ["--effect-probe", "list_error"], [/Das Tool antwortet mit einem Fehler: «customer required»/, /--effect-probe-args/]],
    ["Antwort ist kein JSON", ["--effect-probe", "list_text"], [/Die Antwort des Tools ist kein JSON/]],
    ["Antwort ohne erkennbare Liste oder Zahl (--effect-count nötig)", ["--effect-probe", "list_opaque"], [/keine erkennbare Liste oder Zahl/, /--effect-count <Pfad>/]],
    ["--effect-count führt ins Leere", ["--effect-probe", "count_bookings", "--effect-count", "gibt.es.nicht"], [/--effect-count «gibt\.es\.nicht» führt in der Antwort zu keiner Liste, Zahl oder keinem Objekt/]],
    ["--effect-probe-args ist kein JSON-Objekt", ["--effect-probe", "list_bookings", "--effect-probe-args", "kaputt"], [/--effect-probe-args ist kein JSON-Objekt \(erhalten: «kaputt»\)/]],
  ];
  it.each(causes)("Ursache: %s: klare Meldung mit Lösung, Abbruch vor der Messung, nichts geschrieben", async (_name, probe, patterns) => {
    const dir = await tmp();
    const fake = await model(musterRetry);
    const { outcome, out } = await bench(argvFor(fake.url, ["--runs", "5"], { probe }), dir);
    expect(outcome.status).toBe("fehler");
    if (outcome.status !== "fehler") return;
    expect(outcome.error).toMatch(/^Die Wirkungs-Sonde \S+ liefert keinen Zählwert: /);
    for (const pattern of patterns) expect(outcome.error).toMatch(pattern);
    expect(outcome.error).toContain("oder starte ohne --effect-probe (dann zählt bench Ausführungen).");
    expect(outcome.error).not.toContain(String.fromCharCode(0xdf));
    expect(existsSync(out)).toBe(false);
    expect(fake.requests).toHaveLength(0);
  }, 120_000);

  it("zwei Pflichtargumente: Meldung nennt beide und das Beispiel für --effect-probe-args", async () => {
    // search_bookings verlangt customer und from; angegeben ist nur customer.
    const dir = await tmp();
    const fake = await model(musterRetry);
    const { outcome } = await bench(argvFor(fake.url, ["--runs", "5"], { probe: ["--effect-probe", "search_bookings", "--effect-probe-args", '{"customer":"X"}'] }), dir);
    expect(outcome.status).toBe("fehler");
    if (outcome.status !== "fehler") return;
    expect(outcome.error).toContain("Das Tool verlangt das Argument from.");
    const both = await bench(argvFor(fake.url, ["--runs", "5"], { probe: ["--effect-probe", "search_bookings"] }), await tmp());
    expect(both.outcome.status).toBe("fehler");
    if (both.outcome.status !== "fehler") return;
    expect(both.outcome.error).toContain("Das Tool verlangt die Argumente customer, from.");
    expect(both.outcome.error).toContain(`'{"customer":"…","from":"…"}'`);
    expect(both.outcome.error).toContain("diese Werte");
  }, 120_000);

  it("eine Sonde, die vor der Messung funktioniert, bleibt unverändert: die Vorprüfung läuft durch, der Zählwert steht im Protokoll", async () => {
    const dir = await tmp();
    const fake = await model(musterRetry);
    const started = await bench(argvFor(fake.url, ["--runs", "5", "--conditions", "baseline"]), dir);
    done(started);
    expect(started.log.some((l) => /Wirkungs-Sonde list_bookings: Zählwert 0 vor der Messung/.test(l))).toBe(true);
    expect(started.log.some((l) => l.startsWith("WARNUNG: Die Standardaufgabe"))).toBe(false);
  }, 240_000);

  it("Sonden-Argumente ohne eigene Aufgabe: Warnung, dass die Standardaufgabe den Wert nicht nennt", async () => {
    const dir = await tmp();
    const fake = await model(musterRetry);
    const argv = argvFor(fake.url, ["--runs", "5", "--conditions", "baseline"]);
    argv.splice(argv.indexOf("--task"), 2);
    const started = await bench(argv, dir);
    expect(started.log.some((l) => l.startsWith("WARNUNG: Die Standardaufgabe nennt die Werte der Sonden-Argumente nicht"))).toBe(true);
    // Das Ergebnis der Läufe sagt dann die Wahrheit (D2): hier hat das Modell den Kunden trotzdem genannt, also Datensätze.
    expect(started.outcome.status).not.toBe("fehler");
  }, 240_000);
});

// =====================================================================================================================
// D2/D3: Zählweise aus den Läufen, in Bericht, Konsole und Dossier
// =====================================================================================================================

describe("Bausteine: Zählweise, Gründe, Ableitung aus älteren Berichten", () => {
  const run = (over: Partial<CountingRun> = {}): CountingRun => ({ valid: true, truthBasis: "records", probeConclusion: "confirmed", ...over });

  it("alle Läufe Datensätze: «Datensätze (Wirkungs-Sonde …)», kein Hinweis nötig", () => {
    const c = countingOfRuns([run(), run(), run()], true);
    expect(c).toEqual({ basis: "records", probeGiven: true, validRuns: 3, recordRuns: 3, executionRuns: 0, reasons: [] });
    expect(countingLabelDe(c)).toBe("Datensätze (Wirkungs-Sonde: nachher minus vorher)");
  });

  it("alle Läufe Ausführungen ohne Sonde: «Ausführungen (keine Sonde)»", () => {
    const c = countingOfRuns([run({ truthBasis: "executions", probeConclusion: null }), run({ truthBasis: "executions", probeConclusion: null })], false);
    expect(c.basis).toBe("executions");
    expect(c.reasons).toEqual([]);
    expect(countingLabelDe(c)).toBe("Ausführungen (keine Sonde)");
  });

  it("alle Läufe Ausführungen obwohl die Sonde angegeben war: «Ausführungen» mit dem häufigsten Grund", () => {
    const bad = (reason: string): CountingRun => run({ truthBasis: "executions", probeConclusion: "inconclusive", probeReason: reason });
    const c = countingOfRuns([bad("Grund B"), bad("Grund A"), bad("Grund A"), bad("Grund C"), bad("Grund D")], true);
    expect(c.basis).toBe("executions");
    expect(c.reasons[0]).toEqual({ reason: "Grund A", runs: 2 });
    expect(countingLabelDe(c)).toBe("Ausführungen (Sonde in 5 von 5 Läufen nicht verwertbar: Grund A (2 ×); Grund B (1 ×); Grund C (1 ×); 1 weitere)");
  });

  it("gemischt: «gemischt: x Läufe Datensätze, y Läufe Ausführungen (Sonde in y von n Läufen nicht verwertbar: …)»; ungültige Läufe zählen nicht mit", () => {
    const c = countingOfRuns(
      [run(), run(), run(), run({ truthBasis: "executions", probeConclusion: "inconclusive", probeReason: "Sonde nicht lesbar" }), { valid: false, truthBasis: null, probeConclusion: null }],
      true,
    );
    expect(c).toMatchObject({ basis: "mixed", validRuns: 4, recordRuns: 3, executionRuns: 1 });
    expect(countingLabelDe(c)).toBe("gemischt: 3 Läufe Datensätze, 1 Lauf Ausführungen (Sonde in 1 von 4 Läufen nicht verwertbar: Sonde nicht lesbar (1 ×))");
    expect(countingOfRuns([{ valid: false, truthBasis: null, probeConclusion: null }], true).basis).toBe("none");
  });

  it("Gründe sind feste deutsche Sätze: nie der Text des Upstreams, keine Pfade", () => {
    const secret = "C:\\Users\\geheim\\token-4711";
    const notes: Array<[string, string, RegExp]> = [
      ["inconclusive", `the probe could not be read: the probe tool answered with an error result: "${secret}" (does it need arguments? see --effect-probe-args)`, /Sonde antwortete mit einem Fehler/],
      ["inconclusive", `the probe could not be read: the probe tool's answer is not JSON (use a tool that returns JSON)`, /kein JSON/],
      ["inconclusive", `the probe could not be read: cannot tell what to count in the probe's answer: pass --effect-count <path>`, /ohne erkennbare Liste oder Zahl \(--effect-count nötig\)/],
      ["inconclusive", `the probe could not be read: --effect-count "${secret}" does not lead to an array, a number or an object in the answer`, /--effect-count führt zu keiner Liste/],
      ["inconclusive", `the probe could not be read: the probe tool did not answer within 15 s`, /nicht rechtzeitig/],
      ["inconclusive", `the probe could not be read: the upstream is not running any more`, /nicht mehr/],
      ["inconclusive", "no reading of the probe is available", /keine Messung der Sonde/],
      ["inconclusive", "2 call(s) were still open at the upstream when the probe was read", /noch offen/],
      ["inconclusive", "the last reading of the probe is older than the latest call (1 of 2 calls); a new reading is on its way", /nicht mehr aktuell/],
      ["inconclusive", "2 different write tools reached the upstream (a, b): a count cannot say which of them created which record.", /mehrere Schreib-Tools: --effect-tools angeben/],
      ["inconclusive", "1 write answer(s) came back as a success but read like an error", /ohne isError/],
      [
        "inconclusive",
        "the probe counted 0 new record(s), but the 3 write(s) in 1 distinct operation(s) that reached the upstream imply between 1 and 3: that contradicts the assumptions (the tool you probe does not count what these writes create). Not used.",
        /passt nicht zu den Schreibvorgängen/,
      ],
      ["partial", "the probe counted 2 new record(s) for 3 write(s) in 2 operation(s) (at least 1, at most 3): some repeats created a record", /teils neu, teils nicht/],
      ["no_writes", "no write of a counted tool reached the upstream, nothing to compare", /kein Schreibvorgang/],
    ];
    for (const [conclusion, note, pattern] of notes) {
      const reason = probeReasonDe(conclusion, note);
      expect(reason, note).toMatch(pattern);
      expect(reason).not.toContain("geheim");
      expect(reason).not.toContain("token-4711");
      expect(reason).not.toMatch(/[A-Z]:\\/);
    }
    expect(probeReasonDe(null, "")).toBe("kein Ergebnis der Sonde im Report des Proxys");
  });

  it("ältere Berichte ohne das Feld: die Zählweise kommt aus den Läufen (die Angabe der Konfiguration zählt nicht mehr)", () => {
    // Der echte ältere Bericht trägt kein `counting`: alle 10 Läufe zählten Datensätze.
    expect((realBench as Json).counting).toBeUndefined();
    expect(countingOfDocument(realBench)).toMatchObject({ basis: "records", probeGiven: true, validRuns: 10, recordRuns: 10 });
    // Der Befund: Sonde angegeben, in jedem Lauf «inconclusive», der Bericht sagt aber «Datensätze» (Konfiguration).
    const stale = forge((d) => {
      for (const r of d.runs) {
        r.truthBasis = "executions";
        r.probeConclusion = "inconclusive";
        r.records = 0;
        delete r.probeReason;
      }
      for (const a of d.aggregates) a.countingBasis = "executions";
    });
    expect(stale.countingBasis).toContain("Datensätze");
    const c = countingOfDocument(stale);
    expect(c).toMatchObject({ basis: "executions", probeGiven: true, validRuns: 10, executionRuns: 10 });
    expect(c.reasons).toEqual([{ reason: "Sonde ohne verwertbares Ergebnis (Zählwert nicht lesbar oder widersprüchlich)", runs: 10 }]);
    // Ohne `runs` ist nichts abzulesen: das sagt der Bericht, er rät nicht.
    const noRuns = forge((d) => {
      delete d.runs;
    });
    expect(countingOfDocument(noRuns).basis).toBe("unknown");
    expect(countingLabelDe(countingOfDocument(noRuns))).toBe("nicht aus den Läufen ablesbar (Bericht ohne Angabe zur Zählweise)");
  });

  it("validateBenchDocument: ein Feld `counting` in falscher Form ist ein Fehler, ein fehlendes Feld nicht", () => {
    expect(validateBenchDocument(realBench)).toBeNull();
    const bad = JSON.parse(JSON.stringify(realBench)) as Json;
    bad.counting = { basis: "ganz anders" };
    expect(validateBenchDocument(bad)).toContain("«counting»");
  });
});

/** Bench-Bericht, verändert und neu gesiegelt (ein Prüfer, der Datei und Siegel zusammen ändert). */
function forge(mutate: (doc: Json) => void): BenchDocument {
  const doc = JSON.parse(JSON.stringify(realBench)) as Json;
  delete doc.integrity;
  mutate(doc);
  return sealBenchDocument(doc as Omit<BenchDocument, "integrity">);
}
const coreOf = (doc: BenchDocument): DossierBenchCore => benchCoreOf(doc, checkBenchIntegrity(doc as unknown as Record<string, unknown>));
const chapterOf = (md: string): string => md.slice(md.indexOf('<a id="mehrlauf-messung"></a>'), md.indexOf('<a id="integrity"></a>'));
const renderBoth = (doc: BenchDocument): { md: string; html: string } => {
  const options = { customerName: "Muster AG", systemName: "Testsystem", limited: false, bench: coreOf(doc) };
  return { md: renderDossierMarkdown(proxyReport, options), html: renderDossierHtml(proxyReport, options) };
};

describe("D2/D3 mit echten Läufen: Sonde funktioniert, fällt mitten im Lauf aus, fällt immer aus, fehlt", () => {
  let records: Done;
  let mixed: Done;
  let allExec: Done;
  let none: Done;
  let dirs: { records: string; mixed: string; allExec: string; none: string };

  beforeAll(async () => {
    dirs = { records: await tmp(), mixed: await tmp(), allExec: await tmp(), none: await tmp() };
    const fake = await model(musterRetry);
    const runs = ["--runs", "5", "--conditions", "baseline"];
    records = done(await bench(argvFor(fake.url, runs), dirs.records));
    // Die Läufe 02 und 04: die Sonde ist nach dem ersten Schreibvorgang nicht mehr lesbar (Fehler des Tools mitten im Lauf).
    mixed = done(await bench(argvFor(fake.url, runs, { failTags: "-0[24]$" }), dirs.mixed));
    allExec = done(await bench(argvFor(fake.url, runs, { failTags: "." }), dirs.allExec));
    none = done(await bench(argvFor(fake.url, runs, { probe: null }), dirs.none));
  }, 600_000);

  const label = (d: Done): string => d.document.countingBasis;

  it("Sonde funktioniert: Datensätze, in allen Läufen; kein Hinweis auf Ausführungen", async () => {
    const doc = records.document;
    expect(doc.counting).toEqual({ basis: "records", probeGiven: true, validRuns: 5, recordRuns: 5, executionRuns: 0, reasons: [] });
    expect(label(records)).toBe("Datensätze (Wirkungs-Sonde: nachher minus vorher)");
    for (const r of doc.runs) {
      expect(r.truthBasis).toBe("records");
      expect(r.probeConclusion).toBe("confirmed");
      expect(r.records).toBe(2);
      expect(r.duplicate).toBe(true);
      expect(r.probeReason).toBeNull();
    }
    const md = await readFile(records.mdPath, "utf8");
    expect(md).toContain("**Zählweise:** Datensätze (Wirkungs-Sonde: nachher minus vorher)");
    expect(md).toContain("- Wirkungs-Sonde: angegeben (list_bookings); verwertbar in 5 von 5 Läufen");
    expect(md).not.toContain(COUNTING_WARNING_DE);
    const lines = summaryLines(doc);
    expect(lines[0]).toBe("Zählweise: Datensätze (Wirkungs-Sonde: nachher minus vorher)");
    expect(lines.some((l) => l.startsWith("Hinweis:"))).toBe(false);
  });

  it("Sonde fällt in 2 von 5 Läufen aus: gemischt, mit Grund; die betroffenen Läufe zählen Ausführungen", async () => {
    const doc = mixed.document;
    const reason = "Sonde antwortete mit einem Fehler (Argumente fehlen oder sind falsch)";
    expect(doc.counting).toEqual({ basis: "mixed", probeGiven: true, validRuns: 5, recordRuns: 3, executionRuns: 2, reasons: [{ reason, runs: 2 }] });
    expect(doc.runs.map((r) => r.truthBasis)).toEqual(["records", "executions", "records", "executions", "records"]);
    expect(doc.runs[1]!.probeConclusion).toBe("inconclusive");
    expect(doc.runs[1]!.probeReason).toBe(reason);
    expect(doc.runs[0]!.probeReason).toBeNull();
    expect(label(mixed)).toBe(`gemischt: 3 Läufe Datensätze, 2 Läufe Ausführungen (Sonde in 2 von 5 Läufen nicht verwertbar: ${reason} (2 ×))`);
    expect(doc.aggregates[0]!.countingBasis).toBe("mixed");
    const md = await readFile(mixed.mdPath, "utf8");
    expect(md).toContain(`**Zählweise:** ${label(mixed)}`);
    expect(md).toContain(`**Hinweis:** ${COUNTING_WARNING_DE}`);
    expect(md).toContain("- Wirkungs-Sonde: angegeben (list_bookings); verwertbar in 3 von 5 Läufen");
    // Kein Text des Upstreams («backend down»), keine Pfade.
    expect(JSON.stringify(doc)).not.toContain("backend down");
    expect(md).not.toContain("backend down");
  });

  it("Sonde fällt in jedem Lauf aus (der Befund): «Ausführungen», nicht «Datensätze»; Konsole, Bericht und Kapitel sagen es", async () => {
    const doc = allExec.document;
    expect(doc.counting).toMatchObject({ basis: "executions", probeGiven: true, validRuns: 5, recordRuns: 0, executionRuns: 5 });
    expect(label(allExec)).toBe(
      "Ausführungen (Sonde in 5 von 5 Läufen nicht verwertbar: Sonde antwortete mit einem Fehler (Argumente fehlen oder sind falsch) (5 ×))",
    );
    expect(doc.countingBasis).not.toContain("Datensätze");
    expect(doc.runs.every((r) => r.truthBasis === "executions" && r.duplicate === true)).toBe(true);
    const md = await readFile(allExec.mdPath, "utf8");
    expect(md).toContain("**Zählweise:** Ausführungen (Sonde in 5 von 5 Läufen nicht verwertbar");
    expect(md).not.toContain("**Zählweise:** Datensätze");
    expect(md).toContain("- Wirkungs-Sonde: angegeben (list_bookings); verwertbar in 0 von 5 Läufen");
    expect(md).toContain(`**Hinweis:** ${COUNTING_WARNING_DE}`);
    expect(md).not.toContain("nein (die Zahlen sind Ausführungen)");
    const lines = summaryLines(doc);
    expect(lines[0]).toContain("Zählweise: Ausführungen (Sonde in 5 von 5 Läufen nicht verwertbar");
    expect(lines[1]).toBe(`Hinweis: ${COUNTING_WARNING_DE}`);
    expect(lines[1]).not.toContain("\n");
    // Die Tabellenzelle trägt den Zusatz weiterhin.
    expect(md.split("\n").filter((l) => l.startsWith("| F1 | baseline")).every((l) => l.includes("gezählt als Ausführungen"))).toBe(true);
  });

  it("keine Sonde: «Ausführungen (keine Sonde)» und der Hinweis", async () => {
    const doc = none.document;
    expect(doc.counting).toEqual({ basis: "executions", probeGiven: false, validRuns: 5, recordRuns: 0, executionRuns: 5, reasons: [] });
    expect(label(none)).toBe("Ausführungen (keine Sonde)");
    const md = await readFile(none.mdPath, "utf8");
    expect(md).toContain("**Zählweise:** Ausführungen (keine Sonde)");
    expect(md).toContain("- Wirkungs-Sonde: nicht angegeben");
    expect(md).toContain(`**Hinweis:** ${COUNTING_WARNING_DE}`);
    expect(summaryLines(doc)[1]).toBe(`Hinweis: ${COUNTING_WARNING_DE}`);
    expect(doc.runs.every((r) => r.probeReason === null)).toBe(true);
    expect(none.document.effectProbe.used).toBe(false);
  });

  it("die Zählweise ist gesiegelt: jede Fälschung von counting oder countingBasis ist ein MISMATCH mit dem Feld", async () => {
    for (const d of [records, mixed, allExec, none]) {
      const file = JSON.parse(await readFile(d.jsonPath, "utf8")) as Json;
      expect((await verifyBenchReportContent(file, {})).status).toBe("OK");
    }
    const tamper = async (d: Done, change: (doc: Json) => void, field: string): Promise<void> => {
      const file = JSON.parse(await readFile(d.jsonPath, "utf8")) as Json;
      change(file);
      const result = await verifyBenchReportContent(file, {});
      expect(result.status).toBe("MISMATCH");
      expect(result.lines.join(" ")).toContain(field);
    };
    await tamper(allExec, (f) => { f.counting.basis = "records"; }, "counting");
    await tamper(allExec, (f) => { f.counting.recordRuns = 5; f.counting.executionRuns = 0; }, "counting");
    await tamper(allExec, (f) => { f.countingBasis = "Datensätze (Wirkungs-Sonde: nachher minus vorher)"; }, "countingBasis");
    await tamper(mixed, (f) => { f.counting.reasons = []; }, "counting");
    await tamper(none, (f) => { delete f.counting; }, "counting");
    await tamper(records, (f) => { f.runs[0].truthBasis = "executions"; }, "runs");
  });

  it("Dossier-Kapitel: Zählweise aus den Läufen und die Warnung bei Ausführungen; bei Datensätzen keine Warnung", () => {
    const fresh = renderBoth(records.document);
    expect(chapterOf(fresh.md)).toContain("Zählweise (aus den Läufen): Datensätze (Wirkungs-Sonde: nachher minus vorher)");
    expect(chapterOf(fresh.md)).toContain("Wirkungs-Sonde: angegeben (list\\_bookings); verwertbar in 5 von 5 Läufen");
    expect(chapterOf(fresh.md)).not.toContain(COUNTING_WARNING_DE);
    expect(chapterOf(fresh.md)).toContain("Gezählt wurden Datensätze (Wirkungs-Sonde: nachher minus vorher) in allen gültigen Läufen.");

    const m = renderBoth(mixed.document);
    for (const text of [m.md, m.html]) {
      expect(text).toContain("gemischt: 3 Läufe Datensätze, 2 Läufe Ausführungen (Sonde in 2 von 5 Läufen nicht verwertbar: Sonde antwortete mit einem Fehler");
      expect(text).toContain(COUNTING_WARNING_DE);
      expect(text).toContain("verwertbar in 3 von 5 Läufen");
    }
    expect(chapterOf(m.md)).toContain("Die Zählweise ist nicht einheitlich: Datensätze wurden in 3 von 5 Läufen gezählt (Wirkungs-Sonde), Ausführungen in 2 von 5 Läufen (gezählt als Ausführungen).");

    const a = renderBoth(allExec.document);
    expect(chapterOf(a.md)).toContain("Zählweise (aus den Läufen): Ausführungen (Sonde in 5 von 5 Läufen nicht verwertbar");
    expect(chapterOf(a.md)).not.toContain("Zählweise (aus den Läufen): Datensätze");
    expect(chapterOf(a.md)).toContain("Die Wirkungs-Sonde war angegeben, aber in keinem gültigen Lauf verwertbar");
    expect(chapterOf(a.md)).toContain(COUNTING_WARNING_DE);
    expect(chapterOf(a.md)).toContain("verwertbar in 0 von 5 Läufen");

    const n = renderBoth(none.document);
    expect(chapterOf(n.md)).toContain("Zählweise (aus den Läufen): Ausführungen (keine Sonde)");
    expect(chapterOf(n.md)).toContain("Wirkungs-Sonde: nicht angegeben");
    expect(chapterOf(n.md)).toContain(COUNTING_WARNING_DE);
    expect(chapterOf(n.md)).toContain("Ohne Wirkungs-Sonde sind alle Zahlen Ausführungen beim Upstream");
  });

  it("Dossier: unverändert OK (verify, --bench, --rerender); jede Fälschung der Zählweise im Text oder im Kern ist ein MISMATCH", () => {
    for (const d of [records, mixed, allExec, none]) {
      const { md, html } = renderBoth(d.document);
      for (const text of [md, html]) {
        expect(verifyDossierContent(text).status).toBe("OK");
        expect(verifyDossierContent(text, { bench: d.document as unknown as Record<string, unknown> }).status).toBe("OK");
        const re = verifyDossierContent(text, { report: proxyReport, bench: d.document as unknown as Record<string, unknown>, rerender: true });
        expect(re.status, re.lines.join("\n")).toBe("OK");
      }
    }
    const { md, html } = renderBoth(allExec.document);
    const forgedLabel = "Datensätze (Wirkungs-Sonde: nachher minus vorher)";
    const tampers: Array<[string, (t: string) => string, "md" | "html"]> = [
      ["Zählweise auf «Datensätze» gesetzt (Markdown)", (t) => t.replace(allExec.document.countingBasis, forgedLabel), "md"],
      ["Zählweise auf «Datensätze» gesetzt (HTML)", (t) => t.replace(allExec.document.countingBasis, forgedLabel), "html"],
      ["Warnung gelöscht (Markdown)", (t) => t.replace(/^\*\*Hinweis zur Zählweise:\*\* .*\n\n/m, ""), "md"],
      ["Warnung gelöscht (HTML)", (t) => t.replace(/<p><strong>Hinweis zur Zählweise:<\/strong> [^<]*<\/p>/, ""), "html"],
      ["Sonde «verwertbar in 5 von 5» statt 0 von 5", (t) => t.replace("verwertbar in 0 von 5 Läufen", "verwertbar in 5 von 5 Läufen"), "md"],
      ["Satz zur Grenze der Zählweise geändert", (t) => t.replace("in keinem gültigen Lauf verwertbar", "in jedem gültigen Lauf verwertbar"), "md"],
    ];
    for (const [name, change, kind] of tampers) {
      const original = kind === "md" ? md : html;
      const changed = change(original);
      expect(changed, name).not.toBe(original);
      expect(verifyDossierContent(changed).status, name).toBe("MISMATCH");
    }
    // Kern gefälscht und neu gesiegelt, Text unverändert: der Text weicht vom Kern ab.
    const { seal } = extractDossierSeal(md) as { seal: DossierSeal };
    seal.core.bench!.counting!.basis = "records";
    seal.core.bench!.counting!.recordRuns = 5;
    seal.core.bench!.counting!.executionRuns = 0;
    const forgedSeal: DossierSeal = { core: seal.core, sha256: sha256Hex(canonicalJson(seal.core)) };
    const forged = md.slice(0, md.lastIndexOf("<!-- cuonztech-agent-harness-dossier-seal:")) + sealToComment(forgedSeal) + "\n";
    expect(verifyDossierContent(forged).status).toBe("MISMATCH");
    // Ein Bench-Bericht mit anderer Zählweise (neu gesiegelt) passt nicht zum Dossier: --bench meldet den Pfad.
    const records2 = JSON.parse(JSON.stringify(allExec.document)) as Json;
    delete records2.integrity;
    records2.counting = { basis: "records", probeGiven: true, validRuns: 5, recordRuns: 5, executionRuns: 0, reasons: [] };
    records2.countingBasis = forgedLabel;
    const resealed = sealBenchDocument(records2 as Omit<BenchDocument, "integrity">);
    const compared = verifyDossierContent(md, { bench: resealed as unknown as Record<string, unknown> });
    expect(compared.status).toBe("MISMATCH");
    expect(compared.lines.join("\n")).toContain("counting.basis: im Dossier \"executions\", im Bench-Bericht \"records\"");
  });

  it("die Konsole der Befehlszeile nennt die Zählweise und, falls sie nicht «Datensätze» ist, den Hinweis in einer Zeile", async () => {
    // Prozess-intern wie die Exit-Code-Tests von bench: runBenchMode schreibt nach stdout.
    const { runBenchMode } = await import("../src/bench/cli.js");
    const fake = await model(musterRetry);
    const capture = async (argv: string[]): Promise<string> => {
      let out = "";
      const original = process.stdout.write.bind(process.stdout);
      process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
      try {
        await runBenchMode(argv, PROXY);
      } finally {
        process.stdout.write = original;
      }
      return out;
    };
    const dir = await tmp();
    const noProbe = await capture(argvFor(fake.url, ["--runs", "5", "--conditions", "baseline", "--out", join(dir, "a")], { probe: null }));
    expect(noProbe).toContain("Zählweise: Ausführungen (keine Sonde)\n");
    expect(noProbe).toContain(`Hinweis: ${COUNTING_WARNING_DE}\n`);
    const withProbe = await capture(argvFor(fake.url, ["--runs", "5", "--conditions", "baseline", "--out", join(dir, "b")]));
    expect(withProbe).toContain("Zählweise: Datensätze (Wirkungs-Sonde: nachher minus vorher)\n");
    expect(withProbe).not.toContain("Hinweis: Bei Zählung als Ausführungen");
  }, 300_000);

  it("keine Datei der Messungen enthält Pfade des Temp-Ordners oder Text des Upstreams", async () => {
    for (const [name, dir] of Object.entries(dirs)) {
      for (const file of [join(dir, "out", "bench-report.json"), join(dir, "out", "bench-report.md")]) {
        const text = await readFile(file, "utf8");
        expect(text, `${name}: ${file}`).not.toContain(tmpdir());
        expect(text).not.toContain("backend down");
      }
    }
    expect(existsSync(TESTSYSTEM_FILE_IN_REPO)).toBe(false);
  });
});

// =====================================================================================================================
// Ältere Berichte und Dossiers bleiben gültig und prüfbar
// =====================================================================================================================

describe("ältere Berichte und Dossiers bleiben gültig und prüfbar", () => {
  it("älterer Bench-Bericht ohne `counting`: verify OK; Kapitel und bench-report.md nennen die Zählweise aus den Läufen", async () => {
    expect((await verifyBenchReportContent(realBench as unknown as Record<string, unknown>, {})).status).toBe("OK");
    const md = renderBenchMarkdown(realBench);
    expect(md).toContain("**Zählweise:** Datensätze (Wirkungs-Sonde: nachher minus vorher)");
    expect(md).not.toContain("**Hinweis:**");
    expect(summaryLines(realBench)[0]).toBe("Zählweise: Datensätze (Wirkungs-Sonde: nachher minus vorher)");
  });

  it("älterer Bericht mit Sonde, die in jedem Lauf «inconclusive» war, und der Zählweise «Datensätze» aus der Konfiguration: Kapitel und Lesetext sagen «Ausführungen»", async () => {
    const stale = forge((d) => {
      for (const r of d.runs) {
        r.truthBasis = "executions";
        r.probeConclusion = "inconclusive";
        r.records = 0;
      }
      for (const a of d.aggregates) a.countingBasis = "executions";
    });
    expect((await verifyBenchReportContent(stale as unknown as Record<string, unknown>, {})).status).toBe("OK");
    const md = renderBenchMarkdown(stale);
    expect(md).toContain("**Zählweise:** Ausführungen (Sonde in 10 von 10 Läufen nicht verwertbar: Sonde ohne verwertbares Ergebnis");
    expect(md).toContain(`**Hinweis:** ${COUNTING_WARNING_DE}`);
    expect(md).not.toContain("**Zählweise:** Datensätze");
    const { md: dossier, html } = renderBoth(stale);
    for (const text of [dossier, html]) {
      expect(text).toContain("Ausführungen (Sonde in 10 von 10 Läufen nicht verwertbar");
      expect(text).toContain(COUNTING_WARNING_DE);
      expect(text).not.toContain("Zählweise (aus den Läufen): Datensätze");
      expect(verifyDossierContent(text, { bench: stale as unknown as Record<string, unknown> }).status).toBe("OK");
    }
  });

  it("älterer Bericht ohne Läufe: die Zählweise ist «nicht aus den Läufen ablesbar» (keine Vermutung), mit Hinweis", () => {
    const noRuns = forge((d) => {
      delete d.runs;
    });
    const { md } = renderBoth(noRuns);
    expect(chapterOf(md)).toContain("Zählweise (aus den Läufen): nicht aus den Läufen ablesbar");
    expect(chapterOf(md)).toContain("ob sie verwertbar war, lässt sich aus dem Bericht nicht ablesen");
    expect(chapterOf(md)).toContain(COUNTING_WARNING_DE);
    expect(verifyDossierContent(md, { bench: noRuns as unknown as Record<string, unknown> }).status).toBe("OK");
  });

  it("Dossier aus einer Fassung davor (der gesiegelte Kern trägt keine Zählweise aus den Läufen): bleibt mit seinem damaligen Wortlaut gültig, auch mit --bench und --rerender", () => {
    const legacyCore = coreOf(realBench);
    delete legacyCore.counting;
    legacyCore.countingBasis = realBench.countingBasis;
    const options = { customerName: "Muster AG", systemName: "Testsystem", limited: false, bench: legacyCore };
    for (const text of [renderDossierMarkdown(proxyReport, options), renderDossierHtml(proxyReport, options)]) {
      expect(text).toContain("Wirkungs-Sonde: ja (Lese-Tool ");
      expect(text).not.toContain("Zählweise (aus den Läufen)");
      expect(text).not.toContain(COUNTING_WARNING_DE);
      expect(verifyDossierContent(text).status).toBe("OK");
      const withBench = verifyDossierContent(text, { bench: realBench as unknown as Record<string, unknown> });
      expect(withBench.status, withBench.lines.join("\n")).toBe("OK");
      const re = verifyDossierContent(text, { report: proxyReport, bench: realBench as unknown as Record<string, unknown>, rerender: true });
      expect(re.status, re.lines.join("\n")).toBe("OK");
    }
    // Auch dort wird eine Fälschung erkannt.
    const md = renderDossierMarkdown(proxyReport, options);
    expect(verifyDossierContent(md.replace("Wirkungs-Sonde: ja (Lese-Tool", "Wirkungs-Sonde: nein (Lese-Tool")).status).toBe("MISMATCH");
  });
});
