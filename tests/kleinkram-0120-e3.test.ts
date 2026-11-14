// 0.12.0, Stufe E3f (Pro-Gate, Befund C): Kleinkram. Jeder Punkt wurde zuerst nachgestellt (der Test schlug vor der Änderung fehl).
//  C1 «Oder oder» in der Meldung der Wirkungs-Sonde
//  C2 «Fatal: Error: ENOTDIR» bei einem Pfad unter einer Datei und eine Berichtsdatei, die ein Ordner ist
//  C3 HTML-Entitäten im Markdown-Dossier
//  C4 die alte Adresse cuonztech.ch/agent-audit
//  C6 Nebenfelder im Lauf: records bei unbrauchbarer Sonde, Vokabular im Protokoll
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderDossierMarkdown } from "../src/dossier-report.js";
import { fileInPathAbove, describeFsError } from "../src/fs-errors.js";
import { verifyLicense } from "../src/license/index.js";
import { deriveRunFacts } from "../src/bench/run-facts.js";
import { renderBenchMarkdown, type BenchDocument } from "../src/bench/report.js";
import type { ReportFile } from "../src/plain-report.js";
import { proProcessEnv, freeProcessEnv } from "./helpers/license-env.js";

const PROXY = resolve("dist/index.js");
const REAL_REPORT = resolve("tests/fixtures/bench-proxy-report-real.json");

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kleinkram-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}
function cli(args: string[], env: Record<string, string> = proProcessEnv()): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [PROXY, ...args], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("close", (code) => done({ code, out, err }));
  });
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("C1: keine doppelten Wörter in Meldungen", () => {
  it("die Meldung zu einem ungültigen --effect-probe-args sagt nicht «Oder oder»", () => {
    const src = readFileSync("src/bench/run.ts", "utf8");
    // Der Ausgang der Meldung: «Beispiel: …, oder starte ohne --effect-probe (…)».
    expect(src).not.toMatch(/Oder \$\{PROBE_OR_WITHOUT_DE\}/);
    expect(src).toMatch(/Muster AG"\}', \$\{PROBE_OR_WITHOUT_DE\}/);
  });

  it("im Quelltext steht kein «oder oder», «und und», «Oder oder» in einem Text", () => {
    const hits: string[] = [];
    for (const file of sourceFiles("src")) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/\b(oder|und|der|die|das|nicht\s+nicht(?!\\))\s+\1\b/i.test(line.replace(/nicht\\s\+nicht/g, ""))) {
            // «nicht nicht» ist in den Mustern des Ehrlichkeits-Checks Absicht (Doppelverneinung)
            if (!/nicht\s+nicht/i.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 100)}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });
});

describe("C2: «Fatal: ENOTDIR» wird zu einer verständlichen Meldung mit Exit 1", () => {
  it("describeFsError: ENOTDIR, EISDIR, ENOENT, EACCES in Deutsch und Englisch, unbekannte Fehler bleiben unberührt", () => {
    const err = (code: string, path: string): Error => Object.assign(new Error(`${code}: x, mkdir '${path}'`), { code, path });
    expect(describeFsError(err("ENOTDIR", "/a/file/sub"), "en")).toContain("A part of the path is a file, not a folder");
    expect(describeFsError(err("ENOTDIR", "/a/file/sub"), "de")).toContain("Ein Teil des Pfads ist eine Datei, kein Ordner");
    expect(describeFsError(err("EISDIR", "/a"), "en")).toContain("is a folder, not a file");
    expect(describeFsError(err("ENOENT", "/a"), "de")).toContain("gibt es nicht");
    expect(describeFsError(err("EACCES", "/a"), "en")).toContain("No permission");
    expect(describeFsError(new Error("anderes"), "en")).toBeNull();
    expect(describeFsError(null, "en")).toBeNull();
    expect(describeFsError(err("ENOTDIR", "/a\nb"), "en")).not.toContain("\n");
  });

  it("fileInPathAbove findet die Datei, unter der ein Pfad liegen soll", async () => {
    const dir = await tmp();
    const file = join(dir, "afile.txt");
    await writeFile(file, "x");
    expect(fileInPathAbove(join(file, "sub", "deeper"))).toBe(file);
    expect(fileInPathAbove(join(dir, "neu", "ordner"))).toBeNull();
    expect(fileInPathAbove(dir)).toBeNull();
    expect(fileInPathAbove(file)).toBeNull();
  });

  it("bench --out <Datei>/<Ordner>: Meldung und Exit 1, bevor das Modell angesprochen wird, nichts geschrieben", async () => {
    const dir = await tmp();
    const file = join(dir, "afile.txt");
    await writeFile(file, "x");
    const r = await cli([
      "bench",
      "--upstream-command", process.execPath,
      "--upstream-arg", resolve("examples/testsystem/server.mjs"),
      "--allow-writes",
      "--model", "kein-modell",
      "--url", "http://127.0.0.1:9",
      "--out", join(file, "ergebnis"),
    ]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("liegt unter einer Datei");
    expect(r.err).toContain("Es wurde nichts geschrieben.");
    expect(r.err).not.toContain("Fatal");
    expect(r.err).not.toContain("ENOTDIR");
    expect((await readdir(dir)).sort()).toEqual(["afile.txt"]);
  }, 60_000);

  it("report <Ordner>: «ist ein Ordner», nicht «nicht gefunden», Exit 1", async () => {
    const dir = await tmp();
    const r = await cli(["report", dir]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("is a folder, not a report file");
    expect(r.err).not.toContain("not found");
    expect(r.err).not.toContain("Fatal");
  });

  it("report --out unter einer Datei: «a part of the path is a file», Exit 1", async () => {
    const dir = await tmp();
    const file = join(dir, "afile.txt");
    await writeFile(file, "x");
    const r = await cli(["report", REAL_REPORT, "--out", join(file, "bericht.md")]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/cannot write .*bericht\.md: (the folder does not exist|a part of the path is a file, not a folder)/);
    expect(r.err).not.toContain("Fatal");
  });

  it("verify <Ordner>: «ist ein Ordner», Exit 1", async () => {
    const dir = await tmp();
    const r = await cli(["verify", dir], freeProcessEnv());
    expect(r.code).toBe(1);
    expect(r.out + r.err).toContain("ist ein Ordner, keine Datei");
  });

  it("der Rest-Fall: ein Fehler mit ENOTDIR, der durchschlägt, erscheint als «Error: …» statt «Fatal: Error: …»", () => {
    const src = readFileSync("src/index.ts", "utf8");
    expect(src).toContain('describeFsError(err, "en")');
    expect(src).toContain("`Error: ${friendly}\\n`");
  });
});

describe("C3: keine HTML-Entitäten im Markdown-Dossier", () => {
  const report = JSON.parse(readFileSync(REAL_REPORT, "utf8")) as ReportFile;
  const EVIL = "create_<img src=x onerror=alert(1)> & Tom \"Jerry\" <b>x</b>";

  it("ein Tool-Name mit spitzen Klammern und & steht mit Backslash maskiert im Markdown, ohne «&lt;», «&gt;» und «&amp;» aus HTML-Escaping", () => {
    const forged = JSON.parse(JSON.stringify(report)) as ReportFile;
    const ops = forged.report!.operations;
    ops[0]!.tool = EVIL;
    if (forged.call_forensics) for (const e of forged.call_forensics.entries) e.toolName = EVIL;
    const md = renderDossierMarkdown(forged, { limited: false, customerName: EVIL, systemName: EVIL });
    expect(md).toContain("create_\\<img src=x onerror=alert(1)\\>");
    // Nichts wird roh als HTML-Tag stehen gelassen
    expect(md).not.toMatch(/(?<!\\)<img/);
    expect(md).not.toMatch(/(?<!\\)<b>/);
    // Und keine HTML-Entität aus dem Escaping (ein «&» im Namen bleibt wörtlich, maskiert)
    const withoutSeal = md.replace(/<!--[\s\S]*?-->/g, "").replace(/<a id="[^"]*"><\/a>/g, "");
    expect(withoutSeal).not.toMatch(/(?<!\\)&(lt|gt|amp|quot|#39);/);
    // Ein «&» ohne Entität bleibt, wie es ist; eines, das eine Entität beginnen würde, wird maskiert (siehe der nächste Test).
    expect(withoutSeal).toContain("& Tom");
  });

  it("ein Text, der selbst «&lt;» enthält, bleibt wörtlich lesbar (maskiertes &), nicht doppelt escaped", () => {
    const forged = JSON.parse(JSON.stringify(report)) as ReportFile;
    const amp = String.fromCharCode(38);
    forged.report!.operations[0]!.tool = `t${amp}lt;x`;
    const md = renderDossierMarkdown(forged, { limited: false });
    // In einem Code-Span steht der Text unverändert, sonst mit maskiertem «&»; nie als doppelt escapedes «&amp;lt;».
    expect(md).toMatch(/t\\?&lt;x/);
    expect(md).not.toContain(`${amp}amp;lt;`);
  });
});

describe("C3: bench-report.md ohne HTML-Entitäten", () => {
  it("Modell, Aufgabe und Szenario mit «<» und «&» erscheinen unverändert, nie als «&lt;» oder «&amp;»", () => {
    const doc = JSON.parse(readFileSync("tests/fixtures/bench-report-real.json", "utf8")) as BenchDocument;
    doc.agent.model = "qwen & <co>";
    doc.task = "Buche A & B <jetzt>";
    const md = renderBenchMarkdown(doc);
    expect(md).toContain("qwen & <co>");
    expect(md).toContain("Buche A & B <jetzt>");
    expect(md).not.toMatch(/&(lt|gt|amp|quot|#39);/);
  });
});

describe("C4: die alte Adresse cuonztech.ch/agent-audit steht in keinem Text des Pakets", () => {
  it("weder im Quelltext (ausser der Weiche für alte Berichte) noch in der README", () => {
    const hits: string[] = [];
    for (const file of [...sourceFiles("src"), "README.md"]) {
      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (/cuonztech\.ch\/agent-audit(?!-)/.test(line) && !/LEGACY_URL\s*=/.test(line)) hits.push(`${file}:${i + 1}`);
        });
    }
    expect(hits).toEqual([]);
  });

  it("die Gründe des Verifizierers nennen die aktuelle Adresse", () => {
    const none = verifyLicense("");
    const bad = verifyLicense("CAUDIT-kaputt");
    for (const v of [none, bad]) expect(v.reason ?? "").not.toContain("agent-audit");
    expect(none.reason ?? "").toBeDefined();
    const src = readFileSync("src/license/verifier.ts", "utf8");
    expect(src).toContain("https://cuonztech.ch/agent-harness.html");
  });

  it("die Weiche für alte Berichte bleibt: eine Meldung mit der alten oder der neuen Adresse wird gleich gekürzt", async () => {
    const { reasonSentence } = await import("../src/license/index.js");
    for (const url of ["https://cuonztech.ch/agent-audit", "https://cuonztech.ch/agent-harness.html"]) {
      const text = reasonSentence({ valid: false, reason: `Lizenz ist am 2026-01-01 abgelaufen. Verlängerung unter ${url}` });
      expect(text).toContain("abgelaufen");
      expect(text).not.toContain("cuonztech.ch");
    }
  });

  it("package.json und server.json nennen die alte Adresse nicht", () => {
    for (const f of ["package.json", "server.json"]) expect(readFileSync(f, "utf8")).not.toContain("agent-audit");
  });
});

describe("C6: Nebenfelder je Lauf", () => {
  const report = JSON.parse(readFileSync(REAL_REPORT, "utf8")) as ReportFile;

  it("records ist null, wenn die Sonde im Lauf nicht verwertbar war (statt einer irreführenden 0)", () => {
    const forged = JSON.parse(JSON.stringify(report)) as ReportFile;
    const rep = forged.report!;
    rep.effectProbe = { ...rep.effectProbe!, conclusion: "inconclusive", before: 0, after: 0, delta: 0 };
    const facts = deriveRunFacts(forged as never, rep, true);
    expect(facts.truthBasis).toBe("executions");
    expect(facts.records).toBeNull();
    expect(facts.probeConclusion).toBe("inconclusive");
    expect(facts.probeReason).not.toBeNull();
  });

  it("records bleibt der Zählwert, wenn die Sonde verwertbar war", () => {
    const forged = JSON.parse(JSON.stringify(report)) as ReportFile;
    const rep = forged.report!;
    rep.effectProbe = { ...rep.effectProbe!, conclusion: "confirmed", before: 1, after: 3, delta: 2 };
    const facts = deriveRunFacts(forged as never, rep, true);
    expect(facts.truthBasis).toBe("records");
    expect(facts.records).toBe(2);
  });

  it("das Protokoll je Lauf spricht wie die Tabellen («erneut geschrieben (Duplikat)»), nicht «Doppelausführung»", () => {
    const src = readFileSync("src/bench/run.ts", "utf8");
    expect(src).toContain('"erneut geschrieben (Duplikat)" : "nicht erneut geschrieben"');
    expect(src).not.toContain('? "Doppelausführung" : "keine Doppelausführung"');
  });

  it("die README erklärt, was «executions» und «records» je Lauf heissen", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("`executions` je Lauf ist nicht die Zahl der Schreibaufrufe am Upstream");
    expect(readme).toContain("`records` ist null");
  });
});

