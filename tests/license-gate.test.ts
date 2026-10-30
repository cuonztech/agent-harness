// Lizenz-Sperre (analog CPCG): Der Lauf ist immer vollständig, nur die Ausgabe wird gekürzt oder ein
// Pro-Befehl bricht mit einem klaren Hinweis ab. Geprüft werden alle Zustände (keine Lizenz, gültig,
// abgelaufen, ungültig, falsches Format) gegen die echten Befehle des gebauten dist/.
//
// Test-Lizenzen: eigenes Schlüsselpaar und der Test-Schlüssel-Override (AGENT_AUDIT_LICENSE_PUBLIC_KEY),
// wie in tests/license.test.ts. Der Signierschlüssel des Lizenzdienstes kommt nicht vor.
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { generateLicenseKeyPair, signLicense, type LicenseClaims } from "../src/license/index.js";
import {
  PRO_FEATURES,
  PURCHASE_URL,
  lockedNotice,
  reasonSentence,
  reduceSchemaAudit,
  resolveProGate,
  shortenedNotice,
} from "../src/license/gate.js";
import { verifyReportIntegrity } from "../src/core/artifact-integrity.js";
import { renderDossierMarkdown } from "../src/dossier-report.js";
import { renderMarkdown, type ReportFile } from "../src/plain-report.js";

const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";
const NOW = Math.floor(Date.now() / 1000);

const { seed, publicKey } = generateLicenseKeyPair();
const other = generateLicenseKeyPair();

const TOKENS = {
  // Neue Form: undurchsichtige Kennung, keine E-Mail im Code.
  pro: signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro", exp: NOW + 3600 }, seed),
  // Alte Form: E-Mail im sub (und im Claim eml). Muss weiter gelten.
  proLegacy: signLicense({ sub: "kunde@beispiel.test", eml: "kunde@beispiel.test", tier: "pro", exp: NOW + 3600 }, seed),
  expired: signLicense({ sub: "kunde@beispiel.test", tier: "pro", exp: NOW - 86_400 * 3 }, seed),
  // Mit fremdem Schlüssel signiert: Format stimmt, Signatur nicht.
  wrongKey: signLicense({ sub: "kunde@beispiel.test", tier: "pro", exp: NOW + 3600 }, other.seed),
  badFormat: "IRGENDWAS-123",
  // Gültig signiert, aber ohne Ablaufdatum: ungültig.
  noExp: signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro" } as unknown as LicenseClaims, seed),
  // Schlüssel von Privacy Chaos Gate (Präfix CPCG-, eigene Signaturdomäne): berechtigen nicht.
  cpcg: `CPCG-${signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro", exp: NOW + 3600 }, seed, "cpcg-license-v1").slice("CAUDIT-".length)}`,
  // CAUDIT-Präfix, aber mit der Signaturdomäne von CPCG signiert: keine Domain-Vermischung.
  crossDomain: signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro", exp: NOW + 3600 }, seed, "cpcg-license-v1"),
};

type State = "none" | "expired" | "wrongKey" | "badFormat" | "noExp" | "cpcg" | "crossDomain";
const BLOCKED: Array<{ state: State; reason: RegExp }> = [
  { state: "none", reason: /keine Lizenz hinterlegt/ },
  { state: "expired", reason: /abgelaufen/ },
  { state: "wrongKey", reason: /Signatur/ },
  { state: "badFormat", reason: /Lizenzformat/ },
  { state: "noExp", reason: /Ablaufdatum fehlt/ },
  { state: "cpcg", reason: /CPCG-Schlüssel/ },
  { state: "crossDomain", reason: /Signatur/ },
];

/** Umgebung eines Kindprozesses: keine Lizenzangabe der Suite, nur was hier gesetzt wird. */
function envFor(token?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["AGENT_AUDIT_LICENSE", "CUONZTECH_LICENSE_KEY", "CPCG_LICENSE_KEY", "AGENT_AUDIT_LICENSE_PUBLIC_KEY", "CPCG_LICENSE_PUBLIC_KEY", "AGENT_AUDIT_SUPPRESS_LICENSE_HINT"]) {
    delete env[key];
  }
  if (token !== undefined) {
    env.AGENT_AUDIT_LICENSE = token;
    env.AGENT_AUDIT_LICENSE_PUBLIC_KEY = publicKey;
    env.AGENT_AUDIT_ALLOW_TEST_KEY = "1";
  }
  return env;
}

function tokenOf(state: "pro" | "proLegacy" | State): string | undefined {
  return state === "none" ? undefined : TOKENS[state];
}

interface Run {
  out: string;
  err: string;
  code: number | null;
}

function cli(args: string[], token?: string, stdin = ""): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], { env: envFor(token) });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("exit", (code) => resolve({ out, err, code }));
    child.stdin.end(stdin);
  });
}

/** Startet den Proxy, wartet auf seine Bereitschaft, schliesst dann stdin und gibt Exit-Code und Ausgaben zurück. */
function proxyRun(args: string[], token?: string): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", ...args], { env: envFor(token) });
    let out = "";
    let err = "";
    let closed = false;
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => {
      err += d.toString();
      if (!closed && err.includes("Only tools are proxied")) {
        closed = true;
        setTimeout(() => child.stdin.end(), 200);
      }
    });
    child.on("exit", (code) => resolve({ out, err, code }));
  });
}

const PROXY_ARGS = (reportFile: string): string[] => [
  "proxy",
  "--upstream-command", process.execPath,
  "--upstream-arg", FIXTURE,
  "--scenario", "F1",
  "--allow-writes",
  "--audit-tools", "off",
  "--report-file", reportFile,
];

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<unknown> {
  try {
    return await client.callTool({ name, arguments: args });
  } catch {
    return undefined; // der eingespielte Timeout darf als Fehler ankommen
  }
}

/** Ein FAIL-Lauf: Timeout gesehen, derselbe Schreibvorgang gleich nochmal ohne nachzusehen. */
async function blindRetryRun(reportFile: string, token?: string, extra: string[] = []): Promise<{ scoreText: string }> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const [k, v] of Object.entries(envFor(token))) {
    if (v !== undefined && k.startsWith("AGENT_AUDIT_")) env[k] = v;
  }
  const args = ["dist/index.js", ...PROXY_ARGS(reportFile)];
  // Mit --audit-tools on, damit cuonztech__get_score erreichbar ist.
  if (extra.includes("audit-on")) args.splice(args.indexOf("--audit-tools"), 2, "--audit-tools", "on");
  const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: "ignore" });
  const client = new Client({ name: "license-gate-test", version: "0" });
  await client.connect(transport);
  let scoreText = "";
  try {
    await call(client, "write_payment", { amount: 5 });
    await call(client, "write_payment", { amount: 5 });
    if (extra.includes("audit-on")) {
      const res = (await call(client, "cuonztech__get_score", { format: "json" })) as { content?: Array<{ text?: string }> } | undefined;
      scoreText = res?.content?.[0]?.text ?? "";
    }
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    await client.close();
  }
  return { scoreText };
}

let dir: string;
let freeFile: string;
let proFile: string;
let freeScoreText = "";
let proScoreText = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "license-gate-"));
  freeFile = join(dir, "free.json");
  proFile = join(dir, "pro.json");
  freeScoreText = (await blindRetryRun(freeFile, undefined, ["audit-on"])).scoreText;
  proScoreText = (await blindRetryRun(proFile, TOKENS.pro, ["audit-on"])).scoreText;
}, 90_000);

const readJson = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));

describe("freier Umfang: der Lauf ist mit und ohne Lizenz derselbe", () => {
  it("Urteil, Score und gemessene Vorgänge sind identisch", async () => {
    const free = await readJson(freeFile);
    const pro = await readJson(proFile);
    expect(free.verdict).toBe("FAIL");
    expect(pro.verdict).toBe("FAIL");
    expect(free.score).toEqual(pro.score);
    expect(free.report.verdict).toBe(pro.report.verdict);
    expect(free.report.totalCalls).toBe(pro.report.totalCalls);
    expect(free.report.violations).toEqual(pro.report.violations);
    expect(free.report.operations.map((o: any) => [o.tool, o.attempts, o.executions, o.outcome])).toEqual(
      pro.report.operations.map((o: any) => [o.tool, o.attempts, o.executions, o.outcome]),
    );
    expect(free.toolClassification).toEqual(pro.toolClassification);
    expect(free.report.operations.some((o: any) => o.executions === 2)).toBe(true);
  });

  it("ohne Lizenz fehlen nur die Pro-Teile: Textbausteine und Schema-Befunde", async () => {
    const free = await readJson(freeFile);
    expect(free.limitedByLicense).toBe(true);
    expect(free.licenseNotice).toContain("Keine gültige Lizenz");
    expect(free.licenseNotice).toContain(PURCHASE_URL);
    expect(free.patches).toBeUndefined();
    expect(free.recommended_prompt_patch_de).toBeUndefined();
    expect(free.schema_audit.totalTools).toBeGreaterThan(5);
    expect(free.schema_audit.summaryDe).not.toBe("");
    for (const tool of free.schema_audit.tools) {
      expect(tool.findingsDe).toEqual([]);
      expect(tool.recommendedSchemaPatch).toBeNull();
    }
    // Der Integritäts-Nachweis gilt für die geschriebene Fassung.
    expect(verifyReportIntegrity(free).valid).toBe(true);
  });

  it("mit gültiger Lizenz stehen Textbausteine und Schema-Befunde in der Datei", async () => {
    const pro = await readJson(proFile);
    expect(pro.limitedByLicense).toBeUndefined();
    expect(pro.patches.map((p: any) => p.category)).toEqual(["GHOST_WRITE"]);
    expect(pro.recommended_prompt_patch_de).toContain("Timeout");
    expect(pro.schema_audit.tools.some((t: any) => t.findingsDe.length > 0)).toBe(true);
    expect(pro.schema_audit.tools.some((t: any) => t.recommendedSchemaPatch !== null)).toBe(true);
    expect(verifyReportIntegrity(pro).valid).toBe(true);
  });

  it("cuonztech__get_score: gleicher Score, ohne Lizenz ohne Textbausteine", () => {
    const free = JSON.parse(freeScoreText);
    const pro = JSON.parse(proScoreText);
    expect(free.score).toEqual(pro.score);
    expect(free.patches).toEqual([]);
    expect(free.limitedByLicense).toBe(true);
    expect(pro.patches.map((p: any) => p.category)).toEqual(["GHOST_WRITE"]);
  });

  it("der Proxy meldet den Lizenzzustand auf stderr und endet mit Exit 0, mit und ohne Lizenz", async () => {
    const free = await proxyRun(PROXY_ARGS(join(dir, "exit-free.json")));
    const pro = await proxyRun(PROXY_ARGS(join(dir, "exit-pro.json")), TOKENS.pro);
    expect(free.code).toBe(0);
    expect(pro.code).toBe(0);
    expect(free.err).toContain("Keine gültige Lizenz: Es ist keine Lizenz hinterlegt.");
    expect(free.err).toContain("Urteil, Score und Exit-Code sind echt");
    expect(pro.err).toContain("Lizenz: gültig (Pro-Umfang).");
    expect(pro.err).not.toContain("Keine gültige Lizenz");
  });

  it("eine ungültige Lizenz bricht den Proxy-Lauf nicht ab, sie kürzt nur die Datei", async () => {
    for (const { state, reason } of BLOCKED) {
      const file = join(dir, `proxy-${state}.json`);
      const run = await proxyRun(PROXY_ARGS(file), tokenOf(state));
      expect(run.code, state).toBe(0);
      expect(run.err, state).toMatch(reason);
      expect((await readJson(file)).limitedByLicense, state).toBe(true);
    }
  });

  it("falsche Argumente enden mit Exit 1, mit und ohne Lizenz", async () => {
    const bad = ["proxy", "--upstream-command", process.execPath, "--scenaro", "F1"];
    expect((await cli(bad)).code).toBe(1);
    expect((await cli(bad, TOKENS.pro)).code).toBe(1);
  });

  it("doctor ist vollständig frei und gibt mit und ohne Lizenz dasselbe aus", async () => {
    const args = ["doctor", "--upstream-command", process.execPath, "--upstream-arg", FIXTURE];
    const free = await cli(args);
    const pro = await cli(args, TOKENS.pro);
    // Der Fixture-Server hat nicht einordenbare Tools: doctor meldet das mit Exit 1 (Absicht), mit und ohne Lizenz gleich.
    expect(free.code).toBe(pro.code);
    expect(free.out).toBe(pro.out);
    expect(free.out).toContain("Schnittstellen-Prüfung (nur Schema, nichts wurde aufgerufen):");
    expect(free.out).not.toContain("Keine gültige Lizenz");
  });

  it("der Selbsttest benchmark bleibt frei", async () => {
    const run = await cli(["benchmark", "--scenarios", "F1"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("Self-test PASSED");
  });

  it("der Kompaktbericht report (ohne --dossier) zeigt Urteil, Score und Beobachtungen vollständig, auch ohne Lizenz", async () => {
    const free = await cli(["report", freeFile]);
    const pro = await cli(["report", proFile], TOKENS.pro);
    for (const run of [free, pro]) {
      expect(run.code).toBe(0);
      expect(run.out).toContain("## Nicht bestanden (FAIL)");
      expect(run.out).toContain("2× ausgeführt");
      expect(run.out).toMatch(/Resilience Score: \*\*\d+ \/ 100\*\*/);
    }
    expect(pro.out).toContain("## Was zu tun ist");
    expect(pro.out).toContain("GHOST_WRITE");
    expect(free.out).toContain("## Härtungsvorschläge");
    expect(free.out).toContain("gehören zum Pro-Umfang");
    expect(free.out).not.toContain("GHOST_WRITE");
    expect(free.out).not.toContain("## Was zu tun ist");
  });

  it("derselbe Bericht aus einer Pro-Datei wird ohne Lizenz beim Anzeigen gekürzt", async () => {
    const run = await cli(["report", proFile]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("gehören zum Pro-Umfang");
    expect(run.out).not.toContain("GHOST_WRITE");
    expect(run.out).not.toContain("Vorschlag für das Schema");
    expect(run.out).toContain("## Nicht bestanden (FAIL)");
  });
});

describe("report --dossier", () => {
  it("ein Code der alten Form (E-Mail im sub) gilt weiter und wird als PRO (<sub>) ausgewiesen", async () => {
    const run = await cli(["report", proFile, "--dossier"], TOKENS.proLegacy);
    expect(run.code).toBe(0);
    expect(run.out).toContain("PRO (kunde@beispiel.test)");
    expect(run.out).toContain("5. Empfohlenes Härtungspaket");
  });

  it("mit gültiger Lizenz: volles Dossier, Status PRO, kein Hinweis", async () => {
    const run = await cli(["report", proFile, "--dossier"], TOKENS.pro);
    expect(run.code).toBe(0);
    expect(run.out).toContain("PRO (H-3f9a1c0b7d42)");
    expect(run.out).not.toContain("beispiel.test");
    expect(run.out).toContain("Integrität bestätigt");
    expect(run.out).toContain("1. Management Summary & Geschäftsrisiko-Matrix");
    expect(run.out).toContain("5. Empfohlenes Härtungspaket");
    expect(run.out).not.toContain("EVALUATION");
    expect(run.err).not.toContain("Keine gültige Lizenz");
  });

  for (const { state, reason } of BLOCKED) {
    it(`ohne gültige Lizenz (${state}): gekürztes Dossier mit Kopf, Score und Urteil, Hinweis nennt den Grund, Exit 0`, async () => {
      const run = await cli(["report", proFile, "--dossier"], tokenOf(state));
      expect(run.code).toBe(0);
      // Hinweis auf stderr: Funktion, Grund, was frei bleibt, Kaufziel.
      expect(run.err).toContain("Keine gültige Lizenz: Das Prüf-Dossier (report --dossier) gehört zum Pro-Umfang.");
      expect(run.err).toMatch(reason);
      expect(run.err).toContain("Frei bleiben: MCP-Chaos-Proxy");
      expect(run.err).toContain("https://cuonztech.ch/agent-harness.html#audit");
      expect(run.err).not.toContain("cuonztech.ch/agent-audit");
      // Dokument: echter Kopf, echtes Urteil, echter Score.
      expect(run.out).toContain("Technisches Prüf- & Architektur-Dossier");
      expect(run.out).toMatch(/Gesamturteil: /);
      expect(run.out).toMatch(/Resilience Score: \*\*\d+ \/ 100\*\*/);
      expect(run.out).toContain("EVALUATION (keine gültige Lizenz, gekürzte Fassung");
      expect(run.out).toContain("Urteil je Szenario");
      expect(run.out).toContain("F1");
      expect(run.out).toContain("FAIL");
      // Details nur mit Lizenz.
      for (const heading of ["1. Management Summary", "2. Schnittstellen- & Schema-Gutachten", "5. Empfohlenes Härtungspaket", "6. Kryptografischer Integritäts-Nachweis", "System-Prompt-Baustein", "Integrität bestätigt"]) {
        expect(run.out, heading).not.toContain(heading);
      }
      expect(run.out).not.toContain("PRO (");
    });
  }

  it("das gekürzte Dossier als HTML und in eine Datei geschrieben: gleiche Aussage, Marker bleibt, Datei lässt sich ersetzen", async () => {
    const target = join(dir, "dossier-free.html");
    const first = await cli(["report", proFile, "--dossier", "--format", "html", "--out", target]);
    expect(first.code).toBe(0);
    const html = await readFile(target, "utf8");
    expect(html).toContain("Urteil je Szenario");
    expect(html).toContain("Gekürzte Fassung ohne Lizenz");
    expect(html).not.toContain('id="integrity"');
    // Mit Lizenz darf dasselbe Ziel wieder ersetzt werden (Marker bleibt erhalten) und wird zum vollen Dossier.
    const second = await cli(["report", proFile, "--dossier", "--format", "html", "--out", target], TOKENS.pro);
    expect(second.code).toBe(0);
    expect(await readFile(target, "utf8")).toContain('id="integrity"');
  });

  it("der Hinweis lässt sich mit AGENT_AUDIT_SUPPRESS_LICENSE_HINT ausblenden, das Dokument bleibt gekürzt", async () => {
    const env = { ...envFor(), AGENT_AUDIT_SUPPRESS_LICENSE_HINT: "1" };
    const run = await new Promise<Run>((resolve) => {
      const child = spawn(process.execPath, ["dist/index.js", "report", proFile, "--dossier"], { env });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d.toString()));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("exit", (code) => resolve({ out, err, code }));
    });
    expect(run.err).toBe("");
    expect(run.out).toContain("Urteil je Szenario");
  });
});

describe("ui und campaign: Pro-Befehle", () => {
  for (const { state, reason } of BLOCKED) {
    it(`ui ohne gültige Lizenz (${state}): klarer Hinweis, Exit 1, kein Start`, async () => {
      const run = await cli(["ui", "--no-open"], tokenOf(state));
      expect(run.code).toBe(1);
      expect(run.out).toBe("");
      expect(run.err).toContain("Keine gültige Lizenz: Die geführte Web-Oberfläche (ui) gehört zum Pro-Umfang.");
      expect(run.err).toMatch(reason);
      expect(run.err).toContain("Frei bleiben:");
      expect(run.err).toContain("Lizenz: https://cuonztech.ch/agent-harness.html#audit");
      expect(run.err).not.toContain("Error:");
    });

    it(`campaign ohne gültige Lizenz (${state}): klarer Hinweis, Exit 1, keine Datei`, async () => {
      const target = join(dir, `campaign-${state}.md`);
      const run = await cli(["campaign", "--out", target], tokenOf(state));
      expect(run.code).toBe(1);
      expect(run.out).toBe("");
      expect(run.err).toContain("Keine gültige Lizenz: Der Kampagnen-Runner (campaign) gehört zum Pro-Umfang.");
      expect(run.err).toMatch(reason);
      expect(run.err).toContain("Lizenz: https://cuonztech.ch/agent-harness.html#audit");
      await expect(stat(target)).rejects.toThrow();
    });
  }

  it("campaign mit gültiger Lizenz (Umgebung und --license) läuft vollständig", async () => {
    const viaEnv = await cli(["campaign"], TOKENS.pro);
    expect(viaEnv.code).toBe(0);
    expect(viaEnv.out.length).toBeGreaterThan(500);
    expect(viaEnv.err).toBe("");
    const viaFlag = await cli(["campaign", "--license", TOKENS.pro], TOKENS.pro);
    expect(viaFlag.code).toBe(0);
  });

  it("falsche Argumente werden vor dem Lizenzhinweis gemeldet (Exit 1, Fehlertext)", async () => {
    const run = await cli(["campaign", "--runs", "0"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("--runs must be a positive integer");
    const ui = await cli(["ui", "--port", "abc"]);
    expect(ui.code).toBe(1);
    expect(ui.err).toContain("--port must be a number");
  });

  it("--license ohne Wert ist ein Argumentfehler", async () => {
    const run = await cli(["campaign", "--license"]);
    expect(run.code).toBe(1);
    expect(run.err).toContain("--license needs a key");
  });

  it("ui mit gültiger Lizenz startet und meldet sie in /api/info", async () => {
    const child = spawn(process.execPath, ["dist/index.js", "ui", "--no-open"], { env: envFor(TOKENS.pro) });
    try {
      const url = await new Promise<string>((ok, fail) => {
        let out = "";
        child.stdout.on("data", (d) => {
          out += d.toString();
          const m = out.match(/Oberfläche: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/);
          if (m) ok(m[1]!);
        });
        child.on("exit", () => fail(new Error("ui exited early")));
        setTimeout(() => fail(new Error("ui did not start")), 15_000);
      });
      const u = new URL(url);
      const info = (await (await fetch(`${u.origin}/api/info?t=${u.searchParams.get("t")}`)).json()) as { license: { valid: boolean; tier: string } };
      expect(info.license.valid).toBe(true);
      expect(info.license.tier).toBe("pro");
    } finally {
      child.kill();
    }
  });
});

describe("Bausteine der Sperre", () => {
  it("jede Pro-Funktion ist beschrieben, mit Umfang und was frei bleibt", () => {
    expect(Object.keys(PRO_FEATURES).sort()).toEqual(["campaign", "dossier", "hardening", "schema-audit", "ui"]);
    for (const f of Object.values(PRO_FEATURES)) {
      expect(f.name.length).toBeGreaterThan(5);
      expect(["gesperrt", "gekürzt"]).toContain(f.mode);
      expect(f.free.length).toBeGreaterThan(5);
    }
    // Gesperrt sind nur die Befehle, die sich nicht sinnvoll kürzen lassen.
    expect(Object.entries(PRO_FEATURES).filter(([, f]) => f.mode === "gesperrt").map(([k]) => k).sort()).toEqual(["campaign", "ui"]);
  });

  it("resolveProGate liest --license vor der Umgebung und kennt den Grund", () => {
    const keys = ["AGENT_AUDIT_LICENSE", "AGENT_AUDIT_LICENSE_PUBLIC_KEY", "AGENT_AUDIT_ALLOW_TEST_KEY", "CUONZTECH_LICENSE_KEY", "CPCG_LICENSE_KEY"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      process.env.AGENT_AUDIT_LICENSE_PUBLIC_KEY = publicKey;
      process.env.AGENT_AUDIT_ALLOW_TEST_KEY = "1";
      process.env.AGENT_AUDIT_LICENSE = TOKENS.expired;
      expect(resolveProGate().pro).toBe(false);
      expect(resolveProGate(TOKENS.pro).pro).toBe(true);
      delete process.env.AGENT_AUDIT_LICENSE;
      delete process.env.CUONZTECH_LICENSE_KEY;
      delete process.env.CPCG_LICENSE_KEY;
      const none = resolveProGate();
      expect(none.pro).toBe(false);
      expect(reasonSentence(none.verdict)).toBe("Es ist keine Lizenz hinterlegt.");
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it("reasonSentence lässt die alte Adresse weg und nennt den Grund in einem Satz", () => {
    const expired = { valid: false, reason: `Lizenz ist am 2026-01-01 abgelaufen. Verlängerung unter https://cuonztech.ch/agent-audit` };
    expect(reasonSentence(expired)).toBe("Ihre Lizenz ist nicht gültig: Lizenz ist am 2026-01-01 abgelaufen.");
    const none = { valid: false, reason: "Kein Lizenzschlüssel angegeben. Lizenzen erhältlich unter https://cuonztech.ch/agent-audit" };
    expect(reasonSentence(none)).toBe("Es ist keine Lizenz hinterlegt.");
  });

  it("die Hinweise haben die vereinbarte Form und nur das neue Kaufziel", () => {
    const verdict = { valid: false, reason: "Nicht lizenziert" };
    const locked = lockedNotice("ui", verdict);
    expect(locked).toMatch(/^Keine gültige Lizenz: Die geführte Web-Oberfläche \(ui\) gehört zum Pro-Umfang\./);
    expect(locked).toContain("Frei bleiben: MCP-Chaos-Proxy mit den Szenarien F1 bis F5");
    expect(locked).toContain(`Lizenz: ${PURCHASE_URL}`);
    const shortened = shortenedNotice("dossier", verdict);
    expect(shortened).toContain("Die Ausgabe ist gekürzt; der Lauf, das Urteil und der Exit-Code sind echt.");
    for (const text of [locked, shortened]) {
      expect(text).not.toContain("cuonztech.ch/agent-audit");
      expect(text).not.toMatch(/Zertifikat|revisionssicher|garantiert|unabhängige Prüfung/i);
      expect(text).not.toMatch(/\+?\d{2}[ ]?\d{2,3}[ ]?\d{3}[ ]?\d{2}[ ]?\d{2}/);
    }
  });

  it("Bibliotheksaufrufe ohne Angabe rendern voll; mit limited/pro=false gekürzt", async () => {
    const free = await readJson(freeFile);
    const pro = (await readJson(proFile)) as ReportFile;
    expect(renderDossierMarkdown(pro)).toContain("6. Kryptografischer Integritäts-Nachweis");
    expect(renderDossierMarkdown(pro, { limited: true })).not.toContain("6. Kryptografischer Integritäts-Nachweis");
    expect(renderMarkdown(pro)).toContain("GHOST_WRITE");
    expect(renderMarkdown(pro, { pro: false })).not.toContain("GHOST_WRITE");
    expect(renderMarkdown(free, { pro: false })).toContain("Härtungsvorschläge");
  });

  it("reduceSchemaAudit lässt Zusammenfassung und Risikostufe, entfernt Befunde und Schema-Vorschlag", async () => {
    const pro = await readJson(proFile);
    const reduced = reduceSchemaAudit(pro.schema_audit);
    expect(reduced.summaryDe).toBe(pro.schema_audit.summaryDe);
    expect(reduced.tools.map((t: any) => [t.name, t.riskLevel])).toEqual(pro.schema_audit.tools.map((t: any) => [t.name, t.riskLevel]));
    expect(reduced.tools.every((t: any) => t.findingsDe.length === 0 && t.recommendedSchemaPatch === null)).toBe(true);
    // Das Original bleibt unverändert.
    expect(pro.schema_audit.tools.some((t: any) => t.findingsDe.length > 0)).toBe(true);
  });

  it("eine Datei ohne Bericht führt ohne Lizenz nicht zum Absturz", async () => {
    const empty = join(dir, "empty.json");
    await writeFile(empty, "{}", "utf8");
    const run = await cli(["report", empty, "--dossier"]);
    expect(run.code).toBe(1);
    expect(run.err).not.toContain("TypeError");
  });
});
