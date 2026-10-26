// Prüft das Docker-Image: baut es und führt den Weg im Container aus.
// Läuft nur mit HARNESS_DOCKER_TEST=1 und laufendem Docker (Release-Gate),
// damit die normale Suite nicht von Docker abhängt.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const enabled = process.env.HARNESS_DOCKER_TEST === "1";
const IMAGE = "cuonztech-agent-harness:test";
const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

function docker(args: string[], timeoutMs = 120_000): { out: string; code: number | null } {
  const r = spawnSync("docker", args, { encoding: "utf8", timeout: timeoutMs });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`, code: r.status };
}

describe.skipIf(!enabled)("Docker-Image", () => {
  it("baut ohne Fehler", () => {
    const { out, code } = docker(["build", "-t", IMAGE, "."], 600_000);
    expect(code, out.slice(-800)).toBe(0);
  }, 620_000);

  it("meldet die Paketversion", () => {
    const { out, code } = docker(["run", "--rm", IMAGE, "--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(version);
  });

  it("läuft nicht als root", () => {
    const { out } = docker(["run", "--rm", "--entrypoint", "id", IMAGE, "-u"]);
    expect(out.trim()).not.toBe("0");
  });

  it("doctor mit dem mitgelieferten Testsystem ist komplett grün", () => {
    const { out, code } = docker([
      "run", "--rm", IMAGE, "doctor",
      "--upstream-command", "node",
      "--upstream-arg", "/app/examples/testsystem/server.mjs",
    ]);
    expect(code, out).toBe(0);
    expect(out).toContain("Alles bereit");
  });
});
