// Führt die Befehle aus dem Quickstart der README wirklich aus (gegen den
// Fixture-Server), damit veraltete Flags, Pfade oder Platzhalter sofort auffallen.
// Abweichung, bewusst: `npx cuonztech-agent-harness` wird durch das lokale
// dist/index.js ersetzt, weil npm noch eine ältere Version liefert.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";
const PLACEHOLDER = "<PFAD-ZU-DEINEM-SERVER.js>";

interface Cmd {
  args: string[];
}

function fencedBlocks(readme: string, lang: string): string[] {
  const re = new RegExp("```" + lang + "\\n([\\s\\S]*?)```", "g");
  return [...readme.matchAll(re)].map((m) => m[1]!);
}

// Zeilen mit "\" am Ende zusammenziehen und in Wörter zerlegen (die Beispiele
// enthalten keine Anführungszeichen).
function tokenize(block: string): string[] {
  return block.replace(/\\\n/g, " ").trim().split(/\s+/);
}

function toLocal(tokens: string[], reportFile: string): string[] {
  // "npx [-y] cuonztech-agent-harness" -> "node dist/index.js"
  const out: string[] = [];
  let i = 0;
  if (tokens[0] === "npx") {
    i = tokens[1] === "-y" ? 3 : 2;
    out.push("node", "dist/index.js");
  }
  for (; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === PLACEHOLDER) out.push(FIXTURE);
    else if (t === "harness-report.json") out.push(reportFile);
    else if (t === "bericht.html") out.push(reportFile.replace(/.json$/, ".html"));
    else if (t.startsWith("/ABSOLUTER/PFAD/")) out.push(reportFile);
    else out.push(t);
  }
  return out;
}

function run(args: string[], options: { waitFor?: string; timeoutMs: number }): Promise<{ output: string; code: number | null }> {
  return new Promise((resolve) => {
    const [cmd, ...rest] = args;
    const child = spawn(cmd!, rest, { cwd: process.cwd(), shell: false });
    let output = "";
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve({ output, code });
    };
    const onData = (d: Buffer): void => {
      output += d.toString();
      if (options.waitFor && output.includes(options.waitFor)) setTimeout(() => finish(null), 300);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => finish(code));
    const timer = setTimeout(() => finish(null), options.timeoutMs);
  });
}

describe("README-Befehle laufen wirklich", () => {
  it("Vorprüfung (doctor) aus dem Quickstart läuft und prüft den Server-Start", async () => {
    const readme = await readFile("README.md", "utf8");
    const block = fencedBlocks(readme, "bash").find((b) => b.includes("cuonztech-agent-harness doctor"));
    expect(block, "doctor-Beispiel fehlt in der README").toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "readme-doctor-"));
    const cmd: Cmd = { args: toLocal(tokenize(block!), join(dir, "harness-report.json")) };
    const { output } = await run(cmd.args.slice(0), { timeoutMs: 60_000 });
    expect(output).not.toContain(PLACEHOLDER);
    expect(output).toContain("Node.js");
    expect(output).toContain("Upstream-Server startet und antwortet");
  }, 90_000);

  it("Proxy-Befehl aus dem Quickstart startet ohne Fehler und meldet die Tool-Einordnung", async () => {
    const readme = await readFile("README.md", "utf8");
    const block = fencedBlocks(readme, "bash").find((b) => b.includes("cuonztech-agent-harness proxy"));
    expect(block, "proxy-Beispiel fehlt in der README").toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "readme-proxy-"));
    const args = toLocal(tokenize(block!), join(dir, "harness-report.json"));
    expect(args).not.toContain(PLACEHOLDER);
    const { output } = await run(args, { waitFor: "Upstream tools (", timeoutMs: 60_000 });
    expect(output).toContain("Upstream tools (");
    expect(output).not.toContain("upstream script not found");
    expect(output).not.toContain("MODULE_NOT_FOUND");
  }, 90_000);

  it("Claude-Desktop-Konfiguration aus der README ist gültiges JSON und startet den Proxy", async () => {
    const readme = await readFile("README.md", "utf8");
    const json = fencedBlocks(readme, "json").find((b) => b.includes("mcpServers"));
    expect(json, "mcpServers-Beispiel fehlt").toBeDefined();
    const parsed = JSON.parse(json!) as { mcpServers: Record<string, { command: string; args: string[] }> };
    const entry = Object.values(parsed.mcpServers)[0]!;
    expect(entry.command).toBe("npx");
    const dir = await mkdtemp(join(tmpdir(), "readme-json-"));
    const tokens = [entry.command, ...entry.args];
    const args = toLocal(tokens.map((t) => (t === PLACEHOLDER ? PLACEHOLDER : t)), join(dir, "harness-report.json"));
    const { output } = await run(args, { waitFor: "Upstream tools (", timeoutMs: 60_000 });
    expect(output).toContain("Upstream tools (");
  }, 90_000);

  it("report-Befehl aus der README erzeugt die Seite aus einer Report-Datei", async () => {
    const readme = await readFile("README.md", "utf8");
    const block = fencedBlocks(readme, "bash").find((b) => b.includes("cuonztech-agent-harness report"));
    expect(block, "report-Beispiel fehlt in der README").toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "readme-report-"));
    const reportFile = join(dir, "harness-report.json");
    await writeFile(reportFile, JSON.stringify({ harnessVersion: "0", verdict: "NOT_TESTED", status: "starting" }));
    const { output, code } = await run(toLocal(tokenize(block!), reportFile), { timeoutMs: 30_000 });
    expect(code, output).toBe(0);
    const html = await readFile(reportFile.replace(/.json$/, ".html"), "utf8");
    expect(html).toContain("<!doctype html>");
  }, 40_000);

  it("dossier- und campaign-Befehle aus der README laufen und schreiben ihre Dateien", async () => {
    const readme = await readFile("README.md", "utf8");
    const block = fencedBlocks(readme, "bash").find((b) => b.includes("--dossier") && b.includes("cuonztech-agent-harness campaign"));
    expect(block, "dossier-/campaign-Beispiel fehlt in der README").toBeDefined();
    const dir = await mkdtemp(join(tmpdir(), "readme-dossier-"));
    const reportFile = join(dir, "harness-report.json");
    await writeFile(reportFile, JSON.stringify({ harnessVersion: "0", verdict: "NOT_TESTED", status: "starting" }));
    const lines = block!.trim().split(String.fromCharCode(10)).filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const args = toLocal(line.trim().split(/\s+/), reportFile).map((t) => (/^[\w-]+\.html$/.test(t) ? join(dir, t) : t));
      const { output, code } = await run(args, { timeoutMs: 60_000 });
      expect(code, output).toBe(0);
      const out = args[args.indexOf("--out") + 1]!;
      expect(await readFile(out, "utf8")).toContain("<!doctype html>");
    }
  }, 150_000);

  // Braucht eine installierte Claude-Code-CLI mit Anmeldung. Wurde am 26.10.2026
  // von Hand auf einer VM geprüft, ist hier nicht automatisiert.
  it.skip("claude mcp add aus der README (braucht Claude Code mit Anmeldung)", () => {});
});
