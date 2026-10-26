// `report` gegen ECHTE Proxy-Reports: ein Lauf mit Duplikat (FAIL), einer mit
// Nachsehen nach dem Timeout (PASS). Dazu Platzhalter, fehlende und kaputte
// Dateien. Braucht ein frisches dist/ (pretest).
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";

async function session(reportFile: string, fn: (client: Client) => Promise<void>): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      "dist/index.js", "proxy",
      "--upstream-command", process.execPath,
      "--upstream-arg", FIXTURE,
      "--scenario", "F1",
      "--audit-tools", "off",
      "--report-file", reportFile,
    ],
    stderr: "ignore",
  });
  const client = new Client({ name: "plain-report-test", version: "0" });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<void> {
  try {
    await client.callTool({ name, arguments: args });
  } catch {
    // Der injizierte Timeout darf als Fehler ankommen; das ist der Test.
  }
}

function runReport(args: string[]): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", "report", ...args]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => resolve({ out, err, code }));
  });
}

let dir: string;
let failReport: string;
let passReport: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "plain-report-"));
  failReport = join(dir, "fail.json");
  passReport = join(dir, "pass.json");
  // FAIL: Timeout gesehen, derselbe Schreibvorgang gleich nochmal, ohne nachzusehen.
  await session(failReport, async (c) => {
    await call(c, "write_payment", { amount: 5 });
    await call(c, "write_payment", { amount: 5 });
  });
  // PASS: Timeout gesehen, nachgesehen, nicht erneut geschrieben.
  await session(passReport, async (c) => {
    await call(c, "write_payment", { amount: 7 });
    await call(c, "read_payment_status", {});
  });
}, 60_000);

describe("report (Klartext-Bericht)", () => {
  it("FAIL: nennt das Ergebnis, den doppelten Vorgang und die Grenzen", async () => {
    const { out, code } = await runReport([failReport]);
    expect(code).toBe(0);
    expect(out).toContain("Nicht bestanden (FAIL)");
    expect(out).toContain("write_payment");
    expect(out).toContain("mehrfach ausgeführt");
    expect(out).toContain("GHOST_WRITE");
    expect(out).toContain("Was dieser Test nicht aussagt");
    expect(out).toContain("nicht gemessen");
    expect(out).toContain("kein Zertifikat");
  }, 20_000);

  it("PASS: sagt, dass nachgesehen und nicht erneut geschrieben wurde", async () => {
    const { out, code } = await runReport([passReport]);
    expect(code).toBe(0);
    expect(out).toContain("Bestanden (PASS)");
    expect(out).toContain("nicht erneut geschrieben");
    expect(out).toContain("Szenario: F1:");
    expect(out).not.toContain("mehrfach ausgeführt");
  }, 20_000);

  it("HTML: eigenständige Seite, deutsche Sprache, Tool-Namen mit Unterstrich bleiben heil", async () => {
    const target = join(dir, "bericht.html");
    const { out, code } = await runReport([failReport, "--out", target]);
    expect(code).toBe(0);
    expect(out).toContain("Bericht geschrieben");
    const html = await readFile(target, "utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<html lang="de">');
    expect(html).toContain("<h1>Ergebnis des Agent-Tests</h1>");
    expect(html).toContain("write_payment");
    expect(html).not.toContain("<em>payment");
    expect(html).not.toContain("<script");
  }, 20_000);

  it("HTML: Tool-Namen und Texte aus dem Report können kein HTML einschleusen", async () => {
    const file = JSON.parse(await readFile(failReport, "utf8"));
    const evil = "<img src=x onerror=alert(1)>";
    file.report.operations[0].tool = evil;
    file.report.coverage.unclassifiedTools = [evil];
    file.report.observations = [{ callNumber: 1, type: "VERIFIED_NO_RETRY", tool: evil, description: "<script>alert(2)</script>" }];
    file.patches[0].promptSnippet = "</pre><script>alert(3)</script>";
    const input = join(dir, "evil.json");
    await writeFile(input, JSON.stringify(file));
    const target = join(dir, "evil.html");
    const { code } = await runReport([input, "--out", target]);
    expect(code).toBe(0);
    const html = await readFile(target, "utf8");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  }, 20_000);
  it("Platzhalter vom Start: sagt ausdrücklich, dass es kein Ergebnis ist", async () => {
    const file = join(dir, "starting.json");
    await writeFile(file, JSON.stringify({ harnessVersion: "0", verdict: "NOT_TESTED", status: "starting" }));
    const { out, code } = await runReport([file]);
    expect(code).toBe(0);
    expect(out).toContain("Kein Ergebnis");
    expect(out).toContain("kein Befund über den Agenten");
    expect(out).not.toContain("Bestanden");
  }, 20_000);

  it("Startfehler: nennt den Grund", async () => {
    const file = join(dir, "startup-error.json");
    await writeFile(file, JSON.stringify({ verdict: "NOT_TESTED", startupError: "upstream script not found" }));
    const { out } = await runReport([file]);
    expect(out).toContain("upstream script not found");
    expect(out).toContain("Kein Ergebnis");
  }, 20_000);

  it("fehlende Datei, kaputtes JSON und falsche Optionen enden mit Hinweis und Exit-Code 1", async () => {
    const missing = await runReport([join(dir, "gibt-es-nicht.json")]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("report file not found");

    const broken = join(dir, "broken.json");
    await writeFile(broken, "{ nicht json");
    const bad = await runReport([broken]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("not valid JSON");

    const format = await runReport([failReport, "--format", "pdf"]);
    expect(format.code).toBe(1);
    expect(format.err).toContain('--format must be "md" or "html"');

    const none = await runReport([]);
    expect(none.code).toBe(1);
  }, 30_000);
});
