// 0.12.0, Stufe E3e (Pro-Gate, Befund B3): Ein Lizenzcode in `--license` steht in der Prozessliste. Hilfe und README empfehlen die
// Umgebungsvariable AGENT_AUDIT_LICENSE (die der Code wirklich liest), und der Harness warnt bei `--license` einmal in einem Satz
// (stderr, nie mit dem Code). Dazu: Das npm-Paket enthält tests/support/ nicht.
import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveLicense, LICENSE_ON_COMMAND_LINE_HINT_DE } from "../src/license/index.js";

const REPORT = resolve("tests/fixtures/bench-proxy-report-real.json");
const TOKEN = process.env.AGENT_AUDIT_LICENSE!;

interface Run {
  out: string;
  err: string;
  code: number | null;
}

/** Kindprozess; `withEnv`: die Lizenz steht als Umgebungsvariable, sonst nur, was die Argumente sagen. */
function cli(args: string[], withEnv: boolean): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (!withEnv) delete env.AGENT_AUDIT_LICENSE;
  return new Promise((done) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => done({ out, err, code }));
    child.stdin.end();
  });
}

const count = (text: string, part: string): number => text.split(part).length - 1;

describe("E3e: die Umgebungsvariable wird gelesen", () => {
  it("AGENT_AUDIT_LICENSE und CUONZTECH_LICENSE_KEY ergeben eine gültige Lizenz, die Option gewinnt", () => {
    expect(TOKEN).toBeTruthy();
    expect(resolveLicense().valid).toBe(true);
    const saved = { a: process.env.AGENT_AUDIT_LICENSE, c: process.env.CUONZTECH_LICENSE_KEY };
    try {
      delete process.env.AGENT_AUDIT_LICENSE;
      expect(resolveLicense().valid).toBe(false);
      process.env.CUONZTECH_LICENSE_KEY = TOKEN;
      expect(resolveLicense().valid).toBe(true);
      expect(resolveLicense("kaputt").valid).toBe(false);
    } finally {
      if (saved.a === undefined) delete process.env.AGENT_AUDIT_LICENSE;
      else process.env.AGENT_AUDIT_LICENSE = saved.a;
      if (saved.c === undefined) delete process.env.CUONZTECH_LICENSE_KEY;
      else process.env.CUONZTECH_LICENSE_KEY = saved.c;
    }
  });

  it("report --dossier mit der Umgebungsvariable ist Pro (volles Dossier), ohne jeden Hinweis auf die Kommandozeile", async () => {
    const run = await cli(["report", REPORT, "--dossier", "--format", "md"], true);
    expect(run.code).toBe(0);
    expect(run.out).toContain("Härtungspaket");
    expect(run.err).not.toContain("Prozessliste");
  });
});

describe("E3e: Warnung bei --license auf der Kommandozeile", () => {
  it("ein Satz auf stderr, einmal, nie mit dem Code; stdout bleibt dasselbe wie mit der Umgebungsvariable", async () => {
    const viaOption = await cli(["report", REPORT, "--dossier", "--format", "md", "--license", TOKEN], false);
    expect(viaOption.code).toBe(0);
    expect(count(viaOption.err, LICENSE_ON_COMMAND_LINE_HINT_DE)).toBe(1);
    expect(viaOption.err).toContain("Prozessliste");
    expect(viaOption.err).toContain("AGENT_AUDIT_LICENSE");
    expect(viaOption.err + viaOption.out).not.toContain(TOKEN);
    const viaEnv = await cli(["report", REPORT, "--dossier", "--format", "md"], true);
    // Das Dossier trägt Datum und Prüfsumme der Erzeugung; verglichen wird der gekürzte Anfang (Urteil und Kopf).
    expect(viaOption.out.slice(0, 400)).toBe(viaEnv.out.slice(0, 400));
    expect(viaOption.out).toContain("Härtungspaket");
  });

  it("auch in der Schreibweise --license=<KEY>", async () => {
    const run = await cli(["report", REPORT, "--dossier", "--format", "md", `--license=${TOKEN}`], false);
    expect(run.code).toBe(0);
    expect(count(run.err, LICENSE_ON_COMMAND_LINE_HINT_DE)).toBe(1);
    expect(run.err + run.out).not.toContain(TOKEN);
  });

  it("der Hinweis ist ein einziger Satz ohne Zeilenumbruch und nennt die Umgebungsvariable", () => {
    expect(LICENSE_ON_COMMAND_LINE_HINT_DE).toContain("AGENT_AUDIT_LICENSE");
    expect(LICENSE_ON_COMMAND_LINE_HINT_DE).not.toContain("\n");
    expect(LICENSE_ON_COMMAND_LINE_HINT_DE.match(/\. /g) ?? []).toHaveLength(0);
  });

  it("ohne --license (nur Umgebungsvariable oder gar keine Lizenz) kommt der Hinweis nicht", async () => {
    const none = await cli(["report", REPORT, "--format", "md"], false);
    expect(none.err).not.toContain("Prozessliste");
  });
});

describe("E3e: Hilfe, README und Paket", () => {
  it("die Hilfe empfiehlt die Umgebungsvariable und nennt die Prozessliste", async () => {
    const run = await cli(["--help"], false);
    expect(run.out + run.err).toContain("Prozessliste");
    expect(run.out + run.err).toMatch(/Umgebungsvariable AGENT_AUDIT_LICENSE[^\n]*empfohlen/);
  });

  it("die README empfiehlt die Umgebungsvariable und nennt die Prozessliste", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("Empfohlen ist die Umgebungsvariable");
    expect(readme).toContain("Prozessliste");
  });

  it("tests/support/ ist nicht im npm-Paket (npm pack --dry-run)", () => {
    const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8", shell: process.platform === "win32", timeout: 120_000 });
    expect(r.status, r.stderr).toBe(0);
    const start = r.stdout.indexOf("[");
    const files = (JSON.parse(r.stdout.slice(start)) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((f) => f.startsWith("tests/") || f.includes("license-test-key"))).toEqual([]);
    expect(files.filter((f) => /^(src|docs|scripts|examples\/(?!testsystem\/server\.mjs$))/.test(f))).toEqual([]);
    expect(files).toContain("dist/license/ed25519.js");
  }, 130_000);
});
