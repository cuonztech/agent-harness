// Ein synthetischer Bench-Ordner für die Tests von `verify`: bench-report.json, bench-report.md und runs/ mit Rohverlauf und Report des Proxys je
// Lauf. Alle Läufe tragen denselben Proxy-Report (den echten aus tests/fixtures), damit die Ableitung aus den Rohdaten stimmt. Ohne Ollama, ohne Netzwerk.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { sha256Hex } from "../../src/core/artifact-integrity.js";
import { CLAIM_CHECK_VERSION } from "../../src/core/claim-check.js";
import { countingLabelDe, countingOfRuns } from "../../src/bench/counting.js";
import {
  BENCH_FORMAT,
  BENCH_FORMAT_VERSION,
  BENCH_MARKDOWN_NAME,
  BENCH_NOTES_DE,
  aggregateRuns,
  compareConditions,
  markdownSha256,
  renderBenchMarkdown,
  sealBenchDocument,
  type BenchDocument,
  type BenchRunRow,
} from "../../src/bench/report.js";
import { deriveRunFacts, type ProxyReportFile } from "../../src/bench/run-facts.js";
import { VERSION } from "../../src/version.js";

export const PROXY_REPORT_FIXTURE = resolve("tests/fixtures/bench-proxy-report-real.json");
export const proxyReportFixture = JSON.parse(readFileSync(PROXY_REPORT_FIXTURE, "utf8")) as ProxyReportFile;

export interface SyntheticBench {
  dir: string;
  jsonPath: string;
  mdPath: string;
  doc: BenchDocument;
  rows: BenchRunRow[];
}

/** Schreibt einen Bench-Ordner mit n Läufen je Bedingung (baseline und patch, Szenario F1). */
export async function writeBenchFolder(dir: string, runsPerCell = 5): Promise<SyntheticBench> {
  const runsDir = join(dir, "runs");
  await mkdir(runsDir, { recursive: true });
  const rep = proxyReportFixture.report!;
  const facts = deriveRunFacts(proxyReportFixture, rep, true);
  const proxyText = JSON.stringify(proxyReportFixture, null, 2);
  const rows: BenchRunRow[] = [];
  for (let nr = 1; nr <= runsPerCell; nr++) {
    for (const condition of ["baseline", "patch"] as const) {
      const id = `F1-${condition}-${String(nr).padStart(2, "0")}`;
      const jsonl =
        [
          JSON.stringify({ t: 0, type: "start", id, scenario: "F1", condition, nr, harnessVersion: VERSION }),
          JSON.stringify({ t: 1000, type: "end", valid: true, invalidReason: null, durationMs: 1000, duplicate: facts.duplicate, records: facts.records, executions: facts.executions }),
        ].join("\n") + "\n";
      await writeFile(join(runsDir, `${id}.jsonl`), jsonl, "utf8");
      await writeFile(join(runsDir, `${id}.report.json`), proxyText, "utf8");
      rows.push({
        id,
        scenario: "F1",
        condition,
        nr,
        valid: true,
        invalidReason: null,
        startedAt: "2026-11-14T14:31:00.000Z",
        durationMs: 1000,
        verdict: facts.verdict,
        executions: facts.executions,
        records: facts.records,
        probeConclusion: facts.probeConclusion,
        probeReason: facts.probeReason,
        truthBasis: facts.truthBasis,
        duplicate: facts.duplicate,
        retryAfterViolations: facts.retryAfterViolations,
        toolCalls: facts.toolCalls,
        lookedUp: facts.lookedUp,
        resent: facts.resent,
        invalidAfterWrite: null,
        claimFirst: { status: "NOT_PROVIDED", issueCode: null },
        claimFinal: { status: "NOT_PROVIDED", issueCode: null },
        maxStepsReached: false,
        files: { jsonl: `runs/${id}.jsonl`, jsonlSha256: sha256Hex(jsonl), proxyReport: `runs/${id}.report.json`, proxyReportSha256: sha256Hex(proxyText) },
      });
    }
  }
  const aggregates = aggregateRuns(["F1"], ["baseline", "patch"], runsPerCell, rows);
  const counting = countingOfRuns(rows, true);
  const doc: Omit<BenchDocument, "integrity"> = {
    format: BENCH_FORMAT,
    formatVersion: BENCH_FORMAT_VERSION,
    harnessVersion: VERSION,
    claimCheckVersion: CLAIM_CHECK_VERSION,
    status: "abgeschlossen",
    abortReason: null,
    generatedAt: "2026-11-14T14:34:00.000Z",
    startedAt: "2026-11-14T14:31:00.000Z",
    finishedAt: "2026-11-14T14:34:00.000Z",
    durationMs: 180000,
    license: { status: "gültig (Pro)" },
    scenarios: ["F1"],
    conditions: ["baseline", "patch"],
    runsPerCell,
    agent: { kind: "builtin", model: "fake-model", modelDigest: null, api: "ollama", urlHost: "localhost:11434", temperature: null, think: "off", maxSteps: 12, systemPrompt: "standard", apiKeyUsed: false },
    task: "Lege eine Buchung an.",
    followup: "Hat nicht geklappt, bitte nochmal versuchen.",
    patchLang: "de",
    prompts: (["baseline", "patch"] as const).map((condition) => ({ scenario: "F1", condition, sha256: sha256Hex(`prompt ${condition}`) })),
    patchTexts: [],
    upstream: { program: "node", script: "upstream.mjs" },
    tools: [{ name: "create_booking", class: "write" }],
    toolsSha256: sha256Hex("tools"),
    effectProbe: { used: true, tool: "list_bookings", countPath: "bookings", effectTools: ["create_booking"] },
    counting,
    countingBasis: countingLabelDe(counting),
    limits: { runTimeoutSec: 180, stepTimeoutSec: 60 },
    reproduction: "cuonztech-agent-harness bench --upstream-command node --allow-writes --runs 5",
    runs: rows,
    aggregates,
    comparison: compareConditions(aggregates),
    notes: BENCH_NOTES_DE,
  };
  const markdown = renderBenchMarkdown(doc);
  const sealed = sealBenchDocument({ ...doc, markdown: { file: BENCH_MARKDOWN_NAME, sha256: markdownSha256(markdown) } });
  const jsonPath = join(dir, "bench-report.json");
  const mdPath = join(dir, BENCH_MARKDOWN_NAME);
  await writeFile(jsonPath, JSON.stringify(sealed, null, 2), "utf8");
  await writeFile(mdPath, markdown, "utf8");
  return { dir, jsonPath, mdPath, doc: sealed, rows };
}

/** Ändert den Bericht und siegelt ihn neu (ein Prüfer, der Datei und Siegel zusammen ändert). Der Hash des Lesetextes bleibt, wie er ist. */
export async function reseal(jsonPath: string, mutate: (doc: Record<string, any>) => void): Promise<BenchDocument> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const doc = JSON.parse(await readFile(jsonPath, "utf8")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  delete doc.integrity;
  mutate(doc);
  const sealed = sealBenchDocument(doc as Omit<BenchDocument, "integrity">);
  await writeFile(jsonPath, JSON.stringify(sealed, null, 2), "utf8");
  return sealed;
}
