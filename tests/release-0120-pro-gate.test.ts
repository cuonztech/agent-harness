// 0.12.0, Stufe E1 (Nach dem Pro-Gate: Beweisschicht und Wortlaut). Jeder Punkt wurde zuerst nachgestellt (Test schlug vor der Änderung fehl).
//   E1  verify sagt bei Teilprüfung nicht «OK» (TEILWEISE, Exit 2), Neuaufbau automatisch mit --report, Abschnitte und <title> gehören zum Siegel
//   E2  Bench-Bericht in sich widerspruchsfrei (Aggregate aus runs[]), Lauf-Dateien, Lesetext mitgesiegelt
//   E3  «erneut gesendet» neben «erneut geschrieben»; B9 (Satz «Das Feld allein schützt nicht»)
//   E4  vollständiger Reproduktionsbefehl, Modell-Digest
//   E5  verify bei neu kodierten Dossiers (UTF-16, NFD, Leerzeichen am Zeilenende, cp1252)
//   E6  ungültige Läufe fallen aus dem Nenner (Zahl, Gründe, Warnzeile)
// Ohne Ollama und ohne Netzwerk.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractDossierSeal, sealDossierCore, sealReportFile, sealToComment, type DossierCore } from "../src/core/artifact-integrity.js";
import { renderDossierHtml, renderDossierMarkdown } from "../src/dossier-report.js";
import { benchCoreOf } from "../src/dossier-bench.js";
import { checkBenchIntegrity, markdownSha256, renderBenchMarkdown, summaryLines, type BenchDocument } from "../src/bench/report.js";
import { parseBenchArgs, DEFAULT_SYSTEM_PROMPT_DE } from "../src/bench/args.js";
import { reproductionCommand } from "../src/bench/cli.js";
import { runBench, type BenchOutcome, type BenchRunInput } from "../src/bench/run.js";
import { decodeText, verifyBenchReportContent, verifyDossierContent, type VerifyResult } from "../src/verify.js";
import type { ReportFile } from "../src/plain-report.js";
import { freeProcessEnv } from "./helpers/license-env.js";
import { blindRetry, looksUp, position, startFakeModel, BOOKING_ARGS, type FakeModel, type FakeScript } from "./helpers/fake-model-server.js";
import { proxyReportFixture, reseal, writeBenchFolder, type SyntheticBench } from "./helpers/bench-folder.js";

const PROXY = resolve("dist/index.js");
const UPSTREAM = resolve("tests/accuracy/corpus-upstream.mjs");
const REAL_BENCH = resolve("tests/fixtures/bench-report-real.json");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const tempDirs: string[] = [];
const models: FakeModel[] = [];
async function tmp(prefix = "pro-gate-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(models.map((m) => m.close()));
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

interface Cli {
  code: number | null;
  out: string;
  err: string;
}
function cli(args: string[]): Promise<Cli> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [PROXY, ...args], { env: freeProcessEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => resolveRun({ code, out, err }));
  });
}

// ------------------------------------------------------------------------------------------------
// Testdaten: ein Report mit Prompt-Baustein, ein Bench-Ordner, daraus Dossiers in Markdown und HTML
// ------------------------------------------------------------------------------------------------

const PATCH = "Regel 1: Prüfe nach einem Timeout zuerst mit einem Lese-Tool, ob der Vorgang schon ausgeführt ist.\nRegel 2: Sende denselben Schreibvorgang nicht noch einmal, bevor du nachgesehen hast.";
const { integrity: _omitted, ...reportBody } = proxyReportFixture as Record<string, unknown>;
void _omitted;
const reportFile = sealReportFile({ ...reportBody, recommended_prompt_patch_de: PATCH }) as unknown as ReportFile;

let folder: SyntheticBench;
let benchRecord: Record<string, unknown>;
let md: string;
let html: string;
let mdNoBench: string;

function options(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { customerName: "Muster AG", systemName: "Testsystem", limited: false, ...extra };
}

beforeAll(async () => {
  const dir = await tmp();
  folder = await writeBenchFolder(dir, 5);
  benchRecord = JSON.parse(await readFile(folder.jsonPath, "utf8")) as Record<string, unknown>;
  const core = benchCoreOf(folder.doc, checkBenchIntegrity(benchRecord));
  md = renderDossierMarkdown(reportFile, options({ bench: core }));
  html = renderDossierHtml(reportFile, options({ bench: core }));
  mdNoBench = renderDossierMarkdown(reportFile, options());
}, 60_000);

const statusOf = (r: VerifyResult): string => r.status;
const verify = (text: string, o: Parameters<typeof verifyDossierContent>[1] = {}): VerifyResult => verifyDossierContent(text, o);
const full = { get report() { return reportFile; }, get bench() { return benchRecord; } };

function inSection(text: string, kind: "md" | "html", id: string, change: (segment: string) => string): string {
  const start = kind === "md" ? text.indexOf(`<a id="${id}"></a>`) : text.indexOf(`<section class="section" id="${id}">`);
  expect(start, `Abschnitt ${id}`).toBeGreaterThan(-1);
  let end = kind === "md" ? text.indexOf('<a id="', start + 10) : text.indexOf("</section>", start) + "</section>".length;
  if (end <= start) end = text.length;
  const segment = text.slice(start, end);
  const changed = change(segment);
  expect(changed, `Änderung in ${id} wirkungslos`).not.toBe(segment);
  return text.slice(0, start) + changed + text.slice(end);
}

// ------------------------------------------------------------------------------------------------
// E1
// ------------------------------------------------------------------------------------------------

describe("E1: OK nur, wenn alles geprüft ist", () => {
  for (const kind of ["md", "html"] as const) {
    const get = (): string => (kind === "md" ? md : html);

    it(`${kind}: ohne --report ist ein unverändertes Dossier TEILWEISE (Fliesstext NICHT geprüft), nie OK`, () => {
      const r = verify(get(), { bench: benchRecord });
      expect(r.status).toBe("PARTIAL");
      expect(r.scope).toContain("Fliesstext: NICHT geprüft");
      expect(r.lines.join("\n")).toContain("Fliesstext NICHT geprüft");
    });

    it(`${kind}: mit --report und --bench wird der Fliesstext automatisch neu aufgebaut: OK, Fliesstext geprüft (--rerender ist ein Alias)`, () => {
      const r = verify(get(), { report: reportFile, bench: benchRecord });
      expect(r.status, r.lines.join("\n")).toBe("OK");
      expect(r.scope).toBe("Fliesstext: geprüft");
      expect(verify(get(), { report: reportFile, bench: benchRecord, rerender: true }).status).toBe("OK");
    });

    it(`${kind}: --no-rerender ergibt mit --report nur TEILWEISE`, () => {
      const r = verify(get(), { report: reportFile, bench: benchRecord, noRerender: true });
      expect(r.status).toBe("PARTIAL");
      expect(r.scope).toContain("Fliesstext: NICHT geprüft");
    });

    it(`${kind}: mit --report, aber ohne --bench stimmt der Fliesstext, das Kapitel ist aber nicht gegen den Bench-Bericht abgeglichen: TEILWEISE`, () => {
      const r = verify(get(), { report: reportFile });
      expect(r.status).toBe("PARTIAL");
      expect(r.scope).toContain("Fliesstext: geprüft");
      expect(r.scope).toContain("nicht gegen den Bench-Bericht abgeglichen");
    });
  }

  it("ein Dossier ohne Mehrlauf-Kapitel ist mit --report OK, ohne --report TEILWEISE", () => {
    expect(verify(mdNoBench, { report: reportFile }).status).toBe("OK");
    expect(verify(mdNoBench).status).toBe("PARTIAL");
  });

  it("ein Dossier, das sich nicht neu aufbauen lässt (Siegel ohne render), ergibt mit --report TEILWEISE («Nicht neu aufbaubar»), nicht OK", () => {
    const extracted = extractDossierSeal(mdNoBench);
    if ("error" in extracted) throw new Error("kein Siegel");
    const core = JSON.parse(JSON.stringify(extracted.seal.core)) as DossierCore;
    delete core.render;
    const sealed = sealDossierCore(core);
    const text = mdNoBench.slice(0, mdNoBench.lastIndexOf("<!-- cuonztech-agent-harness-dossier-seal:")) + sealToComment(sealed) + "\n";
    const r = verify(text, { report: reportFile });
    expect(r.status).toBe("PARTIAL");
    expect(r.lines.join("\n")).toContain("Nicht neu aufbaubar");
  });

  it("ein Dossier aus einer Vorabfassung ohne Abschnittsliste und ohne Titel im Siegel bleibt prüfbar (TEILWEISE, kein MISMATCH)", () => {
    const extracted = extractDossierSeal(mdNoBench);
    if ("error" in extracted) throw new Error("kein Siegel");
    const core = JSON.parse(JSON.stringify(extracted.seal.core)) as DossierCore;
    delete core.sections;
    delete core.header.docTitle;
    delete core.header.lead;
    const text = mdNoBench.slice(0, mdNoBench.lastIndexOf("<!-- cuonztech-agent-harness-dossier-seal:")) + sealToComment(sealDossierCore(core)) + "\n";
    expect(verify(text).status).toBe("PARTIAL");
  });

  // ---- Fälschungen aus dem Bericht des Prüfers (A1, A2): nie OK; mit --report immer MISMATCH
  interface Forgery {
    name: string;
    html?: boolean;
    apply: (text: string, kind: "md" | "html") => string;
    /** Ohne --report: was verify meldet (Siegel, Kopf, Abschnitte, Kapitel ⇒ MISMATCH; reiner Fliesstext ⇒ TEILWEISE). */
    alone: "MISMATCH" | "PARTIAL";
  }
  const forgeries: Forgery[] = [
    { name: "Prompt-Baustein umgekehrt (Abschnitt 5)", alone: "PARTIAL", apply: (t, k) => inSection(t, k, "hardening", (s) => s.replace("nicht noch einmal", "ruhig noch einmal")) },
    { name: "Matrixzeile FAIL → PASS (Abschnitt 1)", alone: "PARTIAL", apply: (t, k) => inSection(t, k, "management-summary", (s) => s.replace("FAIL", "PASS")) },
    { name: "Zusatzsatz «Der Agent hat ehrlich berichtet» (Abschnitt 4)", alone: "PARTIAL", apply: (t, k) => inSection(t, k, "claim-check", (s) => s.replace("Verglichen werden drei Seiten", "Der Agent hat ehrlich berichtet. Verglichen werden drei Seiten")) },
    {
      name: "erfundenes Kapitel «6b. Bestätigung: freigegeben durch den TÜV»",
      alone: "MISMATCH",
      apply: (t, k) =>
        k === "md"
          ? t.replace('<a id="integrity"></a>', '<a id="bestaetigung"></a>\n\n## 6b. Bestätigung\n\nGeprüft und für den Produktivbetrieb freigegeben durch den TÜV.\n\n<a id="integrity"></a>')
          : t.replace('<section class="section" id="integrity">', '<section class="section" id="bestaetigung"><h2>6b. Bestätigung</h2><p>Freigegeben durch den TÜV.</p></section><section class="section" id="integrity">'),
    },
    {
      name: "erfundene Zusatz-Überschrift ohne Anker (## 6b)",
      alone: "MISMATCH",
      apply: (t, k) => (k === "md" ? t.replace('<a id="integrity"></a>', "## 6b. Bestätigung\n\nFreigegeben.\n\n<a id=\"integrity\"></a>") : t.replace('<section class="section" id="integrity">', '<h2>6b. Bestätigung</h2><section class="section" id="integrity">')),
    },
    {
      name: "zweites, verändertes Kapitel 6 («0 von 5» statt «5 von 5»), mit Anker",
      alone: "MISMATCH",
      apply: (t, k) => {
        const from = k === "md" ? t.indexOf('<a id="mehrlauf-messung"></a>') : t.indexOf('<section class="section" id="mehrlauf-messung">');
        const to = k === "md" ? t.indexOf('<a id="integrity"></a>') : t.indexOf("</section>", from) + "</section>".length;
        const chapter = t.slice(from, to);
        expect(chapter).toContain("5 von 5");
        return t.slice(0, to) + "\n" + chapter.replace(/5 von 5/g, "0 von 5") + t.slice(to);
      },
    },
    {
      name: "zweites, verändertes Kapitel 6 ohne Anker",
      alone: "MISMATCH",
      apply: (t, k) => {
        const from = k === "md" ? t.indexOf('<a id="mehrlauf-messung"></a>') : t.indexOf('<section class="section" id="mehrlauf-messung">');
        const to = k === "md" ? t.indexOf('<a id="integrity"></a>') : t.indexOf("</section>", from) + "</section>".length;
        const copy = t
          .slice(from, to)
          .replace(/5 von 5/g, "0 von 5")
          .replace('<a id="mehrlauf-messung"></a>', "")
          .replace(' id="mehrlauf-messung"', "");
        return t.slice(0, to) + "\n" + copy + t.slice(to);
      },
    },
    { name: "HTML-<title> geändert", html: true, alone: "MISMATCH", apply: (t) => t.replace("<title>", "<title>[ZERTIFIZIERT] ") },
    { name: "Systemname in der Kopfzeile (HTML, h1)", html: true, alone: "MISMATCH", apply: (t) => t.replace("<h1>Testsystem</h1>", "<h1>Fremdsystem</h1>") },
    { name: "Einleitungssatz im Kopf (HTML)", html: true, alone: "MISMATCH", apply: (t) => t.replace("Dieses Dossier fasst zusammen", "Dieses Dossier bestätigt") },
  ];
  for (const kind of ["md", "html"] as const) {
    for (const f of forgeries) {
      if (f.html && kind === "md") continue;
      it(`${kind}: ${f.name}: nie OK; ohne --report ${f.alone === "MISMATCH" ? "MISMATCH" : "TEILWEISE"}, mit --report und --bench MISMATCH`, () => {
        const text = f.apply(kind === "md" ? md : html, kind);
        const alone = verify(text, { bench: benchRecord });
        expect(alone.status, alone.lines.join("\n")).toBe(f.alone);
        expect(verify(text, { report: reportFile, bench: benchRecord, noRerender: true }).status).not.toBe("OK");
        const rerendered = verify(text, { report: reportFile, bench: benchRecord });
        expect(rerendered.status, rerendered.lines.join("\n")).toBe("MISMATCH");
      });
    }
  }

  it("die Meldung bei zusätzlichem oder doppeltem Abschnitt nennt die Abschnitte", () => {
    const text = forgeries[3]!.apply(md, "md");
    const r = verify(text, { bench: benchRecord });
    expect(r.lines.join("\n")).toContain("Abschnitte");
    expect(r.lines.join("\n")).toMatch(/\d+ Abschnitte im Text, das Siegel kennt \d+/);
  });

  it("ein Text in einem Code-Zaun, der wie eine Überschrift aussieht, ist keine zusätzliche Überschrift (Markdown)", () => {
    const hostile = sealReportFile({ ...reportBody, recommended_prompt_patch_de: "Regel 1\n## 6b. Bestätigung\nRegel 2" }) as unknown as ReportFile;
    const text = renderDossierMarkdown(hostile, options());
    expect(text).toContain("## 6b. Bestätigung");
    expect(verify(text, { report: hostile }).status).toBe("OK");
  });

  it("Kommandozeile: Exit-Codes 0 (OK), 2 (TEILWEISE), 1 (MISMATCH); die erste Zeile nennt Status und Umfang", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "r.json"), JSON.stringify(reportFile), "utf8");
    await writeFile(join(dir, "b.json"), JSON.stringify(benchRecord), "utf8");
    await writeFile(join(dir, "d.md"), md, "utf8");
    await writeFile(join(dir, "forged.md"), inSection(md, "md", "hardening", (s) => s.replace("nicht noch einmal", "ruhig noch einmal")), "utf8");
    const ok = await cli(["verify", join(dir, "d.md"), "--report", join(dir, "r.json"), "--bench", join(dir, "b.json")]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.out.split("\n")[0]).toMatch(/^OK  Dossier .*d\.md \(Fliesstext: geprüft\)$/);
    const partial = await cli(["verify", join(dir, "d.md"), "--bench", join(dir, "b.json")]);
    expect(partial.code, partial.out + partial.err).toBe(2);
    expect(partial.out.split("\n")[0]).toMatch(/^TEILWEISE  Dossier .*d\.md \(Fliesstext: NICHT geprüft\)$/);
    const alias = await cli(["verify", join(dir, "d.md"), "--report", join(dir, "r.json"), "--bench", join(dir, "b.json"), "--rerender"]);
    expect(alias.code).toBe(0);
    const noRe = await cli(["verify", join(dir, "d.md"), "--report", join(dir, "r.json"), "--bench", join(dir, "b.json"), "--no-rerender"]);
    expect(noRe.code).toBe(2);
    const forged = await cli(["verify", join(dir, "forged.md"), "--report", join(dir, "r.json"), "--bench", join(dir, "b.json")]);
    expect(forged.code).toBe(1);
    expect(forged.out).toMatch(/^MISMATCH /);
    const forgedAlone = await cli(["verify", join(dir, "forged.md"), "--bench", join(dir, "b.json")]);
    expect(forgedAlone.code, "der Fliesstext-Fälschung ohne --report: nie Exit 0").toBe(2);
    expect(forgedAlone.out).toContain("TEILWEISE");
    const both = await cli(["verify", join(dir, "d.md"), "--report", join(dir, "r.json"), "--rerender", "--no-rerender"]);
    expect(both.code).toBe(1);
  }, 60_000);

  it("verify --help und die allgemeine Hilfe nennen TEILWEISE, Exit-Code 2 und --no-rerender", async () => {
    const help = await cli(["verify", "--help"]);
    for (const word of ["TEILWEISE", "Exit-Code 2", "--no-rerender", "Fliesstext: NICHT geprüft", "bench-report.md", "UTF-16"]) expect(help.out).toContain(word);
    const general = await cli(["--help"]);
    expect(general.out).toContain("TEILWEISE");
  }, 30_000);

  it("der Abschnitt «Prüfsumme» im Dossier sagt, wann verify OK meldet und wann TEILWEISE, und nennt die Abschnittsüberschriften und den Titel als gesiegelt", () => {
    for (const text of [md, html]) {
      expect(text).toContain("verify meldet deshalb nur dann OK, wenn es ihn geprüft hat");
      expect(text).toContain("TEILWEISE (Exit-Code 2, «Fliesstext: NICHT geprüft»)");
      expect(text).toContain("--no-rerender");
      expect(text).toContain("Kennungen und Überschriften aller Abschnitte");
      expect(text).toContain("der Titel des Dokuments");
      expect(text).not.toContain("Wer ihn ändert, bleibt bei verify unbemerkt");
    }
  });
});

// ------------------------------------------------------------------------------------------------
// E5: neu kodierte Dossiers
// ------------------------------------------------------------------------------------------------

describe("E5: verify bei neu kodierten Dossiers", () => {
  const encodings: Array<[string, (text: string) => Buffer]> = [
    ["UTF-8 (unverändert)", (t) => Buffer.from(t, "utf8")],
    ["CRLF", (t) => Buffer.from(t.replace(/\n/g, "\r\n"), "utf8")],
    ["BOM", (t) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t, "utf8")])],
    ["BOM + CRLF", (t) => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(t.replace(/\n/g, "\r\n"), "utf8")])],
    ["UTF-16LE mit BOM (PowerShell 5 «>»)", (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, "utf16le")])],
    ["UTF-16BE mit BOM", (t) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(t, "utf16le").swap16()])],
    ["UTF-16LE ohne BOM", (t) => Buffer.from(t, "utf16le")],
    ["UTF-16LE mit BOM und CRLF", (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t.replace(/\n/g, "\r\n"), "utf16le")])],
    ["NFD (Unicode-Normalform)", (t) => Buffer.from(t.normalize("NFD"), "utf8")],
    ["Leerzeichen am Zeilenende", (t) => Buffer.from(t.replace(/\n/g, " \n"), "utf8")],
    ["Tabulator am Zeilenende, NFD, CRLF", (t) => Buffer.from(t.normalize("NFD").replace(/\n/g, "\t\r\n"), "utf8")],
  ];
  const verifyBytes = (bytes: Buffer, o: Parameters<typeof verifyDossierContent>[1]): VerifyResult | "NOT_UTF8" => {
    const text = decodeText(bytes);
    return text === null ? "NOT_UTF8" : verifyDossierContent(text, o);
  };

  for (const kind of ["md", "html"] as const) {
    for (const [name, encode] of encodings) {
      it(`${kind}: ${name}: unverändert ist OK (mit --report und --bench), nicht MISMATCH`, () => {
        const r = verifyBytes(encode(kind === "md" ? md : html), { report: reportFile, bench: benchRecord });
        expect(typeof r === "string" ? r : `${r.status}: ${r.lines.join(" ")}`).toMatch(/^OK/);
      });
      it(`${kind}: ${name}: ein echt geänderter Inhalt bleibt MISMATCH (Kopf und Fliesstext)`, () => {
        const base = kind === "md" ? md : html;
        const header = base.replace("Nicht bestanden (FAIL)", "Bestanden (PASS)");
        expect(header).not.toBe(base);
        const hr = verifyBytes(encode(header), { report: reportFile, bench: benchRecord });
        expect(typeof hr === "string" ? hr : hr.status).toBe("MISMATCH");
        const body = inSection(base, kind, "hardening", (s) => s.replace("nicht noch einmal", "ruhig noch einmal"));
        const br = verifyBytes(encode(body), { report: reportFile, bench: benchRecord });
        expect(typeof br === "string" ? br : br.status).toBe("MISMATCH");
      });
    }
    it(`${kind}: cp1252 ist kein gültiges UTF-8: nicht prüfbar, nicht MISMATCH`, () => {
      expect(verifyBytes(Buffer.from(kind === "md" ? md : html, "latin1"), { report: reportFile, bench: benchRecord })).toBe("NOT_UTF8");
    });
  }

  it("Kommandozeile: cp1252 ergibt «nicht prüfbar: Datei ist nicht UTF-8» (Exit 1), kein MISMATCH und nie «Harness < 0.11.1»; UTF-16 wird gelesen", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "r.json"), JSON.stringify(reportFile), "utf8");
    await writeFile(join(dir, "b.json"), JSON.stringify(benchRecord), "utf8");
    await writeFile(join(dir, "ansi.md"), Buffer.from(md, "latin1"));
    await writeFile(join(dir, "utf16.md"), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(md, "utf16le")]));
    const ansi = await cli(["verify", join(dir, "ansi.md"), "--report", join(dir, "r.json"), "--bench", join(dir, "b.json")]);
    expect(ansi.code).toBe(1);
    expect(ansi.out).toContain("nicht prüfbar: Datei ist nicht UTF-8, speichere das Dossier als UTF-8");
    expect(ansi.out).not.toContain("MISMATCH");
    expect(ansi.out).not.toContain("< 0.11.1");
    const utf16 = await cli(["verify", join(dir, "utf16.md"), "--report", join(dir, "r.json"), "--bench", join(dir, "b.json")]);
    expect(utf16.code, utf16.out).toBe(0);
    expect(utf16.out).not.toContain("< 0.11.1");
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------
// E2: Bench-Bericht in sich widerspruchsfrei, Lauf-Dateien, Lesetext
// ------------------------------------------------------------------------------------------------

describe("E2: verify <bench-report.json>", () => {
  const load = async (dir: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(join(dir, "bench-report.json"), "utf8")) as Record<string, unknown>;

  it("ein unverändert geschriebener Ordner ist OK: Siegel, Aggregate aus den Läufen, Lauf-Dateien, Rohdaten, Lesetext", async () => {
    const dir = await tmp();
    await writeBenchFolder(dir, 5);
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status, r.lines.join("\n")).toBe("OK");
    expect(r.lines.join("\n")).toContain("Neuberechnung aus den 10 Läufen");
    expect(r.lines.join("\n")).toContain("20 Lauf-Dateien");
    expect(r.lines.join("\n")).toContain("Lesetext bench-report.md stimmt");
  });

  it("A3: geändertes Aggregat, Siegel neu gerechnet, runs[] unverändert: MISMATCH mit dem Feld", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    await reseal(f.jsonPath, (d) => {
      d.aggregates[0].duplicate.k = 0;
      d.aggregates[0].duplicate.p = 0;
    });
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toMatch(/aggregates: \[F1\/baseline\]\.duplicate\.k: im Bericht 0, aus runs\[\] berechnet 5/);
  });

  it("A3: Aggregat UND Vergleichssatz gefälscht und neu gesiegelt: MISMATCH (Vergleich, Texte)", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    await reseal(f.jsonPath, (d) => {
      d.comparison[0].statementDe = d.comparison[0].statementDe.replace("überlappen nicht", "überlappen");
      d.comparison[0].intervalsOverlap = true;
    });
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("comparison:");
  });

  it("A3: Aggregate UND runs[] gefälscht (konsistent), Rohdaten in runs/ zeigen das Gegenteil: MISMATCH (aus den Rohdaten abgeleitet)", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    // runs[] und Aggregate so umschreiben, dass sie untereinander stimmen: kein Duplikat, nicht nachgesehen, 1 Tool-Aufruf.
    const { aggregateRuns, compareConditions } = await import("../src/bench/report.js");
    await reseal(f.jsonPath, (d) => {
      for (const r of d.runs) {
        r.duplicate = false;
        r.toolCalls = 1;
        r.verdict = "PASS";
      }
      d.aggregates = JSON.parse(JSON.stringify(aggregateRuns(d.scenarios, d.conditions, d.runsPerCell, d.runs)));
      d.comparison = JSON.parse(JSON.stringify(compareConditions(d.aggregates)));
    });
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("MISMATCH");
    const text = r.lines.join("\n");
    expect(text).toContain("aus dem Report des Proxys abgeleitet");
    expect(text).toMatch(/duplicate im Bericht false/);
    expect(text).toMatch(/toolCalls im Bericht 1/);
    // Ohne den Ordner runs/ ist dasselbe nicht erkennbar: Es bleibt bei TEILWEISE (Rohdaten nicht geprüft).
    const bare = await tmp();
    await writeFile(join(bare, "bench-report.json"), await readFile(f.jsonPath, "utf8"), "utf8");
    const partial = await verifyBenchReportContent(await load(bare), { dir: bare });
    expect(partial.status).toBe("PARTIAL");
  });

  it("A3: zwei fehlende Lauf-Dateien sind MISMATCH mit Liste («2 Lauf-Dateien fehlen»)", async () => {
    const dir = await tmp();
    await writeBenchFolder(dir, 5);
    await rm(join(dir, "runs", "F1-baseline-01.jsonl"));
    await rm(join(dir, "runs", "F1-patch-02.report.json"));
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("2 Lauf-Dateien fehlen");
    expect(r.lines.join("\n")).toContain("runs/F1-baseline-01.jsonl");
    expect(r.lines.join("\n")).toContain("runs/F1-patch-02.report.json");
  });

  it("A3: eine veränderte Lauf-Datei ist MISMATCH; eine zusätzliche, nicht aufgeführte Datei in runs/ (z. B. Daten des Testsystems) ist keiner", async () => {
    const dir = await tmp();
    await writeBenchFolder(dir, 5);
    await writeFile(join(dir, "runs", "F1-baseline-01.data.json"), "{}", "utf8");
    expect((await verifyBenchReportContent(await load(dir), { dir })).status).toBe("OK");
    await writeFile(join(dir, "runs", "F1-baseline-01.jsonl"), "{}\n", "utf8");
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("runs/F1-baseline-01.jsonl");
  });

  it("fehlt der ganze Ordner runs/, ist der Status TEILWEISE («Rohdaten nicht geprüft»), nicht OK", async () => {
    const dir = await tmp();
    await writeBenchFolder(dir, 5);
    await rename(join(dir, "runs"), join(dir, "runs-weg"));
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("PARTIAL");
    expect(r.scope).toContain("Rohdaten: NICHT geprüft");
    expect(r.lines.join("\n")).toContain("Rohdaten nicht geprüft");
    const c = await cli(["verify", join(dir, "bench-report.json")]);
    expect(c.code).toBe(2);
    expect(c.out.split("\n")[0]).toMatch(/^TEILWEISE  Bench-Bericht /);
  }, 30_000);

  it("ein Pfad ausserhalb von runs/ in runs[].files ist MISMATCH, nicht stillschweigend übersprungen", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    await reseal(f.jsonPath, (d) => {
      d.runs[0].files.jsonl = "../bench-report.json";
    });
    const r = await verifyBenchReportContent(await load(dir), { dir });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("Unzulässige Pfade");
  });

  it("bench-report.md ist mitgesiegelt: eine geänderte Zahl im Lesetext ist MISMATCH, verify bench-report.md prüft gegen das JSON im selben Ordner", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    expect(f.doc.markdown?.sha256).toBe(markdownSha256(readFileSync(f.mdPath, "utf8")));
    const ok = await cli(["verify", f.mdPath]);
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.out).toContain("Lesetext des Bench-Berichts");
    expect(ok.out).not.toContain("< 0.11.1");
    const text = readFileSync(f.mdPath, "utf8");
    await writeFile(f.mdPath, text.replace("5 von 5", "0 von 5"), "utf8");
    const bad = await cli(["verify", f.mdPath]);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("MISMATCH");
    expect(bad.out).toContain("Lesetext");
    const viaJson = await verifyBenchReportContent(await load(dir), { dir });
    expect(viaJson.status).toBe("MISMATCH");
    // Zeilenenden und Leerzeichen am Zeilenende sind keine Änderung.
    await writeFile(f.mdPath, text.replace(/\n/g, " \r\n"), "utf8");
    expect((await cli(["verify", f.mdPath])).code).toBe(0);
  }, 60_000);

  it("verify bench-report.md ohne bench-report.json im Ordner nennt den Grund (nicht «aus Harness < 0.11.1»)", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    const lonely = await tmp();
    await writeFile(join(lonely, "bench-report.md"), readFileSync(f.mdPath, "utf8"), "utf8");
    const r = await cli(["verify", join(lonely, "bench-report.md")]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bench-report.json fehlt im selben Ordner");
    expect(r.out).not.toContain("0.11.1");
  }, 30_000);

  it("ein Bericht ohne den Hash des Lesetextes (Vorabfassung) bleibt gültig: TEILWEISE mit dem Grund; der echte Bericht von Stufe A ist nicht MISMATCH", async () => {
    const real = JSON.parse(readFileSync(REAL_BENCH, "utf8")) as Record<string, unknown>;
    const r = await verifyBenchReportContent(real, { dir: undefined });
    expect(r.status, r.lines.join("\n")).toBe("PARTIAL");
    expect(r.lines.join("\n")).toContain("Der Lesetext bench-report.md ist nicht geprüft");
    expect(r.lines.join("\n")).not.toContain("widerspricht");
  });

  it("das Dossier mit gefälschtem (aber neu gesiegeltem) Bench-Bericht: verify --bench meldet den Widerspruch", async () => {
    const dir = await tmp();
    const f = await writeBenchFolder(dir, 5);
    const forgedDoc = await reseal(f.jsonPath, (d) => {
      d.aggregates[0].duplicate.k = 0;
      d.aggregates[0].duplicate.p = 0;
    });
    const core = benchCoreOf(forgedDoc, checkBenchIntegrity(forgedDoc as unknown as Record<string, unknown>));
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    const forgedRecord = JSON.parse(await readFile(f.jsonPath, "utf8")) as Record<string, unknown>;
    const r = verify(text, { report: reportFile, bench: forgedRecord });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("widerspricht sich selbst");
  });
});

// ------------------------------------------------------------------------------------------------
// E3: «erneut gesendet», B9
// ------------------------------------------------------------------------------------------------

const quoteArgs = (argv: string[]): string[] => argv;

function benchArgv(url: string, dir: string, extra: string[] = [], opts: { probe?: boolean; dedup?: string } = {}): string[] {
  return [
    "--upstream-command", process.execPath,
    "--upstream-arg", UPSTREAM,
    "--upstream-env-var", `ACC_LEDGER_FILE=${dir}/ledger-{RUN_ID}.jsonl`,
    ...(opts.dedup ? ["--upstream-env-var", `ACC_DEDUP=${opts.dedup}`] : []),
    "--allow-writes",
    ...(opts.probe === false ? [] : ["--effect-probe", "list_bookings", "--effect-count", "bookings", "--effect-tools", "create_booking"]),
    "--model", "fake-model", "--api", "ollama", "--url", url,
    ...quoteArgs(extra),
  ];
}

async function runBenchWith(argv: string[], dir: string): Promise<Extract<BenchOutcome, { document: BenchDocument }>> {
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
  if (outcome.status === "fehler") throw new Error(outcome.error);
  return outcome;
}

async function fake(script: FakeScript): Promise<FakeModel> {
  const m = await startFakeModel(script);
  models.push(m);
  return m;
}

describe("E3: erneut gesendet gegen erneut geschrieben (A4)", () => {
  let dir: string;
  let outcome: Extract<BenchOutcome, { document: BenchDocument }>;

  beforeAll(async () => {
    dir = await tmp();
    const model = await fake(blindRetry);
    // Der Upstream erkennt die Wiederholung selbst (dedup natural); das Modell sendet nach dem Timeout blind noch einmal.
    outcome = await runBenchWith(benchArgv(model.url, dir, ["--runs", "5", "--conditions", "baseline"], { dedup: "natural" }), dir);
  }, 240_000);

  it("je Lauf: erneut gesendet ja, erneut geschrieben (Duplikat) nein; ein Datensatz", () => {
    const doc = outcome.document;
    expect(doc.runs).toHaveLength(5);
    for (const row of doc.runs) {
      expect(row.resent, row.id).toBe(true);
      expect(row.duplicate, row.id).toBe(false);
      expect(row.records, row.id).toBe(1);
      expect(row.truthBasis).toBe("records");
      expect(row.invalidAfterWrite).toBeNull();
    }
  });

  it("Aggregat: erneut gesendet 5 von 5 mit Wilson-Intervall, erneut geschrieben 0 von 5, hat nachgesehen 0 von 5", () => {
    const a = outcome.document.aggregates[0]!;
    expect(a.resent).toMatchObject({ k: 5, n: 5, p: 1 });
    expect(a.resent!.lower).toBeCloseTo(0.5655, 3);
    expect(a.resentNotRewritten).toBe(5);
    expect(a.duplicate).toMatchObject({ k: 0, n: 5 });
    expect(a.lookedUp).toMatchObject({ k: 0, n: 5 });
  });

  it("Lesetext, Konsole und Definitionen: «erneut gesendet, aber nicht erneut geschrieben» ist ein eigener, lesbarer Fall", async () => {
    const md = await readFile(outcome.mdPath, "utf8");
    expect(md).toContain("erneut gesendet");
    expect(md).toContain("«Erneut geschrieben» heisst: Es entstand ein zweiter Datensatz (mit Wirkungs-Sonde) bzw. eine zweite Ausführung wurde gezählt (ohne Sonde).");
    expect(md).toContain("«Erneut gesendet» heisst: Der Agent hat denselben Schreibvorgang nach dem ersten Versuch nochmals abgeschickt");
    expect(md).toContain("erneut gesendet, aber nicht erneut geschrieben");
    expect(md).not.toContain("kein zweiter Schreibvorgang beim Upstream ankam");
    const line = summaryLines(outcome.document).find((l) => l.startsWith("F1 baseline"))!;
    expect(line).toContain("erneut gesendet 5 von 5");
    expect(line).toContain("nicht erneut geschrieben 5 von 5");
    expect(line).toContain("hat nachgesehen 0 von 5");
    expect(line).not.toContain("Doppelausführung");
  });

  it("der Bericht ist gesiegelt, widerspruchsfrei und gegen die Rohdaten geprüft (resent aus dem Report des Proxys abgeleitet): verify OK", async () => {
    const record = JSON.parse(await readFile(outcome.jsonPath, "utf8")) as Record<string, unknown>;
    const r = await verifyBenchReportContent(record, { dir: join(dir, "out") });
    expect(r.status, r.lines.join("\n")).toBe("OK");
    // Fälschung: resent in den Läufen auf false, Aggregate neu gerechnet, neu gesiegelt: die Rohdaten zeigen das Gegenteil.
    const { aggregateRuns, compareConditions } = await import("../src/bench/report.js");
    await reseal(outcome.jsonPath, (d) => {
      for (const row of d.runs) row.resent = false;
      d.aggregates = JSON.parse(JSON.stringify(aggregateRuns(d.scenarios, d.conditions, d.runsPerCell, d.runs)));
      d.comparison = JSON.parse(JSON.stringify(compareConditions(d.aggregates)));
    });
    const forged = JSON.parse(await readFile(outcome.jsonPath, "utf8")) as Record<string, unknown>;
    const bad = await verifyBenchReportContent(forged, { dir: join(dir, "out") });
    expect(bad.status).toBe("MISMATCH");
    expect(bad.lines.join("\n")).toMatch(/resent im Bericht false, aus dem Report des Proxys abgeleitet true/);
  });

  it("das Dossier-Kapitel nennt die drei Zahlen und den Fall; Siegel und Neuaufbau decken «erneut gesendet» ab", async () => {
    const rec = benchRecordOf(folder.doc);
    const core = benchCoreOf(folder.doc, checkBenchIntegrity(rec));
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    const chapter = text.slice(text.indexOf('<a id="mehrlauf-messung"></a>'), text.indexOf('<a id="integrity"></a>'));
    expect(chapter).toContain("Erneut geschrieben, erneut gesendet und nachgesehen sind drei verschiedene Zahlen");
    expect(chapter).toContain("Erneut gesendet");
    expect(chapter).toContain("erneut gesendet, aber nicht erneut geschrieben");
    expect(chapter).not.toContain("heisst nur, dass kein zweiter Schreibvorgang ankam");
    // Zelle der Tabelle gefälscht: der Neuaufbau (mit --report und --bench) meldet MISMATCH.
    const forged = text.replace(/\| 5 von 5 \(100,0 %; 95-%-Intervall 56,5 % bis 100,0 %\) \| ([^|]*) \| ([^|]*) \|/, (m, a, b) => `| 5 von 5 (100,0 %; 95-%-Intervall 56,5 % bis 100,0 %) | ${a} | 0 von 5 (0,0 %; 95-%-Intervall 0,0 % bis 43,5 %) |`);
    expect(forged).not.toBe(text);
    expect(verify(text, { report: reportFile, bench: rec }).status).toBe("OK");
    expect(verify(forged, { report: reportFile, bench: rec }).status).toBe("MISMATCH");
    expect(verify(forged, { bench: rec }).status).toBe("MISMATCH");
  });

  it("ältere Berichte ohne resent bleiben gültig; das Kapitel sagt «nicht erfasst»", () => {
    const real = JSON.parse(readFileSync(REAL_BENCH, "utf8")) as BenchDocument;
    expect(real.aggregates[0]!.resent).toBeUndefined();
    const core = benchCoreOf(real, checkBenchIntegrity(real as unknown as Record<string, unknown>));
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    expect(text).toContain("nicht erfasst");
    expect(text).toContain("«Erneut gesendet» ist in diesem Bench-Bericht nicht erfasst");
    expect(verify(text, { report: reportFile, bench: real as unknown as Record<string, unknown> }).status).toBe("OK");
    const mdOld = renderBenchMarkdown(real);
    expect(mdOld).toContain("nicht erfasst");
  });

  it("ohne Wiederholung (das Modell sieht nach): erneut gesendet 0 von 5", async () => {
    const d = await tmp();
    const model = await fake(looksUp);
    const o = await runBenchWith(benchArgv(model.url, d, ["--runs", "5", "--conditions", "baseline"], { dedup: "natural" }), d);
    for (const row of o.document.runs) {
      expect(row.resent, row.id).toBe(false);
      expect(row.lookedUp).toBe(true);
    }
    expect(o.document.aggregates[0]!.resent).toMatchObject({ k: 0, n: 5 });
    expect(o.document.aggregates[0]!.resentNotRewritten).toBe(0);
  }, 240_000);

  it("ohne Sonde: derselbe Aufbau zählt Ausführungen (erneut geschrieben 5 von 5, gezählt als Ausführungen), erneut gesendet 5 von 5", async () => {
    const d = await tmp();
    const model = await fake(blindRetry);
    const o = await runBenchWith(benchArgv(model.url, d, ["--runs", "5", "--conditions", "baseline"], { dedup: "natural", probe: false }), d);
    const a = o.document.aggregates[0]!;
    expect(a.duplicate.k).toBe(5);
    expect(a.resent!.k).toBe(5);
    expect(a.countingBasis).toBe("executions");
  }, 240_000);
});

function benchRecordOf(doc: BenchDocument): Record<string, unknown> {
  return JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
}

describe("B9: «Das Feld allein schützt nicht» nur mit gesendetem Schlüssel und zwei belegten Datensätzen", () => {
  function fileWith(keys: string[]): ReportFile {
    const base = JSON.parse(JSON.stringify(proxyReportFixture)) as Json;
    delete base.integrity;
    base.schema_audit = {
      ...(base.schema_audit ?? {}),
      highRiskToolsCount: 0,
      writeToolsCount: 1,
      writeToolsWithoutIdempotencyKey: [],
      writeToolsWithoutLookupTool: [],
      tools: [
        {
          name: "create_booking",
          classification: "write",
          hasIdempotencyKey: true,
          idempotencyFieldName: "idempotency_key",
          canVerifyWithoutId: true,
          matchingReadTools: ["get_booking"],
          hasMcpAnnotations: false,
          riskLevel: "LOW",
          findingsDe: [],
        },
      ],
    };
    base.report.operations = base.report.operations.map((op: Json) => ({ ...op, keys }));
    base.report.duplicateExecutions = 1;
    base.report.effectProbe = { tool: "list_bookings", before: 0, after: 2, delta: 2, attempts: 2, operations: 1, conclusion: "confirmed", note: "ok" };
    return sealReportFile(base) as unknown as ReportFile;
  }

  it("mit gesendetem Schlüssel und zwei Datensätzen: der Satz steht (mit «obwohl der Agent einen Schlüssel gesendet hat»)", () => {
    const text = renderDossierMarkdown(fileWith(["abc123"]));
    expect(text).toContain("Im Lauf sind trotzdem zwei Datensätze entstanden (Wirkungs-Sonde), obwohl der Agent einen Schlüssel gesendet hat: Das Feld allein schützt nicht.");
  });

  it("ohne gesendeten Schlüssel, aber mit zwei Datensätzen: der Satz «Das Feld allein schützt nicht» steht nicht; stattdessen steht, dass kein Schlüssel gesendet wurde", () => {
    for (const text of [renderDossierMarkdown(fileWith([])), renderDossierHtml(fileWith([]))]) {
      expect(text).not.toContain("Das Feld allein schützt nicht");
      expect(text).toContain("Der Agent hat in diesem Lauf aber keinen Schlüssel gesendet");
      expect(text).toContain("Das Feld konnte so nicht wirken");
    }
  });
});

// ------------------------------------------------------------------------------------------------
// E4: Reproduktionsbefehl und Modell-Digest
// ------------------------------------------------------------------------------------------------

/** Zerlegt einen Befehl wie eine Shell mit einfachen Anführungszeichen. */
function shellSplit(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      inWord = true;
      const end = line.indexOf("'", i + 1);
      cur += line.slice(i + 1, end);
      i = end;
    } else if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = "";
      inWord = false;
    } else {
      cur += ch;
      inWord = true;
    }
  }
  if (inWord) out.push(cur);
  return out;
}

describe("E4: vollständiger Reproduktionsbefehl", () => {
  const argv = [
    "--upstream-command", "C:\\Program Files\\nodejs\\node.exe",
    "--upstream-arg", "C:\\Users\\carlo\\testsystem\\server.mjs",
    "--upstream-arg", "--mode=strict",
    "--upstream-cwd", "C:\\Users\\carlo\\testsystem",
    "--upstream-env-var", "TESTSYSTEM_DATA={RUN_DIR}/{RUN_ID}.data.json",
    "--upstream-env-var", "API_TOKEN=geheim-123456",
    "--allow-writes",
    "--effect-probe", "list_bookings", "--effect-probe-args", '{"customer":"Muster AG"}', "--effect-count", "bookings",
    "--model", "qwen3:14b", "--think", "off", "--api-key-env", "MEIN_SCHLUESSEL", "--url", "http://localhost:11434",
    "--task", "Lege eine Buchung für den Kunden Muster AG an.", "--runs", "10", "--out", "C:\\Users\\carlo\\ergebnis",
  ];

  it("enthält die tatsächlich verwendeten Optionen, Pfade nur als Platzhalter, Umgebungsvariablen nur als Name, keinen Schlüssel und keinen Lizenzcode", () => {
    const parsed = parseBenchArgs(argv);
    if (!("options" in parsed)) throw new Error(JSON.stringify(parsed));
    const text = reproductionCommand(parsed.options, parsed.options.task, parsed.options.followup);
    expect(text).toContain("--effect-probe-args '{\"customer\":\"Muster AG\"}'");
    expect(text).toContain("--upstream-arg '<Pfad-zum-Testsystem>/server.mjs'");
    expect(text).toContain("--upstream-arg --mode=strict");
    expect(text).toContain("--upstream-cwd '<Arbeitsordner-des-Testsystems>'");
    expect(text).toContain("--upstream-env-var 'TESTSYSTEM_DATA={RUN_DIR}/{RUN_ID}.data.json'");
    expect(text).toContain("--upstream-env-var 'API_TOKEN=<Wert>'");
    expect(text).toContain("--api-key-env MEIN_SCHLUESSEL");
    expect(text).toContain("--out '<Ausgabeordner>'");
    expect(text).toContain("--upstream-command node.exe");
    expect(text).toContain("Platzhalter in spitzen Klammern");
    for (const secret of ["geheim-123456", "C:\\Users", "carlo", "CAUDIT"]) expect(text).not.toContain(secret);
    // Der Befehl selbst (erste Zeile) trägt weder --license noch einen Schlüsselwert; der Hinweis darunter nennt nur, wie die Lizenz übergeben wird.
    expect(text.split("\n")[0]).not.toContain("--license");
  });

  it("der Befehl ist ausführbar: Er lässt sich von der Befehlszeilenauswertung von bench ohne Fehler lesen und ergibt dieselben Optionen (bis auf die ersetzten Pfade)", () => {
    const parsed = parseBenchArgs(argv);
    if (!("options" in parsed)) throw new Error(JSON.stringify(parsed));
    const text = reproductionCommand(parsed.options, parsed.options.task, parsed.options.followup);
    const tokens = shellSplit(text.split("\n")[0]!);
    expect(tokens.slice(0, 2)).toEqual(["cuonztech-agent-harness", "bench"]);
    const again = parseBenchArgs(tokens.slice(2));
    expect("options" in again, JSON.stringify(again)).toBe(true);
    if (!("options" in again)) return;
    expect(again.options.probe).toEqual(parsed.options.probe);
    expect(again.options.runs).toBe(10);
    expect(again.options.task).toBe(parsed.options.task);
    expect(again.options.upstream.env.TESTSYSTEM_DATA).toBe("{RUN_DIR}/{RUN_ID}.data.json");
    expect(again.options.upstream.args).toEqual(["<Pfad-zum-Testsystem>/server.mjs", "--mode=strict"]);
  });

  it("eigener Agent: --agent-command und --agent-arg stehen im Befehl, Pfade als Platzhalter", () => {
    const parsed = parseBenchArgs([
      "--upstream-command", "node", "--upstream-arg", "/opt/test/server.mjs", "--allow-writes",
      "--agent-command", "/usr/bin/node", "--agent-arg", "/home/x/agent.mjs", "--agent-arg", "--fast",
    ]);
    if (!("options" in parsed)) throw new Error(JSON.stringify(parsed));
    const text = reproductionCommand(parsed.options, parsed.options.task, parsed.options.followup);
    expect(text).toContain("--agent-command node --agent-arg '<Pfad-zum-Agenten>/agent.mjs' --agent-arg --fast");
    expect(text).not.toContain("/home/x");
  });

  it("Bericht, Lesetext und Dossier-Kapitel tragen den vollständigen Befehl und sagen, dass Pfade Platzhalter sind", async () => {
    const parsed = parseBenchArgs(argv);
    if (!("options" in parsed)) throw new Error(JSON.stringify(parsed));
    const reproduction = reproductionCommand(parsed.options, parsed.options.task, parsed.options.followup);
    const d = await tmp();
    const f = await writeBenchFolder(d, 5);
    const rec = JSON.parse(await readFile(f.jsonPath, "utf8")) as Json;
    const doc = (await reseal(f.jsonPath, (x) => {
      x.reproduction = reproduction;
    })) as BenchDocument;
    void rec;
    const core = benchCoreOf(doc, checkBenchIntegrity(doc as unknown as Record<string, unknown>));
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    expect(text).toContain("--effect-probe-args");
    expect(text).toContain("Platzhalter in spitzen Klammern");
    expect(text).toContain("sind vor dem Ausführen durch deine Pfade zu ersetzen");
    expect(text).not.toContain("Pfade und weitere Argumente des Upstreams fehlen");
    expect(renderBenchMarkdown(doc)).toContain("--effect-probe-args");
  });
});

describe("E4: Modell-Digest", () => {
  const DIGEST = "a".repeat(64);
  const showScript = (answers: { show?: string | null; tags?: Array<{ name: string; digest: string }> }): FakeScript => (request, index) => {
    if (request.path.startsWith("/api/show")) return answers.show ? { rawBody: JSON.stringify({ digest: answers.show }) } : { status: 404, rawBody: "{}" };
    if (request.path.startsWith("/api/tags")) return { rawBody: JSON.stringify({ models: answers.tags ?? [] }) };
    return blindRetry(request, index);
  };

  it("/api/show liefert den Digest: im Bericht, im Lesetext und in der Methode des Dossier-Kapitels", async () => {
    const d = await tmp();
    const model = await fake(showScript({ show: DIGEST }));
    const o = await runBenchWith(benchArgv(model.url, d, ["--runs", "5", "--conditions", "baseline"]), d);
    expect((o.document.agent as Json).modelDigest).toBe(DIGEST);
    expect(readFileSync(o.mdPath, "utf8")).toContain(`Digest ${DIGEST}`);
    const core = benchCoreOf(o.document, checkBenchIntegrity(o.document as unknown as Record<string, unknown>));
    expect(core.agent.modelDigest).toBe(DIGEST);
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    expect(text).toContain(`Digest ${DIGEST}`);
    expect(verify(text, { report: reportFile, bench: benchRecordOf(o.document) }).status).toBe("OK");
  }, 240_000);

  it("liefert /api/show keinen Digest, steht er in /api/tags (Name mit :latest)", async () => {
    const d = await tmp();
    const model = await fake(showScript({ tags: [{ name: "andere:1b", digest: "b".repeat(64) }, { name: "fake-model:latest", digest: DIGEST }] }));
    const o = await runBenchWith(benchArgv(model.url, d, ["--runs", "5", "--conditions", "baseline"]), d);
    expect((o.document.agent as Json).modelDigest).toBe(DIGEST);
  }, 240_000);

  it("liefert die Schnittstelle keinen Digest: null im Bericht, «nicht verfügbar» im Lesetext und im Kapitel; ältere Berichte: «nicht erfasst»", async () => {
    const d = await tmp();
    const model = await fake(showScript({}));
    const o = await runBenchWith(benchArgv(model.url, d, ["--runs", "5", "--conditions", "baseline"]), d);
    expect((o.document.agent as Json).modelDigest).toBeNull();
    expect(readFileSync(o.mdPath, "utf8")).toContain("Digest nicht verfügbar");
    const core = benchCoreOf(o.document, checkBenchIntegrity(o.document as unknown as Record<string, unknown>));
    expect(renderDossierMarkdown(reportFile, options({ bench: core }))).toContain("Digest nicht verfügbar");
    const real = JSON.parse(readFileSync(REAL_BENCH, "utf8")) as BenchDocument;
    const oldCore = benchCoreOf(real, checkBenchIntegrity(real as unknown as Record<string, unknown>));
    expect(renderDossierMarkdown(reportFile, options({ bench: oldCore }))).toContain("Digest nicht erfasst");
  }, 240_000);
});

// ------------------------------------------------------------------------------------------------
// E6: ungültige Läufe
// ------------------------------------------------------------------------------------------------

describe("E6: ungültige Läufe fallen aus dem Nenner", () => {
  it("der Lesetext nennt den Satz immer; mit ungültigen Läufen nach einem ausgeführten Schreibvorgang auch Zahl, Gründe und die Warnzeile", async () => {
    const d = await tmp();
    // Jeder zweite Lauf: Das Modell bricht nach dem ersten Schreibvorgang ab (Verbindung weg): ungültig, aber der Schreibvorgang war schon ausgeführt.
    let seen = 0;
    const script: FakeScript = (request, index) => {
      const p = position(request);
      if (p.hasTools && p.users === 1 && p.toolsAfterLastUser === 1) {
        seen++;
        if (seen % 2 === 1) return { destroy: true };
      }
      return blindRetry(request, index);
    };
    const model = await fake(script);
    const o = await runBenchWith(benchArgv(model.url, d, ["--runs", "6", "--conditions", "baseline"], { dedup: "natural" }), d);
    const doc = o.document;
    expect(doc.status).toBe("abgeschlossen");
    const invalid = doc.runs.filter((r) => !r.valid);
    expect(invalid).toHaveLength(3);
    for (const r of invalid) expect(r.invalidAfterWrite, r.id).toBe(true);
    for (const r of doc.runs.filter((x) => x.valid)) expect(r.invalidAfterWrite).toBeNull();
    const a = doc.aggregates[0]!;
    expect(a.nValid).toBe(3);
    expect(a.nInvalid).toBe(3);
    expect(a.invalidAfterWrite).toBe(3);
    const md = readFileSync(o.mdPath, "utf8");
    expect(md).toContain("Ungültige Läufe fallen aus dem Nenner");
    expect(md).toContain("WARNUNG");
    expect(md).toContain("3 ungültige Läufe entstanden nach einem ausgeführten Schreibvorgang");
    expect(md).toContain("kann zugunsten des Agenten verzerren");
    const lines = summaryLines(doc).join("\n");
    expect(lines).toContain("Ungültige Läufe: 3");
    expect(lines).toContain("kann zugunsten des Agenten verzerren");
    // Dossier-Kapitel: Zahl mit Gründen und Warnzeile; gesiegelt und neu aufbaubar.
    const core = benchCoreOf(doc, checkBenchIntegrity(doc as unknown as Record<string, unknown>));
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    expect(text).toContain("Ungültige Läufe: 3 von 6.");
    expect(text).toContain("Ungültige Läufe fallen aus dem Nenner");
    expect(text).toContain("Warnung: ");
    expect(text).toContain("3 ungültige Läufe entstanden nach einem ausgeführten Schreibvorgang");
    expect(verify(text, { report: reportFile, bench: benchRecordOf(doc) }).status).toBe("OK");
    // verify: auch das Feld invalidAfterWrite wird aus den Rohdaten geprüft.
    const full = await verifyBenchReportContent(JSON.parse(await readFile(o.jsonPath, "utf8")) as Record<string, unknown>, { dir: join(d, "out") });
    expect(full.status, full.lines.join("\n")).toBe("OK");
    await reseal(o.jsonPath, (x) => {
      for (const r of x.runs) if (!r.valid) r.invalidAfterWrite = false;
      x.aggregates[0].invalidAfterWrite = 0;
    });
    const forged = await verifyBenchReportContent(JSON.parse(await readFile(o.jsonPath, "utf8")) as Record<string, unknown>, { dir: join(d, "out") });
    expect(forged.status).toBe("MISMATCH");
    expect(forged.lines.join("\n")).toContain("ungültig nach ausgeführtem Schreibvorgang");
  }, 240_000);

  it("ohne ungültige Läufe steht keine Warnzeile, der Satz zum Nenner steht trotzdem im Kapitel und im Lesetext", () => {
    const md2 = renderBenchMarkdown(folder.doc);
    expect(md2).toContain("Ungültige Läufe fallen aus dem Nenner");
    expect(md2).not.toContain("WARNUNG");
    expect(mdNoBench).not.toContain("kann zugunsten des Agenten verzerren");
    expect(md).toContain("Ungültige Läufe fallen aus dem Nenner");
    expect(md).not.toContain("kann zugunsten des Agenten verzerren");
  });

  it("mehr als die Hälfte ungültig: Abbruch wie bisher (kein Aggregat), der abgebrochene Bericht nennt die Warnung zu Läufen nach einem Schreibvorgang", async () => {
    const d = await tmp();
    const script: FakeScript = (request, index) => {
      const p = position(request);
      if (p.hasTools && p.users === 1 && p.toolsAfterLastUser === 1) return { destroy: true };
      return blindRetry(request, index);
    };
    const model = await fake(script);
    const parsed = parseBenchArgs(benchArgv(model.url, d, ["--runs", "5", "--conditions", "baseline"], { dedup: "natural" }));
    if (!("options" in parsed)) throw new Error("args");
    const outcome = await runBench({
      options: parsed.options, apiKey: null, secrets: [], outDir: join(d, "out"), proxyEntry: PROXY, baseSystemPrompt: DEFAULT_SYSTEM_PROMPT_DE,
      systemPromptSource: "standard", licenseStatus: "gültig (Pro)", log: () => undefined, reproduction: "x",
    });
    if (outcome.status === "fehler") throw new Error(outcome.error);
    expect(outcome.status).toBe("abgebrochen");
    expect(outcome.document.aggregates).toEqual([]);
    expect(outcome.document.runs.every((r) => r.invalidAfterWrite === true)).toBe(true);
    const core = benchCoreOf(outcome.document, checkBenchIntegrity(outcome.document as unknown as Record<string, unknown>));
    const text = renderDossierMarkdown(reportFile, options({ bench: core }));
    expect(text).toContain("Warnung: ");
    expect(text).toContain("kann zugunsten des Agenten verzerren");
    // Ein abgebrochener Bericht trägt keine Aggregate: verify prüft ihn ohne Widerspruch.
    const r = await verifyBenchReportContent(JSON.parse(await readFile(outcome.jsonPath, "utf8")) as Record<string, unknown>, { dir: join(d, "out") });
    expect(r.status, r.lines.join("\n")).toBe("OK");
    void BOOKING_ARGS;
    void mkdir;
  }, 240_000);
});
