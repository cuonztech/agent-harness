// Real CLI E2E test for `benchmark`/`evaluate` mode: spawns the COMPILED
// harness (dist/index.js benchmark ...) as its own process and inspects
// actual stdout/stderr/exit code — not just the internal runner function.
// Needs a fresh `dist/` — see "pretest" in package.json.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";

function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, ["dist/index.js", ...args], {
    encoding: "utf-8",
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe("CLI `benchmark` mode (real process)", () => {
  it("rejects an unknown scenario with a clear error instead of crashing on a raw SyntaxError", () => {
    const { stderr, status } = runCli(["benchmark", "--scenarios", "F9"]);
    expect(status).toBe(1);
    expect(stderr).toContain("unknown scenario");
    expect(stderr).toContain("F9");
    expect(stderr).not.toContain("SyntaxError");
  });

  it("labels the score as a fixed reference run, not a measurement of the caller's own agent", () => {
    const { stdout, status } = runCli(["benchmark", "--scenarios", "F1"]);
    expect(status).toBe(0);
    expect(stdout).toContain("does NOT");
    expect(stdout.toLowerCase()).toContain("reference");
    expect(stdout).toContain("CuonzTech Resilience Score");
  });
});
