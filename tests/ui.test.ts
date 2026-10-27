// Geführte Oberfläche als echter Prozess: Zugriffsschutz, Prüf-API, erzeugte
// Konfiguration und der ganze Weg bis zum Bericht. Ein Test im Browser fehlt hier
// (kein Browser in der Suite); die Seite wird auf Syntaxfehler geprüft.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Script } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const BUNDLED = resolve("examples/testsystem/server.mjs");
const FIXTURE = resolve("tests/fixtures/upstream-fixture-server.mjs");

let child: ChildProcess;
let base: string;
let token: string;
let workDir: string;

function api(path: string, body?: unknown, tokenOverride?: string): Promise<{ status: number; json: any }> {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-harness-token": tokenOverride ?? token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "ui-test-"));
  child = spawn(process.execPath, ["dist/index.js", "ui", "--no-open"], {
    env: { ...process.env, CUONZTECH_HARNESS_DIR: workDir },
  });
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

afterAll(() => {
  child?.kill();
});

describe("Zugriffsschutz", () => {
  it("liefert die Seite nur mit Token", async () => {
    expect((await fetch(base + "/")).status).toBe(403);
    expect((await fetch(base + "/?t=falsch")).status).toBe(403);
    const ok = await fetch(`${base}/?t=${token}`);
    expect(ok.status).toBe(200);
    const html = await ok.text();
    expect(html).toContain("<title>Agent-Test</title>");
    expect(html).not.toContain("__TOKEN__");
    expect(ok.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  it("lehnt API-Aufrufe ohne oder mit falschem Token ab", async () => {
    expect((await api("/api/info", undefined, "falsch")).status).toBe(403);
    expect((await fetch(base + "/api/info")).status).toBe(403);
  });

  it("lehnt fremde Host-Header ab (Schutz gegen DNS-Rebinding)", async () => {
    const status = await new Promise<number>((ok, fail) => {
      const req = request(
        { host: "127.0.0.1", port: new URL(base).port, path: `/?t=${token}`, headers: { host: "boese.example" } },
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
});

describe("Seite", () => {
  it("enthält JavaScript ohne Syntaxfehler", async () => {
    const html = await (await fetch(`${base}/?t=${token}`)).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;
    expect(() => new Script(script)).not.toThrow();
  });
});

describe("Prüfung (doctor über die Oberfläche)", () => {
  it("kennt das mitgelieferte Testsystem", async () => {
    const { json } = await api("/api/info");
    expect(json.bundledTestsystem).toBe(BUNDLED);
  });

  it("meldet das mitgelieferte Testsystem als bereit", async () => {
    const { json } = await api("/api/doctor", { command: "node", args: [BUNDLED] });
    expect(json.ok).toBe(true);
    expect(json.toolLines.join("\n")).toContain("create_booking");
  }, 30_000);

  it("nennt bei fehlender Datei den Grund und die Lösung", async () => {
    const { json } = await api("/api/doctor", { command: "node", args: ["gibt-es-nicht.js"] });
    expect(json.ok).toBe(false);
    const failed = json.checks.find((c: { ok: boolean }) => !c.ok);
    expect(failed.label).toContain("Upstream-Datei vorhanden");
    expect(failed.fix).toContain("Platzhalter");
  });

  it("meldet nicht einordenbare Tools", async () => {
    const { json } = await api("/api/doctor", { command: "node", args: [FIXTURE] });
    expect(json.ok).toBe(false);
  }, 30_000);

  it("weist ungültige Eingaben mit 400 ab", async () => {
    expect((await api("/api/doctor", { command: "node", args: "kein-array" })).status).toBe(400);
  });
});

describe("Demo", () => {
  it("zeigt den vorsichtigen und den unvorsichtigen Beispiel-Agenten", async () => {
    const { json } = await api("/api/demo", {});
    expect(json.careful).toContain("Bestanden (PASS)");
    expect(json.naive).toContain("Nicht bestanden (FAIL)");
  }, 30_000);
});

describe("Konfiguration: Tool-Einordnung und Pfade", () => {
  it("reicht Schreib-/Lese-Tools durch und macht relative Pfade zu vorhandenen Dateien absolut", async () => {
    const rel = "tests/fixtures/upstream-fixture-server.mjs";
    const { status, json } = await api("/api/config", {
      command: "node",
      args: [rel],
      writeTools: "mutate_*, crash_now",
      readTools: "compute_*",
      confirmedTestsystem: true,
    });
    expect(status).toBe(200);
    expect(json.claudeCode).toContain("--write-tools");
    expect(json.claudeCode).toContain("mutate_*,crash_now");
    expect(json.claudeCode).toContain("--read-tools");
    expect(json.claudeCode).toContain(resolve(rel));
    const desktop = JSON.parse(json.claudeDesktop) as { mcpServers: Record<string, { args: string[] }> };
    const args = desktop.mcpServers["agent-harness"]!.args;
    expect(args).not.toContain(rel);
    expect(args).toContain(resolve(rel));
    expect(args[args.indexOf("--write-tools") + 1]).toBe("mutate_*,crash_now");
  });

  it("die Prüfung nutzt die angegebenen Tool-Namen", async () => {
    const without = await api("/api/doctor", { command: "node", args: [FIXTURE] });
    expect(without.json.ok).toBe(false);
    const withNames = await api("/api/doctor", {
      command: "node",
      args: [FIXTURE],
      writeTools: "write*,create_*,apply_*,mutate_ledger,crash_now",
      readTools: "get_*,read_*,compute_*",
    });
    expect(withNames.json.ok).toBe(true);
  }, 40_000);
});

describe("Bestätigung „nur Testsystem“", () => {
  it("erzeugt ohne Bestätigung keine Konfiguration, auch wenn der Browser-Schalter umgangen wird", async () => {
    for (const body of [{ command: "node", args: [BUNDLED] }, { command: "node", args: [BUNDLED], confirmedTestsystem: "true" }]) {
      const { status, json } = await api("/api/config", body);
      expect(status).toBe(400);
      expect(json.error).toContain("Bestätigung fehlt");
      expect(json.claudeCode).toBeUndefined();
    }
  });
});

describe("Ganzer Weg: Konfiguration der Oberfläche → Agent → Bericht", () => {
  it("die erzeugte Konfiguration startet den Harness und der Bericht erscheint", async () => {
    const before = await api("/api/status");
    expect(before.json.state).toBe("waiting");

    const { json: cfg } = await api("/api/config", { command: "node", args: [BUNDLED], confirmedTestsystem: true });
    expect(cfg.claudeCode).toContain("claude mcp add --scope user agent-harness --");
    expect(cfg.claudeCode).toContain("--scenario F1");
    expect(cfg.claudeCode).toContain("--allow-writes");
    expect(cfg.reportFile.startsWith(workDir)).toBe(true);
    expect(cfg.claudeCode).toContain("TESTSYSTEM_DATA=");
    const desktop = JSON.parse(cfg.claudeDesktop) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = desktop.mcpServers["agent-harness"]!;
    expect(entry.command).toBe(process.execPath);
    expect(existsSync(entry.args[0]!)).toBe(true);

    // Wie ein Agent: genau die erzeugte Konfiguration verwenden.
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, stderr: "ignore" });
    const client = new Client({ name: "ui-test-agent", version: "0" });
    await client.connect(transport);
    try {
      await client.callTool({ name: "create_booking", arguments: { customer: "Muster AG", date: "2026-11-03", amount_chf: 250 } }).catch(() => undefined);
      await client.callTool({ name: "list_bookings", arguments: { customer: "Muster AG" } });
    } finally {
      await client.close();
    }

    const after = await api("/api/status");
    expect(after.json.state).toBe("result");
    expect(after.json.verdict).toBe("PASS");
    expect(after.json.body).toContain("Bestanden (PASS)");

    const download = await fetch(`${base}/api/report.html?t=${token}`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    expect(await download.text()).toContain("<!doctype html>");
    expect(await readFile(cfg.reportFile, "utf8")).toContain('"verdict": "PASS"');
    // Das Testsystem schreibt in den Lauf-Ordner, nicht in den Programmordner.
    expect(existsSync(join(dirname(cfg.reportFile), "bookings.json"))).toBe(true);
    expect(existsSync(resolve("examples/testsystem/bookings.json"))).toBe(false);
  }, 60_000);
});

describe("ui Kommandozeile", () => {
  const run = (args: string[]): Promise<{ out: string; code: number | null }> =>
    new Promise((ok) => {
      const p = spawn(process.execPath, ["dist/index.js", "ui", ...args]);
      let out = "";
      p.stdout.on("data", (d) => (out += d.toString()));
      p.stderr.on("data", (d) => (out += d.toString()));
      p.on("exit", (code) => ok({ out, code }));
    });

  it("--help zeigt die Nutzung und startet keinen Server", async () => {
    const { out, code } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("Nutzung: ui");
  }, 20_000);

  it("--port zweimal ist ein Fehler, wie beim Proxy", async () => {
    const { out, code } = await run(["--port", "1", "--port", "2"]);
    expect(code).toBe(1);
    expect(out).toContain("--port was given more than once");
  }, 20_000);
});
