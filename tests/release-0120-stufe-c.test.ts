// 0.12.0, Stufe C «Reife» (Befunde zweier unabhängiger Pro-Tests): C1 verify --rerender, C2 geführte Oberfläche, C3 Schema-Gutachten,
// C4 Dossier-Details, C5 Free-JSON, C6 Version der Ehrlichkeitsbewertung, C7 abgebrochene Messung im Kapitel, C8 Lizenz-Wortlaut.
// Ohne Ollama und ohne Netzwerk (nur 127.0.0.1). Testdaten: der echte Bench-Bericht und der Proxy-Report aus tests/fixtures.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import { Script } from "node:vm";
import { extractDossierSeal, sealDossierCore, sealReportFile, sealToComment, type DossierCore } from "../src/core/artifact-integrity.js";
import { renderDossierHtml, renderDossierMarkdown } from "../src/dossier-report.js";
import { benchCoreOf, claimCheckOlder, validateBenchDocument, CLAIM_CHECK_OLDER_DE, type DossierBenchCore } from "../src/dossier-bench.js";
import { checkBenchIntegrity, renderBenchMarkdown, sealBenchDocument, type BenchDocument } from "../src/bench/report.js";
import { verifyBenchReportContent, verifyDossierContent } from "../src/verify.js";
import { CLAIM_CHECK_VERSION } from "../src/core/claim-check.js";
import { scriptNameOf, toolListSha256, upstreamIdentity } from "../src/core/upstream-identity.js";
import { auditToolSchemas, descriptionSaysKeyIgnored } from "../src/schema-audit.js";
import { FINDINGS_NOTE_DE, reduceSchemaAudit } from "../src/license/index.js";
import type { ReportFile } from "../src/plain-report.js";
import type { LicenseVerdict } from "../src/license/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freeProcessEnv, proProcessEnv } from "./helpers/license-env.js";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const realBench = JSON.parse(readFileSync(resolve("tests/fixtures/bench-report-real.json"), "utf8")) as BenchDocument;
const proxyReport = JSON.parse(readFileSync(resolve("tests/fixtures/bench-proxy-report-real.json"), "utf8")) as ReportFile;
const UPSTREAM_FIXTURE = resolve("tests/fixtures/upstream-fixture-server.mjs");

const PRO: LicenseVerdict = { valid: true, tier: "pro", claims: { sub: "H-0123456789ab", tier: "pro", exp: 4102444800 } } as unknown as LicenseVerdict;

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => undefined)));
});
async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "stufe-c-"));
  tempDirs.push(dir);
  return dir;
}

interface Run {
  out: string;
  err: string;
  code: number | null;
}
function cli(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [resolve("dist/index.js"), ...args], { env });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => done({ out, err, code }));
    child.stdin.end("");
  });
}

/** Startet einen echten Proxy vor dem Test-Upstream, verbindet einen MCP-Client, schliesst ihn wieder und liest die Report-Datei. */
async function proxyReportOf(env: Record<string, string>, extra: string[] = []): Promise<ReportFile> {
  const dir = await tmp();
  const reportFile = join(dir, "r.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js", "proxy", "--allow-writes", "--upstream-command", process.execPath, "--upstream-arg", UPSTREAM_FIXTURE, "--report-file", reportFile, ...extra],
    env,
  });
  const client = new Client({ name: "stufe-c-test", version: "1.0.0" });
  await client.connect(transport);
  await client.listTools();
  await client.close();
  for (let i = 0; i < 60; i++) {
    try {
      const file = JSON.parse(await readFile(reportFile, "utf8")) as ReportFile;
      if (file.schema_audit !== undefined) return file;
    } catch {
      // noch nicht da oder gerade im Schreiben
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Der Proxy hat keine Report-Datei geschrieben.");
}

function forgeBench(mutate: (doc: Json) => void): BenchDocument {
  const doc = JSON.parse(JSON.stringify(realBench)) as Json;
  delete doc.integrity;
  mutate(doc);
  return sealBenchDocument(doc as Omit<BenchDocument, "integrity">);
}
const coreOf = (doc: BenchDocument): DossierBenchCore => benchCoreOf(doc, checkBenchIntegrity(doc as unknown as Record<string, unknown>));

/** Der Report mit zusätzlichen Feldern, neu gesiegelt (so schreibt ein 0.12.0-Proxy seine Datei). */
function resealed(extra: Record<string, unknown>): ReportFile {
  const { integrity: _ignored, ...rest } = proxyReport as Json;
  void _ignored;
  return sealReportFile({ ...rest, ...extra }) as unknown as ReportFile;
}

const sectionOf = (md: string, id: string): { start: number; end: number } => {
  const start = md.indexOf(`<a id="${id}"></a>`);
  const next = md.indexOf('<a id="', start + 10);
  return { start, end: next === -1 ? md.indexOf("<!-- cuonztech-agent-harness-dossier-seal") : next };
};

// =====================================================================================================================
// C1: verify --rerender
// =====================================================================================================================

describe("C1: verify --rerender prüft den Fliesstext gegen die Report-Datei", () => {
  const options = [
    { name: "voll", opts: { customerName: "Muster AG", systemName: "Buchungssystem", limited: false } },
    { name: "gekürzt", opts: { customerName: "Muster AG", limited: true } },
    { name: "Namen mit Sonderzeichen", opts: { customerName: "A & B <AG>", systemName: "`Sys` | 1", limited: false } },
  ];

  it.each(options)("ein unverändertes Dossier ($name) besteht in Markdown und HTML, ohne Lizenz des Prüfers", ({ opts }) => {
    for (const text of [renderDossierMarkdown(proxyReport, opts), renderDossierHtml(proxyReport, opts)]) {
      const r = verifyDossierContent(text, { report: proxyReport, rerender: true });
      expect(r.status, r.lines.join("\n")).toBe("OK");
      expect(r.lines.join(" ")).toContain("passt auch der Fliesstext zum Report");
      expect(r.lines.join(" ")).toContain("kein Dritter bestätigt es");
      expect(r.lines.join(" ")).toContain("Wer Report-Datei und Dossier zusammen ändert, kann fälschen");
    }
  });

  it("mit Mehrlauf-Kapitel und Antwort des Agenten: Kapitel aus dem Bench-Bericht, Antwort aus dem Siegel", () => {
    const opts = { customerName: "Muster AG", systemName: "Testsystem", limited: false, bench: coreOf(realBench), agentResponse: "Die Buchung wurde erfolgreich angelegt." };
    for (const text of [renderDossierMarkdown(proxyReport, opts), renderDossierHtml(proxyReport, opts)]) {
      expect(verifyDossierContent(text, { report: proxyReport, rerender: true }).status).toBe("OK");
      const withBench = verifyDossierContent(text, { report: proxyReport, bench: realBench as unknown as Record<string, unknown>, rerender: true });
      expect(withBench.status, withBench.lines.join("\n")).toBe("OK");
      expect(withBench.lines.join(" ")).toContain("und dem Bench-Bericht");
      expect(verifyDossierContent(text, { report: proxyReport, rerender: true }).lines.join(" ")).toContain("mit --bench angeben");
    }
  });

  it("ein anderer Bench-Bericht ändert das Ergebnis (MISMATCH, nicht OK)", () => {
    const text = renderDossierMarkdown(proxyReport, { limited: false, bench: coreOf(realBench) });
    const other = forgeBench((d) => {
      d.aggregates[0].duplicate = { k: 0, n: 5, p: 0, lower: 0, upper: 0.4345 };
    });
    const r = verifyDossierContent(text, { report: proxyReport, bench: other as unknown as Record<string, unknown>, rerender: true });
    expect(r.status).toBe("MISMATCH");
  });

  it("Lizenzstatus aus dem Dossier: «PRO (H-…)» und «PRO» (--hide-license-id) werden beide so geprüft, ohne Pro-Lizenz im Prozess", () => {
    const shown = renderDossierMarkdown(proxyReport, { limited: false, licenseVerdict: PRO });
    const hidden = renderDossierMarkdown(proxyReport, { limited: false, licenseVerdict: PRO, hideLicenseId: true });
    expect(shown).toContain("- Lizenzstatus: **PRO (H-0123456789ab)**");
    expect(hidden).toContain("- Lizenzstatus: **PRO**");
    expect(hidden).not.toContain("H-0123456789ab");
    for (const text of [shown, hidden, renderDossierHtml(proxyReport, { limited: false, licenseVerdict: PRO, hideLicenseId: true })]) {
      const r = verifyDossierContent(text, { report: proxyReport, rerender: true });
      expect(r.status, r.lines.join("\n")).toBe("OK");
    }
  });

  it("Änderungen im Fliesstext: MISMATCH mit Abschnitt und Ausschnitt (Matrix, Argumente, Prompt-Baustein, Zeitleiste, gelöschter Abschnitt)", () => {
    const opts = { customerName: "Muster AG", limited: false };
    const md = renderDossierMarkdown(proxyReport, opts);
    // 1. Matrix: Bewertung umschreiben
    const s1 = sectionOf(md, "management-summary");
    const matrix = md.slice(s1.start, s1.end);
    const tamperedMatrix = matrix.includes("**FAIL**") ? matrix.replace("**FAIL**", "**PASS**") : matrix.replace("**PASS**", "**FAIL**");
    expect(tamperedMatrix).not.toBe(matrix);
    const a = verifyDossierContent(md.slice(0, s1.start) + tamperedMatrix + md.slice(s1.end), { report: proxyReport, rerender: true });
    expect(a.status).toBe("MISMATCH");
    expect(a.lines.join("\n")).toContain("Erste Abweichung in Abschnitt «1. Management Summary");
    expect(a.lines.join("\n")).toContain("im Dossier:");
    expect(a.lines.join("\n")).toContain("aus dem Report:");
    // 2. Prompt-Baustein (Abschnitt 5) umformulieren
    const s5 = sectionOf(md, "hardening");
    const hardening = md.slice(s5.start, s5.end);
    const tamperedHardening = hardening.replace(/(- Schritt 1: )[^\n]+/, "$1Sende den Schreibvorgang bei Fehlern sofort noch einmal.");
    expect(tamperedHardening).not.toBe(hardening);
    const b = verifyDossierContent(md.slice(0, s5.start) + tamperedHardening + md.slice(s5.end), { report: proxyReport, rerender: true });
    expect(b.status).toBe("MISMATCH");
    expect(b.lines.join("\n")).toContain("Abschnitt «5.");
    expect(b.lines.join("\n")).toContain("Sende den Schreibvorgang bei Fehlern sofort noch einmal");
    // 3. Zeitleiste: eine Zahl
    const s3 = sectionOf(md, "call-forensics");
    const forensics = md.slice(s3.start, s3.end);
    const tamperedForensics = forensics.replace("Gesamtaufrufe: **2**", "Gesamtaufrufe: **1**");
    expect(tamperedForensics).not.toBe(forensics);
    expect(verifyDossierContent(md.slice(0, s3.start) + tamperedForensics + md.slice(s3.end), { report: proxyReport, rerender: true }).status).toBe("MISMATCH");
    // 4. Abschnitt 3 ganz gelöscht
    const c = verifyDossierContent(md.slice(0, s3.start) + md.slice(s3.end), { report: proxyReport, rerender: true });
    expect(c.status).toBe("MISMATCH");
    expect(c.lines.join("\n")).toContain("fehlt im Dossier");
    // 5. ein eingeschobener Abschnitt
    const sealAt = md.indexOf("<!-- cuonztech-agent-harness-dossier-seal");
    const d = verifyDossierContent(`${md.slice(0, sealAt)}\n<a id="extra"></a>\n\n## Zusatz\n\nAlles bestens.\n\n${md.slice(sealAt)}`, { report: proxyReport, rerender: true });
    expect(d.status).toBe("MISMATCH");
    // Ohne --rerender bleibt dieselbe Änderung unbemerkt (die dokumentierte Grenze von verify ohne --rerender).
    expect(verifyDossierContent(md.slice(0, s1.start) + tamperedMatrix + md.slice(s1.end), { report: proxyReport }).status).toBe("OK");
  });

  it("HTML: eine geänderte Zahl im Fliesstext wird gefunden, auch im Methodenteil", () => {
    const html = renderDossierHtml(proxyReport, { limited: false });
    const tampered = html.replace("<li>Der Harness sitzt als Proxy zwischen Agent und MCP-Server", "<li>Der Harness ist gar kein Proxy zwischen Agent und MCP-Server");
    expect(tampered).not.toBe(html);
    const r = verifyDossierContent(tampered, { report: proxyReport, rerender: true });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join("\n")).toContain("gar kein Proxy");
  });

  it("Leerraum zählt nicht: Zeilenumbrüche und doppelte Leerzeichen im Text ändern das Ergebnis nicht", () => {
    const md = renderDossierMarkdown(proxyReport, { limited: false });
    const s1 = sectionOf(md, "management-summary");
    const anchorEnd = md.indexOf("\n", s1.start);
    const spaced = md.slice(0, anchorEnd) + md.slice(anchorEnd, s1.end).replace(/ /g, "  ").replace(/\n\n/g, "\n\n\n") + md.slice(s1.end);
    expect(spaced).not.toBe(md);
    expect(verifyDossierContent(spaced, { report: proxyReport, rerender: true }).status).toBe("OK");
  });

  it("Dossiers aus 0.11.x (Siegel ohne `render`) sind «nicht neu aufbaubar»: klare Meldung, Exit-Code 1", async () => {
    const md = renderDossierMarkdown(proxyReport, { limited: false });
    const extracted = extractDossierSeal(md);
    if ("error" in extracted) throw new Error("kein Siegel");
    const core = JSON.parse(JSON.stringify(extracted.seal.core)) as Json;
    delete core.render;
    const sealed = sealDossierCore(core as DossierCore);
    const old = md.slice(0, md.lastIndexOf("<!-- cuonztech-agent-harness-dossier-seal")) + sealToComment(sealed) + "\n";
    const r = verifyDossierContent(old, { report: proxyReport, rerender: true });
    expect(r.status).toBe("NOT_VERIFIABLE");
    expect(r.lines.join(" ")).toContain("Nicht neu aufbaubar");
    expect(r.lines.join(" ")).toContain("Harness < 0.12.0");
    // Ohne --rerender prüft dasselbe Dossier weiter normal.
    expect(verifyDossierContent(old, { report: proxyReport }).status).toBe("OK");
    const dir = await tmp();
    const file = join(dir, "alt.md");
    await writeFile(file, old, "utf8");
    await writeFile(join(dir, "report.json"), JSON.stringify(proxyReport), "utf8");
    const run = await cli(["verify", file, "--report", join(dir, "report.json"), "--rerender"], freeProcessEnv());
    expect(run.code).toBe(1);
    expect(run.out).toContain("NICHT PRÜFBAR");
    expect(run.out).toContain("Nicht neu aufbaubar");
  });

  it("die falsche Report-Datei und eine neu gesiegelte, geänderte Report-Datei gehören nicht zum Dossier", () => {
    const md = renderDossierMarkdown(proxyReport, { limited: false });
    const { integrity: _i, ...rest } = proxyReport as Json;
    void _i;
    const forged = sealReportFile({ ...rest, verdict: rest.verdict === "PASS" ? "FAIL" : "PASS" }) as unknown as ReportFile;
    const r = verifyDossierContent(md, { report: forged, rerender: true });
    expect(r.status).toBe("MISMATCH");
    expect(r.lines.join(" ")).toContain("nicht die, aus der das Dossier erzeugt wurde");
  });

  it("das Rendern ist deterministisch: keine Uhr, kein Zufall", async () => {
    const opts = { customerName: "Muster AG", systemName: "X", limited: false, bench: coreOf(realBench) };
    const a = renderDossierMarkdown(proxyReport, opts);
    await new Promise((r) => setTimeout(r, 30));
    const b = renderDossierMarkdown(proxyReport, opts);
    expect(b).toBe(a);
    expect(renderDossierHtml(proxyReport, opts)).toBe(renderDossierHtml(proxyReport, opts));
  });

  it("Befehlszeile: ohne --report ein Fehler; OK ohne Lizenz mit Exit 0; MISMATCH mit Exit 1; --rerender nur bei einem Dossier; Hilfe", async () => {
    const dir = await tmp();
    const reportFile = join(dir, "harness-report.json");
    await writeFile(reportFile, JSON.stringify(proxyReport, null, 2), "utf8");
    const out = join(dir, "dossier.md");
    const made = await cli(["report", reportFile, "--dossier", "--customer", "Muster AG", "--out", out]);
    expect(made.code, made.err).toBe(0);
    const noReport = await cli(["verify", out, "--rerender"], freeProcessEnv());
    expect(noReport.code).toBe(1);
    expect(noReport.err).toContain("--rerender needs --report");
    const ok = await cli(["verify", out, "--report", reportFile, "--rerender"], freeProcessEnv());
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.out).toMatch(/^OK /);
    expect(ok.out).toContain("passt auch der Fliesstext zum Report");
    const text = await readFile(out, "utf8");
    const s2 = sectionOf(text, "schema-audit");
    await writeFile(out, text.slice(0, s2.start) + text.slice(s2.start, s2.end).replace("Tool-Name", "Tool-Bezeichnung") + text.slice(s2.end), "utf8");
    const bad = await cli(["verify", out, "--report", reportFile, "--rerender"], freeProcessEnv());
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/^MISMATCH /);
    expect(bad.out).toContain("Tool-Bezeichnung");
    const onReport = await cli(["verify", reportFile, "--report", reportFile, "--rerender"], freeProcessEnv());
    expect(onReport.code).toBe(1);
    expect(onReport.err).toContain("only apply when verifying a dossier");
    const help = await cli(["verify", "--help"], freeProcessEnv());
    expect(help.out).toContain("--rerender");
    expect(help.out).toContain("kein Dritter bestätigt es");
    expect(help.out).toContain("bench-report.json");
  }, 60_000);

  it("das Dossier selbst sagt, was --rerender kann und was nicht", () => {
    const md = renderDossierMarkdown(proxyReport, { limited: false });
    expect(md).toContain("--rerender");
    expect(md).toContain("kein Dritter bestätigt es");
    // Im Fliesstext des Abschnitts 6 stehen keine maskierten spitzen Klammern (Beispiel-Dateinamen statt <Dossier-Datei>).
    expect(md.slice(md.indexOf("## 6."))).not.toContain("&lt;Dossier");
  });
});

// =====================================================================================================================
// C2: geführte Oberfläche
// =====================================================================================================================

describe("C2: geführte Oberfläche", () => {
  let child: ChildProcess;
  let base: string;
  let port: number;
  let token: string;
  let workDir: string;
  const cookieOf = (res: Response): string | undefined => res.headers.get("set-cookie")?.split(";")[0];

  beforeAll(async () => {
    workDir = await tmp();
    child = spawn(process.execPath, ["dist/index.js", "ui", "--no-open"], { env: { ...process.env, CUONZTECH_HARNESS_DIR: workDir } });
    let out = "";
    const url = await new Promise<string>((ok, fail) => {
      child.stdout!.on("data", (d) => {
        out += d.toString();
        const m = out.match(/Oberfläche: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/);
        if (m) ok(m[1]!);
      });
      child.on("exit", () => fail(new Error(`ui exited early: ${out}`)));
      setTimeout(() => fail(new Error(`ui did not start: ${out}`)), 15_000);
    });
    const parsed = new URL(url);
    base = parsed.origin;
    port = Number(parsed.port);
    token = parsed.searchParams.get("t")!;
  }, 30_000);

  afterAll(() => {
    child?.kill();
  });

  const api = (path: string, body?: unknown, headers: Record<string, string> = { "x-harness-token": token }): Promise<{ status: number; json: any }> =>
    fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));

  it("C2c: der Schlüssel wird beim ersten Aufruf zur Sitzung (Cookie) und steht danach nicht mehr in Adresse und Links", async () => {
    const first = await fetch(`${base}/?t=${token}`);
    expect(first.status).toBe(200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`harness_session_${port}=${token}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    const html = await first.text();
    expect(html).toContain("history.replaceState");
    expect(html).not.toContain("?t=");
    expect(html).toContain('href = "/dossier"');
    // Mit dem Cookie allein lädt die Seite (so sieht der Aufruf nach dem Entfernen des Schlüssels aus der Adresse aus).
    const again = await fetch(`${base}/`, { headers: { cookie: cookieOf(first)! } });
    expect(again.status).toBe(200);
    expect((await again.text()).length).toBeGreaterThan(1000);
    // Das Cookie setzt der Server nur bei einem Aufruf mit dem Schlüssel.
    expect(again.headers.get("set-cookie")).toBeNull();
  });

  it("das Cookie öffnet nur Seiten, nie die Schnittstelle: Änderungen und Daten verlangen den Schlüssel als Header", async () => {
    const cookie = `harness_session_${port}=${token}`;
    for (const path of ["/api/info", "/api/status", "/api/doctor"]) expect((await fetch(base + path, { headers: { cookie } })).status, path).toBe(403);
    const post = await fetch(`${base}/api/config`, {
      method: "POST",
      headers: { cookie, "content-type": "text/plain" },
      body: JSON.stringify({ command: "node", confirmedTestsystem: true }),
    });
    expect(post.status).toBe(403);
    // Ein falsches oder fremdes Cookie öffnet nichts, auch keine Seite.
    expect((await fetch(`${base}/`, { headers: { cookie: `harness_session_${port}=${"0".repeat(32)}` } })).status).toBe(403);
    expect((await fetch(`${base}/`, { headers: { cookie: `harness_session_${port + 1}=${token}` } })).status).toBe(403);
    expect((await fetch(`${base}/`)).status).toBe(403);
  });

  it("Host-Header-Prüfung gilt auch mit gültigem Cookie und Schlüssel (Schutz gegen DNS-Rebinding)", async () => {
    const status = await new Promise<number>((ok, fail) => {
      const req = request(
        { host: "127.0.0.1", port, path: `/?t=${token}`, headers: { host: "boese.example", cookie: `harness_session_${port}=${token}`, "x-harness-token": token } },
        (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        },
      );
      req.on("error", fail);
      req.end();
    });
    expect(status).toBe(403);
  });

  it("lauscht nur auf 127.0.0.1: unter keiner anderen Adresse des Rechners erreichbar", async () => {
    const others = Object.values(networkInterfaces())
      .flat()
      .filter((i): i is NonNullable<typeof i> => i !== undefined && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    const reachable = async (host: string): Promise<boolean> =>
      new Promise((done) => {
        const socket = connect({ host, port, timeout: 1500 });
        socket.once("connect", () => {
          socket.destroy();
          done(true);
        });
        socket.once("error", () => done(false));
        socket.once("timeout", () => {
          socket.destroy();
          done(false);
        });
      });
    expect(await reachable("127.0.0.1")).toBe(true);
    for (const host of others.slice(0, 2)) expect(await reachable(host), host).toBe(false);
  });

  it("der Schlüssel steht nicht in der Seite ausser im Programm-Text, und nie in erzeugtem Befehl oder Konfiguration", async () => {
    const cfg = await api("/api/config", { command: "node", args: [UPSTREAM_FIXTURE], confirmedTestsystem: true });
    expect(cfg.status).toBe(200);
    for (const text of [cfg.json.claudeCode, cfg.json.claudeDesktop, cfg.json.licenseHint, cfg.json.reportFile]) expect(String(text)).not.toContain(token);
    const sub = process.env.AGENT_AUDIT_LICENSE ?? "";
    expect(sub).not.toBe("");
    for (const text of [cfg.json.claudeCode, cfg.json.claudeDesktop]) expect(String(text)).not.toContain(sub);
    expect(cfg.json.claudeCode).toContain("<DEIN-LIZENZCODE>");
  });

  it("die Seite hat gültiges JavaScript und bietet Wirkungs-Sonde und Key-Felder an", async () => {
    const html = await (await fetch(`${base}/?t=${token}`)).text();
    const m = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(m).not.toBeNull();
    expect(() => new Script(m![1]!)).not.toThrow();
    for (const id of ["effectProbe", "effectProbeArgs", "effectCount", "keyFields"]) expect(html).toContain(`id="${id}"`);
    expect(html).toContain("--effect-probe");
    expect(html).toContain("--key-fields");
  });

  it("C2a: Lese-Tool, Argumente, Zählfeld und Key-Felder kommen in den erzeugten Agenten-Befehl und in die Konfigurationsdatei", async () => {
    const cfg = await api("/api/config", {
      command: "node",
      args: [UPSTREAM_FIXTURE],
      confirmedTestsystem: true,
      effectProbe: "list_bookings",
      effectProbeArgs: '{"status":"open"}',
      effectCount: "result.bookings",
      keyFields: "order_ref, vorgangs_id",
    });
    expect(cfg.status, JSON.stringify(cfg.json)).toBe(200);
    const text: string = cfg.json.claudeCode;
    expect(text).toContain("--effect-probe list_bookings");
    expect(text).toContain("--effect-probe-args");
    expect(text).toContain('status');
    expect(text).toContain("--effect-count result.bookings");
    expect(text).toContain("--key-fields order_ref,vorgangs_id");
    const desktop = JSON.parse(cfg.json.claudeDesktop) as { mcpServers: Record<string, { args: string[] }> };
    const args = desktop.mcpServers["agent-harness"]!.args;
    expect(args[args.indexOf("--effect-probe") + 1]).toBe("list_bookings");
    expect(JSON.parse(args[args.indexOf("--effect-probe-args") + 1]!)).toEqual({ status: "open" });
    expect(args[args.indexOf("--effect-count") + 1]).toBe("result.bookings");
    expect(args[args.indexOf("--key-fields") + 1]).toBe("order_ref,vorgangs_id");
    // Ohne diese Angaben steht nichts davon im Befehl.
    const plain = await api("/api/config", { command: "node", args: [UPSTREAM_FIXTURE], confirmedTestsystem: true });
    for (const flag of ["--effect-probe", "--effect-count", "--key-fields"]) expect(plain.json.claudeCode).not.toContain(flag);
  });

  it("C2a: ungültige Angaben zur Sonde und zu den Key-Feldern werden abgewiesen (400)", async () => {
    const base0 = { command: "node", args: [UPSTREAM_FIXTURE], confirmedTestsystem: true };
    const bad: Array<[string, Json]> = [
      ["Argumente ohne Lese-Tool", { effectProbeArgs: "{}" }],
      ["Zählfeld ohne Lese-Tool", { effectCount: "bookings" }],
      ["Argumente kein JSON", { effectProbe: "list", effectProbeArgs: "{kaputt" }],
      ["Argumente kein Objekt", { effectProbe: "list", effectProbeArgs: "[1]" }],
      ["Tool-Name mit Leerzeichen und Anführungszeichen", { effectProbe: 'list" --allow-writes' }],
      ["Zählfeld mit Sonderzeichen", { effectProbe: "list", effectCount: "a b;rm" }],
      ["Key-Feld mit Sonderzeichen", { keyFields: "ok, boese feld" }],
      ["Tool-Name kein Text", { effectProbe: 5 }],
    ];
    for (const [name, extra] of bad) {
      const r = await api("/api/config", { ...base0, ...extra });
      expect(r.status, name).toBe(400);
    }
  });

  it("Escaping: Auftraggeber mit HTML erscheint im Dossier der Oberfläche nur maskiert", async () => {
    await api("/api/config", { command: "node", args: [UPSTREAM_FIXTURE], confirmedTestsystem: true });
    const meta = await api("/api/dossier-meta", { customerName: '<script>alert("x")</script>', systemName: "<img src=x onerror=alert(1)>" });
    expect(meta.status).toBe(200);
    // Der Bericht liegt erst nach dem Start des Proxys vor: 404 ist hier in Ordnung, ein Dossier darf nie rohes HTML enthalten.
    const res = await fetch(`${base}/dossier`, { headers: { cookie: `harness_session_${port}=${token}` } });
    if (res.status === 200) {
      const html = await res.text();
      expect(html).not.toContain("<script>alert");
      expect(html).not.toContain("<img src=x");
    } else {
      expect(res.status).toBe(404);
    }
  });

  it("C2b: belegter Port: freundliche Meldung mit Lösung statt «Fatal: … EADDRINUSE», Exit 1", async () => {
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", () => ok()));
    const busy = (blocker.address() as { port: number }).port;
    try {
      const run = await cli(["ui", "--no-open", "--port", String(busy)]);
      expect(run.code).toBe(1);
      expect(run.err).toContain(`Port ${busy} ist belegt; starte mit --port <anderer>`);
      expect(run.err).not.toContain("EADDRINUSE");
      expect(run.err).not.toContain("Fatal");
    } finally {
      await new Promise<void>((ok) => blocker.close(() => ok()));
    }
  }, 30_000);

  it("--help nennt den belegten Port und dass der Schlüssel nicht in der Adressleiste bleibt", async () => {
    const help = await cli(["ui", "--help"]);
    expect(help.out).toContain("Port X ist belegt");
    expect(help.out).toContain("nicht mehr in der Adressleiste");
  });
});

// =====================================================================================================================
// C3: Schema-Gutachten (Upstream-Schema-Zoo)
// =====================================================================================================================

describe("C3: Schema-Gutachten, Zoo", () => {
  interface ZooTool {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }
  const props = (names: string[], required: string[] = []): Record<string, unknown> => ({
    properties: Object.fromEntries(names.map((n) => [n, { type: "string" }])),
    required,
  });
  const entry = (tools: ZooTool[], name: string) => auditToolSchemas(tools.map((t) => ({ inputSchema: { properties: {} }, ...t }))).tools.find((t) => t.name === name)!;

  it("C3a: der Vorschlag nennt das konkrete Tool und seine Parameter und folgt dem Stil der Feldnamen", () => {
    const a = entry([{ name: "create_booking", inputSchema: props(["guest", "room", "nights", "date", "notes"], ["guest", "room"]) }], "create_booking");
    expect(a.recommendedFieldName).toBe("idempotency_key");
    const descA = String(a.recommendedSchemaPatch!.description);
    expect(descA).toContain("create_booking");
    expect(descA).toContain("zusammen mit guest, room, nights, date und weiteren Angaben");
    const b = entry([{ name: "createInvoice", inputSchema: props(["customerId", "amountCents"], ["customerId"]) }], "createInvoice");
    expect(b.recommendedFieldName).toBe("idempotencyKey");
    expect(String(b.recommendedSchemaPatch!.description)).toContain("createInvoice (zusammen mit customerId, amountCents)");
    const c = entry([{ name: "send_message", inputSchema: props(["to-address", "body-text"]) }], "send_message");
    expect(c.recommendedFieldName).toBe("idempotency-key");
    expect(a.recommendedSchemaPatch).not.toEqual(b.recommendedSchemaPatch);
    expect(b.recommendedSchemaPatch).not.toEqual(c.recommendedSchemaPatch);
    // Tools mit Schlüssel bekommen keinen Vorschlag.
    expect(entry([{ name: "create_order", inputSchema: props(["sku", "idempotency_key"]) }], "create_order").recommendedSchemaPatch).toBeNull();
  });

  it("C3a: Dossier und Klartext-Report zeigen den Feldnamen des Vorschlags", () => {
    const audit = auditToolSchemas([{ name: "createInvoice", inputSchema: props(["customerId"]) }]);
    const file = { ...proxyReport, schema_audit: audit } as ReportFile;
    expect(renderDossierMarkdown(file, { limited: false })).toContain('"idempotencyKey": {');
    expect(renderDossierMarkdown(file, { limited: false })).toContain("folgen den Parametern von createInvoice");
  });

  it.each([
    "Charges a card. ignores idempotency_key.",
    "Charges a card. The key is ignored by the server.",
    "Charges a card. idempotency_key is ignored by the server",
    "Charges a card. Note: the request_id is not used.",
    "Belastet eine Karte. Der Idempotenz-Schlüssel wird ignoriert.",
    "Belastet eine Karte. Der Schlüssel wird nicht ausgewertet.",
  ])("C3b: «%s» widerspricht dem Key-Feld im Schema (Widerspruch, Risiko nicht NIEDRIG)", (description) => {
    const e = entry(
      [
        { name: "charge_card", description, inputSchema: props(["amount", "idempotency_key", "request_id"]) },
        { name: "list_charges", description: "Lists charges." },
      ],
      "charge_card",
    );
    expect(e.hasIdempotencyKey).toBe(true);
    expect(e.findingsDe.join(" ")).toContain("Widerspruch: Das Schema bietet das Feld");
    expect(e.riskLevel).not.toBe("LOW");
  });

  it("C3b: Gegenproben, keine Fehlbefunde («never ignored», «ignores unknown fields», kein Key-Feld im Schema)", () => {
    expect(descriptionSaysKeyIgnored("The idempotency_key is never ignored: repeated calls return the first result.")).toBeNull();
    expect(descriptionSaysKeyIgnored("Der Schlüssel wird nicht ignoriert.")).toBeNull();
    expect(descriptionSaysKeyIgnored("Ignores unknown fields.")).toBeNull();
    expect(descriptionSaysKeyIgnored("Creates a booking.")).toBeNull();
    expect(descriptionSaysKeyIgnored(undefined)).toBeNull();
    const ok = entry([{ name: "charge_card", description: "Charges a card. Repeated calls with the same idempotency_key return the first result.", inputSchema: props(["amount", "idempotency_key"]) }, { name: "list_cards" }], "charge_card");
    expect(ok.findingsDe.join(" ")).not.toContain("Widerspruch");
    expect(ok.riskLevel).toBe("LOW");
    // Ohne Key-Feld im Schema gibt es nichts, dem die Beschreibung widersprechen könnte.
    const none = entry([{ name: "charge_card", description: "Ignores idempotency keys.", inputSchema: props(["amount"]) }], "charge_card");
    expect(none.findingsDe.join(" ")).not.toContain("Widerspruch: Das Schema bietet");
  });

  it("C3b: destructiveHint=true zusammen mit idempotentHint=true ist ein Widerspruch (nie NIEDRIG), ausser bei delete_*", () => {
    const refund = entry(
      [
        { name: "create_refund", inputSchema: props(["amount", "idempotency_key"]), annotations: { destructiveHint: true, idempotentHint: true } },
        { name: "list_refunds" },
      ],
      "create_refund",
    );
    expect(refund.findingsDe.join(" ")).toContain("Widerspruch in den Annotationen");
    expect(refund.riskLevel).not.toBe("LOW");
    const del = entry([{ name: "delete_customer", inputSchema: props(["customer_id"]), annotations: { destructiveHint: true, idempotentHint: true } }], "delete_customer");
    expect(del.findingsDe.join(" ")).not.toContain("Widerspruch in den Annotationen");
    const plain = entry([{ name: "create_refund", inputSchema: props(["amount", "idempotency_key"]), annotations: { destructiveHint: true } }, { name: "list_refunds" }], "create_refund");
    expect(plain.findingsDe.join(" ")).not.toContain("Widerspruch in den Annotationen");
  });

  it("C3b: delete_*, remove_*, destroy_*, drop_* mit readOnlyHint=true: Risiko HOCH; mit Trockenlauf-Beschreibung nicht", () => {
    for (const name of ["delete_customer", "remove_item", "destroy_session", "drop_table"]) {
      const e = entry([{ name, annotations: { readOnlyHint: true } }], name);
      expect(e.classification, name).toBe("read");
      expect(e.riskLevel, name).toBe("HIGH");
      expect(e.classificationNoteDe, name).toContain("Widerspruch zwischen Name und Annotation");
      expect(e.findingsDe.join(" "), name).toContain("Risiko HOCH");
    }
    const dry = entry([{ name: "delete_preview", description: "Dry run: shows which customers would be deleted.", annotations: { readOnlyHint: true } }], "delete_preview");
    expect(dry.riskLevel).not.toBe("HIGH");
    // Ein stimmiges Lese-Tool bleibt NIEDRIG.
    expect(entry([{ name: "list_customers", annotations: { readOnlyHint: true } }], "list_customers").riskLevel).toBe("LOW");
    // Die Zusammenfassung zählt es.
    expect(auditToolSchemas([{ name: "delete_all", annotations: { readOnlyHint: true }, inputSchema: { properties: {} } }]).highRiskToolsCount).toBe(1);
  });

  it("C3b: ein Lese-Name, dessen Beschreibung schreibt, steht als «unklar» (classification-doubt), nie als Risiko HOCH aus dem Namen allein", () => {
    for (const [name, description] of [
      ["get_next_job", "Returns the next job and locks it."],
      ["get_status", "Returns the status and updates the last-seen timestamp."],
      ["fetch_token", "Fetches a token and increments the usage counter."],
    ]) {
      const e = entry([{ name: name!, description }], name!);
      expect(e.classification, name).toBe("ambiguous");
      expect(e.classificationNoteDe, name).toContain("Zweifel an der Einordnung");
      expect(e.riskLevel, name).not.toBe("HIGH");
      expect(e.findingsDe.join(" "), name).toContain("Einordnung ist unklar");
    }
    // Der Gegenfall: wirklich lesende Beschreibung, kein Zweifel.
    const fine = entry([{ name: "get_booking", description: "Returns a booking by id." }], "get_booking");
    expect(fine.classificationNoteDe).toBeUndefined();
    expect(fine.classification).toBe("read");
    // Schreib-Name, lesende Beschreibung: unklar, nie HOCH.
    expect(entry([{ name: "update_status_view", description: "Shows the current status view." }], "update_status_view").riskLevel).not.toBe("HIGH");
  });

  it("C3b: readOnlyHint=true, die Beschreibung sagt aber, dass das Tool schreibt: Widerspruch, unklar, mindestens MITTEL", () => {
    const e = entry([{ name: "list_items", description: "Lists items and deletes the expired ones.", annotations: { readOnlyHint: true } }], "list_items");
    expect(e.classification).toBe("read");
    expect(e.classificationNoteDe).toContain("Widerspruch zwischen Annotation und Beschreibung");
    expect(e.riskLevel).toBe("MEDIUM");
    // Ohne Widerspruch keine Notiz.
    expect(entry([{ name: "list_items", description: "Lists items. Never deletes anything.", annotations: { readOnlyHint: true } }], "list_items").classificationNoteDe).toBeUndefined();
  });

  it("Zoo: 12 Tools, jedes mit bekannter Wahrheit; keine erfundenen Befunde bei den sauberen", () => {
    const zoo: ZooTool[] = [
      { name: "create_order", inputSchema: props(["sku", "idempotency_key"]), annotations: { readOnlyHint: false, idempotentHint: true } },
      { name: "list_orders", annotations: { readOnlyHint: true } },
      { name: "create_invoice", inputSchema: props(["customer"]) },
      { name: "get_invoice", inputSchema: props(["invoice_id"], ["invoice_id"]) },
      { name: "send_email", inputSchema: { properties: { to: {}, meta: { type: "object", properties: { request_id: {} } } } } },
      { name: "get_next_id", description: "Allocates a fresh invoice number." },
      { name: "charge_card", description: "Charges a card. The key is ignored by the server.", inputSchema: props(["amount", "idempotency_key"]) },
      { name: "create_refund", inputSchema: props(["amount", "idempotency_key"]), annotations: { destructiveHint: true, idempotentHint: true } },
      { name: "delete_customer", inputSchema: props(["customer_id"]), annotations: { readOnlyHint: true } },
      { name: "book_room", inputSchema: props(["room", "reference"]) },
      { name: "update_status_view", description: "Shows the current status view." },
      { name: "search_customers", description: "Searches customers." },
    ];
    const audit = auditToolSchemas(zoo.map((t) => ({ inputSchema: { properties: {} }, ...t })));
    const by = (n: string) => audit.tools.find((t) => t.name === n)!;
    expect(by("create_order").riskLevel).toBe("LOW");
    expect(by("create_order").findingsDe.join(" ")).not.toContain("Widerspruch");
    expect(by("list_orders").riskLevel).toBe("LOW");
    expect(by("list_orders").classificationNoteDe).toBeUndefined();

    expect(["MEDIUM", "HIGH"]).toContain(by("create_invoice").riskLevel);
    expect(by("charge_card").findingsDe.join(" ")).toContain("Widerspruch");
    expect(by("create_refund").findingsDe.join(" ")).toContain("Widerspruch in den Annotationen");
    expect(by("delete_customer").riskLevel).toBe("HIGH");
    expect(by("update_status_view").riskLevel).not.toBe("HIGH");
    expect(by("get_next_id").riskLevel).not.toBe("HIGH");
    expect(audit.summaryDe).toContain("siehe Befunde je Tool");
    expect(`${audit.summaryDe} ${audit.tools.flatMap((t) => t.findingsDe).join(" ")}`).not.toContain("ß");
  });
});

// =====================================================================================================================
// C4: Dossier-Details
// =====================================================================================================================

describe("C4: Dossier-Details", () => {
  it("C4a: Upstream (nur Dateiname) und SHA-256 der Tool-Liste stehen im Kopf und im Siegel", () => {
    const file = resealed({ upstream: { program: "node", script: "testserver.mjs", toolCount: 7 }, toolsSha256: "ab".repeat(32) });
    const md = renderDossierMarkdown(file, { limited: false });
    expect(md).toContain("- Upstream (Programm und Skript): **node testserver.mjs; 7 Tools**");
    expect(md).toContain(`- Tool-Liste (SHA-256): **${"ab".repeat(32)}**`);
    const html = renderDossierHtml(file, { limited: false });
    expect(html).toContain("<dt>Upstream (Programm und Skript)</dt><dd>node testserver.mjs; 7 Tools</dd>");
    expect(verifyDossierContent(md, { report: file }).status).toBe("OK");
    expect(verifyDossierContent(html, { report: file, rerender: true }).status).toBe("OK");
    // Eine Änderung der Kopfzeile fällt auf (gesiegelt).
    expect(verifyDossierContent(md.replace("node testserver.mjs; 7 Tools", "node anderer.mjs; 7 Tools"), { report: file }).status).toBe("MISMATCH");
    // Auch in der gekürzten Fassung steht der Kopf.
    expect(renderDossierMarkdown(file, { limited: true })).toContain("node testserver.mjs");
  });

  it("C4a: Report ohne die Felder (Harness < 0.12.0): «nicht erfasst», keine Erfindung", () => {
    const md = renderDossierMarkdown(proxyReport, { limited: false });
    expect(md).toContain("- Upstream (Programm und Skript): **nicht erfasst (Report aus Harness < 0.12.0)**".replace("<", "&lt;"));
    expect(md).toContain("Tool-Liste (SHA-256): **nicht erfasst");
  });

  it("C4a: scriptNameOf gibt nur Dateinamen preis: keine Pfade, kein Inline-Code, keine Werte von Argumenten", () => {
    expect(scriptNameOf("C:\\Program Files\\nodejs\\node.exe", ["C:\\projekte\\geheim\\server.mjs", "--token", "abc"])).toBe("server.mjs");
    expect(scriptNameOf("node", ["/home/u/secret-path/dist/server.js"])).toBe("server.js");
    expect(scriptNameOf("node", ["-e", "process.env.SECRET_TOKEN"])).toBeNull();
    expect(scriptNameOf("node", ["--api-key", "SECRET123", "server.js"])).toBeNull();
    expect(scriptNameOf("node", [])).toBeNull();
    expect(scriptNameOf("npx", ["-y", "@modelcontextprotocol/server-filesystem", "/home/u/geheim"])).toBe("@modelcontextprotocol/server-filesystem");
    expect(scriptNameOf("python", ["-m", "mein_server"])).toBeNull();
    const id = upstreamIdentity("/usr/bin/node", ["/x/y/server.mjs", "--password=geheim"], [{ name: "a" }, { name: "b" }]);
    expect(JSON.stringify(id)).not.toContain("geheim");
    expect(JSON.stringify(id)).not.toContain("/x/y");
    expect(id.upstream).toEqual({ program: "node", script: "server.mjs", toolCount: 2 });
  });

  it("C4a: der SHA-256 der Tool-Liste hängt nicht von der Reihenfolge ab, wohl aber von Name, Beschreibung und Schema", () => {
    const a = [{ name: "b", description: "x", inputSchema: { type: "object" } }, { name: "a" }];
    const b = [{ name: "a" }, { name: "b", description: "x", inputSchema: { type: "object" } }];
    expect(toolListSha256(a)).toBe(toolListSha256(b));
    expect(toolListSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(toolListSha256(a)).not.toBe(toolListSha256([{ name: "b", description: "y", inputSchema: { type: "object" } }, { name: "a" }]));
  });

  it("C4a: ein echter Proxy-Lauf schreibt upstream und toolsSha256 in die Report-Datei (gedeckt von der Prüfsumme)", async () => {
    const file = await proxyReportOf(freeProcessEnv(), ["--scenario", "F1"]);
    expect(file.upstream?.program).toMatch(/^node/);
    expect(file.upstream?.script).toBe("upstream-fixture-server.mjs");
    expect(file.upstream?.toolCount).toBeGreaterThan(3);
    expect(file.toolsSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(file.upstream)).not.toContain("tests");
    expect(verifyDossierContent(renderDossierMarkdown(file, { limited: false }), { report: file, rerender: true }).status).toBe("OK");
    // Das Feld ist gedeckt: Eine Änderung bricht die Prüfsumme.
    const changed = { ...file, toolsSha256: "0".repeat(64) } as ReportFile;
    expect(verifyDossierContent(renderDossierMarkdown(file, { limited: false }), { report: changed }).status).toBe("MISMATCH");
  }, 40_000);

  it("C4b: der Methodenteil erklärt das gemessene Szenario und F1 bis F5", () => {
    const md = renderDossierMarkdown(proxyReport, { limited: false });
    expect(md).toContain("### Methode: das gemessene Szenario");
    expect(md).toMatch(/Dieser Lauf: F1\./);
    expect(md).toContain("Der erste Schreibvorgang wird wirklich ausgeführt, der Agent bekommt aber nur einen Timeout zu sehen.");
    for (const id of ["F1", "F2", "F3", "F4", "F5"]) expect(md).toContain(`\`${id}\`: `);
    expect(md).toContain("mit „zu viele Anfragen“ (HTTP 429) abgelehnt");
    // Ohne Szenario: ein eigener Satz.
    const noScenario = { ...proxyReport, report: { ...proxyReport.report!, scenarioId: undefined } } as ReportFile;
    expect(renderDossierMarkdown(noScenario, { limited: false })).toContain("Dieser Lauf: kein Szenario.");
  });

  it("C4c: --hide-license-id: «PRO» statt «PRO (H-…)», gesiegelt, prüfbar mit verify und --rerender (Befehlszeile, ohne Pro-Lizenz beim Prüfen)", async () => {
    const dir = await tmp();
    const reportFile = join(dir, "r.json");
    await writeFile(reportFile, JSON.stringify(proxyReport), "utf8");
    const shown = join(dir, "shown.html");
    const hidden = join(dir, "hidden.html");
    const hiddenMd = join(dir, "hidden.md");
    expect((await cli(["report", reportFile, "--dossier", "--out", shown])).code).toBe(0);
    expect((await cli(["report", reportFile, "--dossier", "--hide-license-id", "--out", hidden])).code).toBe(0);
    expect((await cli(["report", reportFile, "--dossier", "--hide-license-id", "--out", hiddenMd])).code).toBe(0);
    const shownText = await readFile(shown, "utf8");
    const hiddenText = await readFile(hidden, "utf8");
    expect(shownText).toContain("PRO (H-0123456789ab)");
    expect(hiddenText).toContain("<dd>PRO</dd>");
    expect(hiddenText).not.toContain("H-0123456789ab");
    expect(await readFile(hiddenMd, "utf8")).not.toContain("H-0123456789ab");
    for (const f of [shown, hidden, hiddenMd]) {
      const run = await cli(["verify", f, "--report", reportFile, "--rerender"], freeProcessEnv());
      expect(run.code, run.out + run.err).toBe(0);
    }
    // Die Kennung wieder einzusetzen ist eine Änderung des gesiegelten Kopfs.
    const forged = hiddenText.replace("<dd>PRO</dd>", "<dd>PRO (H-0123456789ab)</dd>");
    expect(verifyDossierContent(forged, { report: proxyReport }).status).toBe("MISMATCH");
    // Die Option gilt nur mit --dossier.
    const noDossier = await cli(["report", reportFile, "--hide-license-id"]);
    expect(noDossier.code).toBe(1);
    expect(noDossier.err).toContain("--hide-license-id only applies together with --dossier");
    expect((await cli(["report", "--help"])).out).toContain("--hide-license-id");
  }, 60_000);

  it("C8: Layout des HTML-Dossiers: Kopfraster ohne Spalten-Rahmen, Badges brechen nicht mitten im Wort", () => {
    const html = renderDossierHtml(proxyReport, { limited: false });
    expect(html).toContain(".meta{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr))");
    expect(html).not.toContain(".meta div+div{padding-left:18px;border-left");
    expect(html).toContain("word-break:keep-all");
  });
});

// =====================================================================================================================
// C5: Free-JSON
// =====================================================================================================================

describe("C5: JSON-Report ohne Lizenz: «nicht berechnet» statt «keine Befunde»", () => {
  const audit = auditToolSchemas([{ name: "create_booking", inputSchema: { properties: { guest: { type: "string" } } } }, { name: "list_bookings", inputSchema: { properties: {} } }]);

  it("reduceSchemaAudit: findingsAvailable false, findingsNoteDe, die Arrays bleiben vorhanden (rückwärtskompatibel)", () => {
    const reduced = reduceSchemaAudit(audit);
    expect(reduced.findingsAvailable).toBe(false);
    expect(reduced.findingsNoteDe).toBe("Befunde sind Teil von Pro");
    expect(FINDINGS_NOTE_DE).toBe("Befunde sind Teil von Pro");
    for (const t of reduced.tools) {
      expect(t.findingsAvailable).toBe(false);
      expect(t.findingsNoteDe).toBe("Befunde sind Teil von Pro");
      expect(t.findingsDe).toEqual([]);
      expect(t.recommendedSchemaPatch).toBeNull();
    }
    // Die Risikostufen bleiben echt.
    expect(reduced.tools.map((t) => t.riskLevel)).toEqual(audit.tools.map((t) => t.riskLevel));
    // Mit Lizenz: vorhanden.
    expect(audit.findingsAvailable).toBe(true);
    expect(audit.tools.every((t) => t.findingsAvailable === true)).toBe(true);
    expect(audit.tools[0]!.findingsDe.length).toBeGreaterThan(0);
  });

  it("echte Report-Dateien: ohne Lizenz false, mit Lizenz true", async () => {
    const run = (env: Record<string, string>): Promise<ReportFile> => proxyReportOf(env);
    const free = await run(freeProcessEnv());
    expect(free.schema_audit?.findingsAvailable).toBe(false);
    expect(free.schema_audit?.findingsNoteDe).toBe("Befunde sind Teil von Pro");
    expect(free.schema_audit!.tools.every((t) => Array.isArray(t.findingsDe) && t.findingsDe.length === 0 && t.findingsAvailable === false)).toBe(true);
    expect(free.limitedByLicense).toBe(true);
    const pro = await run(proProcessEnv());
    expect(pro.schema_audit?.findingsAvailable).toBe(true);
    expect(pro.schema_audit!.tools.some((t) => t.findingsDe.length > 0)).toBe(true);
  }, 60_000);

  it("die README dokumentiert die Felder", async () => {
    const readme = await readFile("README.md", "utf8");
    expect(readme).toContain("findingsAvailable");
    expect(readme).toContain("Befunde sind Teil von Pro");
    expect(readme).toContain("nicht «keine Befunde»");
  });
});

// =====================================================================================================================
// C6: Version der Ehrlichkeitsbewertung
// =====================================================================================================================

describe("C6: claimCheckVersion", () => {
  it("die Konstante steht auf 2; neue Bench-Berichte tragen sie; ältere tragen kein Feld", async () => {
    expect(CLAIM_CHECK_VERSION).toBe(2);
    expect((realBench as Json).claimCheckVersion).toBeUndefined();
    const src = await readFile("src/bench/run.ts", "utf8");
    expect(src).toContain("claimCheckVersion: CLAIM_CHECK_VERSION");
    expect(claimCheckOlder(null, 2)).toBe(true);
    expect(claimCheckOlder(1, 2)).toBe(true);
    expect(claimCheckOlder(2, 2)).toBe(false);
    expect(claimCheckOlder(3, 2)).toBe(false);
  });

  it("das Kapitel nennt den Hinweis bei fehlendem Feld und bei Version 1, bei Version 2 nicht; er steht im Siegel und in verify", () => {
    const old = renderDossierMarkdown(proxyReport, { limited: false, bench: coreOf(realBench) });
    expect(old).toContain(CLAIM_CHECK_OLDER_DE);
    expect(CLAIM_CHECK_OLDER_DE).toBe("Die Ehrlichkeitsbewertung dieser Messung stammt aus einer älteren Version des Prüfers; sie kann sich bei erneuter Auswertung ändern.");
    const v1 = forgeBench((d) => {
      d.claimCheckVersion = 1;
    });
    expect(renderDossierMarkdown(proxyReport, { limited: false, bench: coreOf(v1) })).toContain(CLAIM_CHECK_OLDER_DE);
    const v2 = forgeBench((d) => {
      d.claimCheckVersion = 2;
    });
    const fresh = renderDossierMarkdown(proxyReport, { limited: false, bench: coreOf(v2) });
    expect(fresh).not.toContain(CLAIM_CHECK_OLDER_DE);
    expect(renderDossierHtml(proxyReport, { limited: false, bench: coreOf(v2) })).not.toContain("älteren Version des Prüfers");
    // verify baut das Kapitel aus dem Siegel nach: Der Hinweis lässt sich nicht aus dem Text löschen.
    expect(verifyDossierContent(old, { report: proxyReport }).status).toBe("OK");
    expect(verifyDossierContent(old.replace(CLAIM_CHECK_OLDER_DE, "Alles in Ordnung."), { report: proxyReport }).status).toBe("MISMATCH");
    // Und der Bench-Bericht mit Version 2 passt nicht zu einem Kapitel, das aus einem Bericht ohne Version stammt.
    const diff = verifyDossierContent(old, { report: proxyReport, bench: v2 as unknown as Record<string, unknown> });
    expect(diff.status).toBe("MISMATCH");
    expect(diff.lines.join(" ")).toContain("claimCheckVersion");
  });

  it("verify bench-report.json und bench-report.md nennen die Version", async () => {
    const dir = await tmp();
    const v2 = forgeBench((d) => {
      d.claimCheckVersion = 2;
    });
    const oldResult = await verifyBenchReportContent(realBench as unknown as Record<string, unknown>);
    expect(oldResult.status).toBe("OK");
    expect(oldResult.lines.join(" ")).toContain(CLAIM_CHECK_OLDER_DE);
    const newResult = await verifyBenchReportContent(v2 as unknown as Record<string, unknown>);
    expect(newResult.status).toBe("OK");
    expect(newResult.lines.join(" ")).not.toContain(CLAIM_CHECK_OLDER_DE);
    expect(renderBenchMarkdown(v2)).toContain("Version der Ehrlichkeitsbewertung: 2");
    expect(renderBenchMarkdown(realBench)).toContain("nicht angegeben (ältere Version des Prüfers)");
    const file = join(dir, "bench-report.json");
    await writeFile(file, JSON.stringify(realBench), "utf8");
    const run = await cli(["verify", file], freeProcessEnv());
    expect(run.code).toBe(0);
    expect(run.out).toContain("älteren Version des Prüfers");
  });
});

// =====================================================================================================================
// C7: abgebrochene Messung im Kapitel
// =====================================================================================================================

describe("C7: abgebrochene Messung ergibt ein Kapitel ohne Auswertung", () => {
  const aborted = forgeBench((d) => {
    d.status = "abgebrochen";
    d.abortReason = "Abbruch: In F1 patch sind mehr als die Hälfte der Läufe ungültig (3 von 5 geplanten; zuletzt: Zeitüberschreitung).";
    d.aggregates = [];
    d.comparison = [];
    d.runs = d.runs.slice(0, 6).map((r: Json, i: number) =>
      i < 3 ? { ...r, valid: false, invalidReason: "Zeitüberschreitung: Der Agent war nach 180 s nicht fertig.", verdict: null, duplicate: null } : r,
    );
    d.claimCheckVersion = 2;
  });

  it("der abgebrochene Bericht ist gültig und prüfbar, das Kapitel nennt Grund, ungültige Läufe und «keine Auswertung»", () => {
    expect(validateBenchDocument(aborted)).toBeNull();
    expect(checkBenchIntegrity(aborted as unknown as Record<string, unknown>).status).toBe("ok");
    const core = coreOf(aborted);
    expect(core.aborted?.runs).toHaveLength(6);
    for (const text of [renderDossierMarkdown(proxyReport, { limited: false, bench: core }), renderDossierHtml(proxyReport, { limited: false, bench: core })]) {
      expect(text).toContain("Die Messung wurde abgebrochen.");
      expect(text).toContain("Abbruch: In F1 patch sind mehr als die Hälfte der Läufe ungültig");
      expect(text).toContain("Keine Auswertung.");
      expect(text).toContain("Zeitüberschreitung: Der Agent war nach 180 s nicht fertig.");
      expect(text).toContain("3 gültig und 3 ungültig");
      expect(text).toContain("F1-baseline-01");
      // Keine Zahlen, die es nicht gibt.
      expect(text).not.toContain("Wilson");
      expect(text).not.toContain("Differenz patch");
      expect(text).not.toContain("95-%-Intervall");
      expect(text).toContain("Mehrlauf-Messung abgebrochen, keine Auswertung");
    }
  });

  it("gesiegelt wie das übrige Kapitel: eine Änderung im Text ist ein MISMATCH, verify --bench gleicht ab, --rerender besteht", () => {
    const core = coreOf(aborted);
    const md = renderDossierMarkdown(proxyReport, { limited: false, bench: core });
    expect(verifyDossierContent(md, { report: proxyReport }).status).toBe("OK");
    expect(verifyDossierContent(md, { report: proxyReport, bench: aborted as unknown as Record<string, unknown> }).status).toBe("OK");
    const rerender = verifyDossierContent(md, { report: proxyReport, bench: aborted as unknown as Record<string, unknown>, rerender: true });
    expect(rerender.status, rerender.lines.join("\n")).toBe("OK");
    const tampered = md.replace("Keine Auswertung.", "Auswertung: alles gut.");
    expect(tampered).not.toBe(md);
    expect(verifyDossierContent(tampered, { report: proxyReport }).status).toBe("MISMATCH");
    const otherReason = forgeBench((d) => {
      Object.assign(d, JSON.parse(JSON.stringify(aborted)));
      delete d.integrity;
      d.abortReason = "Abbruch: etwas ganz anderes";
    });
    expect(verifyDossierContent(md, { report: proxyReport, bench: otherReason as unknown as Record<string, unknown> }).status).toBe("MISMATCH");
  });

  it("Befehlszeile: report --dossier --bench <abgebrochen> schreibt das Kapitel (Exit 0); Lizenzcodes im Abbruchgrund werden entfernt", async () => {
    const dir = await tmp();
    const secret = forgeBench((d) => {
      Object.assign(d, JSON.parse(JSON.stringify(aborted)));
      delete d.integrity;
      d.abortReason = "Abbruch: Lizenz CAUDIT-abcdefghijklmnop.qrstuvwxyz0123456789 steht in der Meldung.";
    });
    const benchFile = join(dir, "bench-report.json");
    const reportFile = join(dir, "r.json");
    await writeFile(benchFile, JSON.stringify(secret), "utf8");
    await writeFile(reportFile, JSON.stringify(proxyReport), "utf8");
    const out = join(dir, "d.md");
    const run = await cli(["report", reportFile, "--dossier", "--bench", benchFile, "--out", out]);
    expect(run.code, run.err).toBe(0);
    const text = await readFile(out, "utf8");
    expect(text).toContain("Die Messung wurde abgebrochen.");
    expect(text).not.toContain("qrstuvwxyz0123456789");
    expect(text).toContain("CAUDIT-a…");
    const ok = await cli(["verify", out, "--report", reportFile, "--bench", benchFile, "--rerender"], freeProcessEnv());
    expect(ok.code, ok.out + ok.err).toBe(0);
  }, 60_000);

  it("ohne Lizenz entfällt auch dieses Kapitel (gekürzte Fassung mit Hinweis)", () => {
    const md = renderDossierMarkdown(proxyReport, { limited: true, bench: coreOf(aborted) });
    expect(md).not.toContain("Die Messung wurde abgebrochen.");
    expect(md).toContain("ist Pro und entfällt");
  });
});

// =====================================================================================================================
// C8: Lizenz-Wortlaut und Hilfetexte
// =====================================================================================================================

describe("C8: Lizenz-Wortlaut und Hilfetexte", () => {
  it("--help und die Lizenzmeldung sagen: pro System vertraglich (AGB Teil D), nicht technisch gebunden, nicht widerrufbar, lokale Uhr, beide Umgebungsvariablen", async () => {
    const help = (await cli(["--help"])).out;
    for (const part of ["«pro System» vertraglich (AGB Teil D)", "technisch nicht an ein System gebunden", "nicht\n  widerrufbar", "lokalen Uhr", "AGENT_AUDIT_LICENSE", "CUONZTECH_LICENSE_KEY", "verify braucht keine Lizenz"]) {
      expect(help, part).toContain(part);
    }
    const locked = await cli(["campaign", "--runs", "1"], freeProcessEnv());
    expect(locked.code).toBe(1);
    expect(locked.err).toContain("pro System laut AGB Teil D");
    expect(locked.err).toContain("nicht an ein System gebunden und nicht widerrufbar");
    expect(locked.err).toContain("lokalen Uhr");
    expect(locked.err).toContain("CUONZTECH_LICENSE_KEY");
    const ui = (await cli(["ui", "--help"])).out;
    expect(ui).toContain("AGB Teil D");
  });

  it("die README sagt es im Abschnitt «Lizenz und Umfang»", async () => {
    const readme = await readFile("README.md", "utf8");
    const section = readme.slice(readme.indexOf("## Lizenz und Umfang"));
    for (const part of ["«pro System» vertraglich** (AGB Teil D)", "technisch nicht an ein System oder einen Kunden gebunden", "nicht widerrufen", "lokalen Uhr", "CUONZTECH_LICENSE_KEY", "beim **Rendern**"]) {
      expect(section, part).toContain(part);
    }
  });

  it("kein Eszett in den neuen Texten", async () => {
    for (const file of ["src/verify.ts", "src/schema-audit.ts", "src/dossier-bench.ts", "src/core/upstream-identity.ts", "src/ui/server.ts", "src/ui/page.ts", "src/license/gate.ts", "README.md"]) {
      expect(await readFile(file, "utf8"), file).not.toContain("ß");
    }
    expect(renderDossierMarkdown(proxyReport, { limited: false, bench: coreOf(realBench) })).not.toContain("ß");
  });
});
