// verify darf ein unverändertes Dossier nicht als manipuliert melden, nur weil ein Editor, ein Mail-Programm oder ein
// Kopiervorgang die Zeilenenden (Windows: CRLF) oder eine Byte-Order-Marke geändert hat (Falschalarm, gefunden bei der
// Prüfung von Stufe C am 14.11.2026). Ein echter Eingriff in den Inhalt bleibt ein MISMATCH.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { benchCoreOf, } from "../src/dossier-bench.js";
import { checkBenchIntegrity, type BenchDocument } from "../src/bench/report.js";
import { renderDossierHtml, renderDossierMarkdown } from "../src/dossier-report.js";
import type { ReportFile } from "../src/plain-report.js";

const realBench = JSON.parse(readFileSync(resolve("tests/fixtures/bench-report-real.json"), "utf8")) as BenchDocument;
const proxyReport = JSON.parse(readFileSync(resolve("tests/fixtures/bench-proxy-report-real.json"), "utf8")) as ReportFile;

interface Run { out: string; err: string; code: number | null }
function cli(args: string[]): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve("dist/index.js"), ...args], { env: process.env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => done({ out, err, code }));
    child.stdin.end("");
  });
}

describe("verify: Zeilenenden und Byte-Order-Marke sind keine Manipulation", () => {
  let dir: string;
  const options = () => ({
    customerName: "Muster AG",
    systemName: "Testsystem",
    limited: false,
    bench: benchCoreOf(realBench, checkBenchIntegrity(realBench as unknown as Record<string, unknown>)),
  });
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "verify-zeilenenden-"));
    await writeFile(join(dir, "report.json"), JSON.stringify(proxyReport, null, 2), "utf8");
    await writeFile(join(dir, "bench-report.json"), JSON.stringify(realBench, null, 2), "utf8");
    await writeFile(join(dir, "d.md"), renderDossierMarkdown(proxyReport, options()), "utf8");
    await writeFile(join(dir, "d.html"), renderDossierHtml(proxyReport, options()), "utf8");
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }).catch(() => undefined));

  for (const ext of ["md", "html"] as const) {
    const variants: Array<[string, (s: string) => string]> = [
      ["unverändert", (s) => s],
      ["mit Windows-Zeilenenden (CRLF)", (s) => s.replace(/\r?\n/g, "\r\n")],
      ["mit Byte-Order-Marke", (s) => "﻿" + s],
      ["mit CRLF und Byte-Order-Marke", (s) => "﻿" + s.replace(/\r?\n/g, "\r\n")],
    ];
    for (const [name, change] of variants) {
      it(`${ext}: ${name} ergibt OK, auch mit --rerender`, async () => {
        const original = readFileSync(join(dir, `d.${ext}`), "utf8");
        const file = join(dir, `v-${ext}-${name.length}.${ext}`);
        await writeFile(file, change(original), "utf8");
        const plain = await cli(["verify", file, "--report", join(dir, "report.json"), "--bench", join(dir, "bench-report.json")]);
        expect(plain.code, plain.out + plain.err).toBe(0);
        expect(plain.out).toContain("OK");
        const re = await cli(["verify", file, "--report", join(dir, "report.json"), "--bench", join(dir, "bench-report.json"), "--rerender"]);
        expect(re.code, re.out + re.err).toBe(0);
      }, 60_000);
    }
    it(`${ext}: ein geänderter Inhalt bleibt auch mit CRLF ein MISMATCH`, async () => {
      const original = readFileSync(join(dir, `d.${ext}`), "utf8");
      const forged = original.replace("Hat nachgesehen: baseline 0 von 5", "Hat nachgesehen: baseline 5 von 5");
      expect(forged).not.toBe(original);
      const file = join(dir, `forged-${ext}.${ext}`);
      await writeFile(file, forged.replace(/\r?\n/g, "\r\n"), "utf8");
      const r = await cli(["verify", file, "--report", join(dir, "report.json"), "--bench", join(dir, "bench-report.json")]);
      expect(r.code).toBe(1);
      expect(r.out).toContain("MISMATCH");
    }, 60_000);
  }
});
