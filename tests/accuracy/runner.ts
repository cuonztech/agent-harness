// Fuehrt den Korpus gegen den echten, gebauten Proxy aus (dist/index.js, wie
// tests/e2e-proxy.test.ts) und stellt das Urteil des Harness der Wahrheit des
// Upstreams gegenueber (Ledger-Datei von corpus-upstream.mjs).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proProcessEnv } from "../helpers/license-env.js";
import type { Case } from "./corpus.js";

const UPSTREAM = "tests/accuracy/corpus-upstream.mjs";

export type Kategorie = "richtig" | "unentschieden" | "falsch-pass" | "falsch-fail";

export interface Messung {
  id: string;
  verdict: string;
  /** Wirklich entstandene Datensaetze (Wahrheit aus dem Upstream). */
  effekte: number;
  /** Ausfuehrungen, die der Harness gezaehlt hat. */
  ausfuehrungen: number;
  operationen: string[];
  beobachtungen: string[];
  kategorie: Kategorie;
  labelOk: boolean | null;
  /** Der Bericht weist auf einen Zweifel an der Tool-Einordnung hin (Beschreibung widerspricht dem Namen). */
  einordnungsHinweis: boolean;
  /** Fehler im Korpus selbst (Beschriftung passt nicht zur Wahrheit). */
  korpusFehler: string | null;
  /** Rohes Wahrheitsprotokoll des Upstreams (je Schreibaufruf: Tool, wirksam, Signatur). */
  ledger: Array<{ tool: string; effective: boolean; sig?: string }>;
}

export function kategorie(soll: "PASS" | "FAIL", verdict: string): Kategorie {
  if (verdict === soll) return "richtig";
  if (verdict === "NOT_TESTED") return "unentschieden";
  return soll === "FAIL" ? "falsch-pass" : "falsch-fail";
}

interface ReportJson {
  verdict: string;
  upstreamCalls: number;
  duplicateExecutions: number;
  operations: Array<{ tool: string; attempts: number; executions: number; outcome: string }>;
  observations: Array<{ type: string }>;
  coverage: { notes: string[] };
}

function textOf(result: unknown): string {
  const first = (result as CallToolResult).content?.[0];
  return first && first.type === "text" ? first.text : "";
}

export async function runCase(c: Case): Promise<Messung> {
  const dir = await mkdtemp(join(tmpdir(), "harness-acc-"));
  const ledgerFile = join(dir, "ledger.jsonl");
  const env: Record<string, string> = { ACC_LEDGER_FILE: ledgerFile, ...c.env };
  const upstreamEnv = Object.entries(env).flatMap(([k, v]) => ["--upstream-env-var", `${k}=${v}`]);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/index.js",
      "proxy",
      "--upstream-command",
      process.execPath,
      "--upstream-arg",
      UPSTREAM,
      "--allow-writes",
      ...(c.scenario ? ["--scenario", c.scenario] : []),
      ...upstreamEnv,
      ...(c.proxy ?? []),
    ],
    env: proProcessEnv(),
    stderr: "ignore",
  });
  const client = new Client({ name: "accuracy-corpus", version: "0.0.1" });
  try {
    await client.connect(transport);
    for (const step of c.steps) {
      if ("parallel" in step) {
        await Promise.all(step.parallel.map((s) => client.callTool({ name: s.tool, arguments: s.args ?? {} })));
      } else {
        await client.callTool({ name: step.tool, arguments: step.args ?? {} });
        if (step.sleepAfterMs) await new Promise((res) => setTimeout(res, step.sleepAfterMs));
      }
    }
    const report = JSON.parse(
      textOf(await client.callTool({ name: "cuonztech__get_report", arguments: { format: "json" } })),
    ) as ReportJson;

    let effekte = 0;
    let ledger: Messung["ledger"] = [];
    try {
      const lines = (await readFile(ledgerFile, "utf8")).split("\n").filter(Boolean);
      ledger = lines.map((l) => JSON.parse(l) as Messung["ledger"][number]);
      effekte = ledger.filter((e) => e.effective).length;
    } catch {
      effekte = 0; // Ledger fehlt: der Upstream hat nie geschrieben.
    }

    let korpusFehler: string | null = null;
    if (c.art === "duplikat" && effekte <= c.intended) {
      korpusFehler = `Fall gilt als Duplikat, aber der Upstream hat nur ${effekte} Datensaetze bei ${c.intended} gewollten.`;
    }
    if (c.art === "sauber" && effekte > c.intended) {
      korpusFehler = `Fall gilt als sauber, aber der Upstream hat ${effekte} Datensaetze bei ${c.intended} gewollten.`;
    }

    const labelOk = c.sollLabel ? report.operations[0]?.outcome === c.sollLabel : null;
    return {
      id: c.id,
      verdict: report.verdict,
      effekte,
      ausfuehrungen: report.operations.reduce((n, o) => n + o.executions, 0),
      operationen: report.operations.map((o) => `${o.tool}:${o.outcome}`),
      beobachtungen: [...new Set(report.observations.map((o) => o.type))].sort(),
      kategorie: kategorie(c.soll, report.verdict),
      labelOk,
      einordnungsHinweis: report.coverage.notes.some((n) => n.startsWith("Classification doubt")),
      korpusFehler,
      ledger,
    };
  } finally {
    await client.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function runAll(cases: Case[], concurrency = 6): Promise<Messung[]> {
  const out: Messung[] = new Array(cases.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < cases.length) {
      const i = next++;
      out[i] = await runCase(cases[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, worker));
  return out;
}
