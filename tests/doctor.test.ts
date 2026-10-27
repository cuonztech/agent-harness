// `doctor` als echter Prozess (dist/index.js doctor ...): prüft Ausgabe und
// Exit-Code, wie sie ein Engineer sieht. Braucht ein frisches dist/ (pretest).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";

function runDoctor(args: string[]): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", "doctor", ...args]);
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stdout += d.toString()));
    const timer = setTimeout(() => child.kill(), 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stdout, code });
    });
  });
}

describe("doctor (real process)", () => {
  it("reports OK for Node and a working server with explicit tool patterns", async () => {
    const { stdout, code } = await runDoctor([
      "--upstream-command", process.execPath,
      "--upstream-arg", FIXTURE,
      "--write-tools", "write*,create_*,apply_*,mutate_ledger,crash_now",
      "--read-tools", "get_*,read_*,compute_*",
    ]);
    expect(stdout).toContain("Node.js");
    expect(stdout).toContain("Upstream-Server startet und antwortet");
    expect(stdout).toContain("Alles bereit");
    expect(code).toBe(0);
  }, 40_000);

  it("names the problem and the fix for a missing script instead of a stack trace", async () => {
    const { stdout, code } = await runDoctor([
      "--upstream-command", "node",
      "--upstream-arg", "dist/dein-echter-server.js",
    ]);
    expect(stdout).toContain("FEHLER  Upstream-Datei vorhanden");
    expect(stdout).toContain("Platzhalter durch den Pfad");
    expect(stdout).not.toContain("MODULE_NOT_FOUND");
    expect(code).toBe(1);
  }, 40_000);

  it("flags tools that cannot be classified and says how to fix it", async () => {
    const { stdout, code } = await runDoctor(["--upstream-command", process.execPath, "--upstream-arg", FIXTURE]);
    expect(stdout).toContain("FEHLER  ");
    expect(stdout).toContain("nicht eindeutig einordenbar");
    expect(stdout).toContain("ersetzt die Standard-Muster");
    expect(code).toBe(1);
  }, 40_000);

  it("explains a server that exits before answering, with its own error output", async () => {
    const { stdout, code } = await runDoctor([
      "--upstream-command", process.execPath,
      "--upstream-arg", "-e",
      "--upstream-arg", "console.error('boom: config missing'); process.exit(7)",
    ]);
    expect(stdout).toContain("FEHLER  Upstream-Server startet und antwortet");
    expect(stdout).toContain("boom: config missing");
    expect(code).toBe(1);
  }, 40_000);

  it("--help shows the usage", async () => {
    const { stdout, code } = await runDoctor(["--help"]);
    expect(stdout).toContain("Nutzung: doctor");
    expect(code).toBe(0);
  }, 40_000);

  it("rejects an option without a value, like the proxy does", async () => {
    const { stdout, code } = await runDoctor(["--upstream-command", process.execPath, "--write-tools", ""]);
    expect(stdout).toContain("ohne Wert: --write-tools");
    expect(code).toBe(1);
  }, 40_000);

  it("fails a --report-file that exists and is not an earlier harness report", async () => {
    const { stdout, code } = await runDoctor([
      "--upstream-command", process.execPath, "--upstream-arg", FIXTURE,
      "--write-tools", "write*,create_*,apply_*,mutate_ledger,crash_now",
      "--read-tools", "get_*,read_*,compute_*",
      "--report-file", FIXTURE,
    ]);
    expect(stdout).toContain("FEHLER  Report-Datei");
    expect(stdout).toContain("Refusing to overwrite");
    expect(code).toBe(1);
  }, 40_000);

  it("rejects unknown options with usage instead of ignoring them", async () => {
    const { stdout, code } = await runDoctor(["--upstream-comand", "node"]);
    expect(stdout).toContain("Unbekannte Option(en): --upstream-comand");
    expect(code).toBe(1);
  }, 40_000);
});
