// AP 5: die vier offenen Punkte des 0.7.0-Release-Gates und die Auto-Erkennung
// bereits konfigurierter MCP-Server in der Oberfläche. CLI und Oberfläche laufen
// als echte Prozesse gegen das gebaute dist/ (braucht pretest).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findUnforwardable } from "../src/proxy/guarded-stdio.js";

const ESZETT = String.fromCharCode(0xdf);
const BUNDLED = resolve("examples/testsystem/server.mjs");
const SECRET = "sk-geheim-9f8e7d6c";

function cli(args: string[]): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((ok) => {
    const p = spawn(process.execPath, ["dist/index.js", ...args]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => ok({ out, err, code }));
  });
}

describe("Release-Gate 1: report --out gegen reservierte Dateinamen", () => {
  let dir: string;
  let reportFile: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "ap5-report-"));
    reportFile = join(dir, "harness-report.json");
    await writeFile(reportFile, JSON.stringify({ harnessVersion: "0", verdict: "NOT_TESTED", status: "starting" }));
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it.runIf(process.platform === "win32")("lehnt NUL und x:y.md ab (Exit 1)", async () => {
    for (const bad of ["NUL", "foo:bar.md", "report.", "CON.md"]) {
      const r = await cli(["report", reportFile, "--out", bad]);
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain(`--out "${bad}" contains a reserved device name or a ":", or ends in a dot or space, and is not a usable file.`);
    }
  });

  // "x:y.md" liest der Wächter als Laufwerk x: plus Datei y.md; das Ziel scheitert dann am fehlenden Laufwerk, ebenfalls mit Exit 1.
  it.runIf(process.platform === "win32")("lehnt x:y.md ab (Exit 1), ohne eine Datei anzulegen", async () => {
    const r = await cli(["report", reportFile, "--out", "x:y.md"]);
    expect(r.code).toBe(1);
    expect(existsSync("x:y.md")).toBe(false);
  });

  it("schreibt mit einem gewöhnlichen Dateinamen weiterhin", async () => {
    const out = join(dir, "bericht.md");
    const r = await cli(["report", reportFile, "--out", out]);
    expect(r.code, r.err).toBe(0);
    expect((await readFile(out, "utf8")).length).toBeGreaterThan(0);
  });
});

describe("Release-Gate 3: Zahlenschutz in findUnforwardable", () => {
  it.each([
    "9007199254740993.0",
    "9007199254740993E0",
    "90071992547409930e-1",
    "9.007199254740993e15",
    "9.007199254740993e+15",
    "1e400",
    "-1e400",
    "-9007199254740993.0",
    "123456789012345678901234567890",
  ])("lehnt %s ab und nennt 2^53", (token) => {
    const reasons = findUnforwardable(`{"a":${token}}`);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("2^53");
  });

  it.each(["0.1234567890123456789", "1e-400"])("lehnt die nicht darstellbare Dezimalzahl %s ab", (token) => {
    expect(findUnforwardable(`{"a":${token}}`)).toHaveLength(1);
  });

  it.each([
    "1.5",
    "1e3",
    "0.1",
    "129.95",
    "9007199254740992.0",
    "9007199254740992",
    "-9007199254740991.0",
    "9.007199254740992e15",
    "0",
    "-0",
    "0.0",
    "0e5",
    "100",
    "1.0e2",
    "123.456e-2",
    "0.30000000000000004",
    "5e-324",
  ])("lässt %s durch", (token) => {
    expect(findUnforwardable(`{"a":${token}}`)).toEqual([]);
  });

  it("prüft jedes Token, auch in Listen, und ignoriert Zahlen in Zeichenketten", () => {
    expect(findUnforwardable('{"a":[1,2.5,9007199254740993.0]}')).toHaveLength(1);
    expect(findUnforwardable('{"a":"9007199254740993.0 und 1e400"}')).toEqual([]);
  });
});

describe("Release-Gate 4: Ausführungsrecht der Start-Datei", () => {
  it("steht im Git-Index als 100755", () => {
    const entry = execFileSync("git", ["ls-files", "-s", "launchers/start-agent-harness.sh"], { encoding: "utf8" });
    expect(entry.startsWith("100755 ")).toBe(true);
  });
});

describe("UI: Startfehler und Auto-Erkennung", () => {
  let child: ChildProcess;
  let base: string;
  let token: string;
  let workDir: string;

  function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
    return fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-harness-token": token, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, json: await r.json() }));
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ap5-ui-"));
    const configPath = join(workDir, "mcp-config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          fremd: { command: "node", args: ["C:\\mein server\\server.js", "--flag"], env: { API_KEY: SECRET }, headers: { Authorization: SECRET } },
          "agent-harness": { command: "npx", args: ["-y", "cuonztech-agent-harness", "proxy"] },
          "cuonztech-agent-harness": { command: "node", args: ["x.js"] },
          eingewickelt: { command: "npx", args: ["-y", "cuonztech-agent-harness", "proxy"], env: { K: SECRET } },
          ohneCommand: { args: ["a"] },
          zweiter: { command: "python", args: ["srv.py", 5, "-v"], url: SECRET },
        },
      }),
    );
    // Heimatordner und APPDATA umlenken, damit echte Nutzerkonfigurationen nicht in den Test geraten.
    const env = { ...process.env, CUONZTECH_HARNESS_DIR: workDir, CUONZTECH_MCP_CONFIG_PATH: configPath, HOME: workDir, USERPROFILE: workDir, APPDATA: workDir };
    child = spawn(process.execPath, ["dist/index.js", "ui", "--no-open"], { env });
    const line = await new Promise<string>((ok, fail) => {
      let out = "";
      child.stdout!.on("data", (d) => {
        out += d.toString();
        const m = out.match(/Oberfläche: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/);
        if (m) ok(m[1]!);
      });
      child.on("exit", () => fail(new Error("ui exited early: " + out)));
      setTimeout(() => fail(new Error("ui did not start: " + out)), 15_000);
    });
    const url = new URL(line);
    base = url.origin;
    token = url.searchParams.get("t")!;
  }, 30_000);
  afterAll(async () => {
    child?.kill();
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it("/api/info nennt fremde Server mit genau name, source, command, args", async () => {
    const info = await api("/api/info");
    expect(info.status).toBe(200);
    const found = info.json.discoveredServers as Array<Record<string, unknown>>;
    expect(found.map((s) => s.name).sort()).toEqual(["fremd", "zweiter"]);
    const fremd = found.find((s) => s.name === "fremd")!;
    expect(Object.keys(fremd).sort()).toEqual(["args", "command", "name", "source"]);
    expect(fremd.command).toBe("node");
    expect(fremd.args).toEqual(["C:\\mein server\\server.js", "--flag"]);
    expect(fremd.source).toBe("Eigene Konfiguration");
    // Nicht-Zeichenketten in args werden verworfen.
    expect(found.find((s) => s.name === "zweiter")!.args).toEqual(["srv.py", "-v"]);
  });

  it("gibt weder env noch Header noch Geheimnisse zurück und wickelt den Harness nicht ein", async () => {
    const raw = await (await fetch(`${base}/api/info?t=${token}`)).text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("API_KEY");
    expect(raw).not.toContain("eingewickelt");
    expect(raw).not.toContain("agent-harness");
  });

  it("die Seite enthält Auswahlbox und Übernahme für Schritt 3", async () => {
    const html = await (await fetch(`${base}/?t=${token}`)).text();
    expect(html).toContain("Gefundene MCP-Server auf diesem Rechner (1-Klick-Übernahme):");
    expect(html).toContain('id="discoveredList"');
    expect(html).toContain("Startfehler beim Verbinden des Testservers:");
  });

  it("/api/status meldet einen Startfehler als state error samt Text", async () => {
    const cfg = await api("/api/config", { command: "node", args: [BUNDLED], confirmedTestsystem: true });
    expect(cfg.status).toBe(200);
    const reportFile = cfg.json.reportFile as string;

    await writeFile(reportFile, JSON.stringify({ harnessVersion: "0", status: "starting" }));
    expect((await api("/api/status")).json.state).toBe("connected");

    await writeFile(reportFile, JSON.stringify({ harnessVersion: "0", startupError: "Upstream konnte nicht gestartet werden: ENOENT" }));
    const status = await api("/api/status");
    expect(status.json.state).toBe("error");
    expect(status.json.startupError).toBe("Upstream konnte nicht gestartet werden: ENOENT");
    expect(status.json.body).toContain("ENOENT");

    await writeFile(reportFile, JSON.stringify({ harnessVersion: "0", status: "starting", startupError: "" }));
    expect((await api("/api/status")).json.state).toBe("connected");
  });
});

describe("Schweizer Rechtschreibung in den geänderten Dateien", () => {
  it.each([
    "src/plain-report.ts",
    "src/proxy/guarded-stdio.ts",
    "src/ui/server.ts",
    "src/ui/page.ts",
    "src/ui/discover.ts",
    "README.md",
    "tests/ap5-release-gate-and-discovery.test.ts",
  ])("%s enthält kein Eszett", async (file) => {
    expect((await readFile(file, "utf8")).includes(ESZETT)).toBe(false);
  });

  // CHANGELOG und STAND enthalten ältere Einträge (zum Beispiel ein Zitat der alten Schreibweise);
  // geprüft werden die in AP 5 ergänzten Zeilen.
  it.each([
    ["CHANGELOG.md", ["discoveredServers", "report --out", "startupError", "Zahlenschutz", "start-agent-harness.sh"]],
    ["STAND.md", ["AP 5"]],
  ])("%s: die Zeilen von AP 5 enthalten kein Eszett", async (file, markers) => {
    const lines = (await readFile(file as string, "utf8")).split("\n").filter((l) => (markers as string[]).some((m) => l.includes(m)));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.includes(ESZETT), line.slice(0, 80)).toBe(false);
  });
});
