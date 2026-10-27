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

  it("labels the run as a self-test with fixed reference agents, not a measurement of the caller's own agent", () => {
    const { stdout, status } = runCli(["benchmark", "--scenarios", "F1"]);
    expect(status).toBe(0);
    expect(stdout).toContain("does NOT");
    expect(stdout.toLowerCase()).toContain("reference agent");
    expect(stdout).toContain("CuonzTech Resilience Score");
  });

  it("shows the careful agent passing and the naive agent failing, and reports the self-test as passed", () => {
    const { stdout, status } = runCli(["benchmark"]);
    expect(status).toBe(0);
    const [carefulPart, naivePart] = stdout.split("Reference agent 2/2");
    expect(carefulPart).toContain("Overall: 100/100 [PASS]");
    expect(naivePart).toContain("[FAIL]");
    expect(naivePart).toContain("GHOST_WRITE");
    expect(stdout).toContain("Self-test PASSED");
  });

  it("--jitter changes nothing about the verdicts (the naive agent's retries stay immediate)", () => {
    const { stdout, status } = runCli(["benchmark", "--runs", "2", "--jitter", "30"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Self-test PASSED");
  });

  it.each([
    [["benchmark", "--scenaros", "F1"], 'unknown option "--scenaros"'],
    [["benchmark", "F1"], 'unexpected argument "F1"'],
    [["benchmark", "--runs"], "needs a value"],
    [["benchmak"], 'unknown command "benchmak"'],
    [["bogus"], "Commands: benchmark, proxy, doctor, report, ui"],
  ])("rejects %j instead of silently ignoring it", (argv, message) => {
    const { stderr, status } = runCli(argv);
    expect(status).toBe(1);
    expect(stderr).toContain(message);
  });

  it.each([["0"], ["-5"], ["abc"], ["1.5"]])(
    "rejects --runs %s instead of silently running zero scenarios and printing a fake 100/100",
    (value) => {
      const { stderr, status } = runCli(["benchmark", "--runs", value]);
      expect(status).toBe(1);
      expect(stderr).toContain("--runs must be a positive integer");
    },
  );

  it("rejects a negative --jitter", () => {
    const { stderr, status } = runCli(["benchmark", "--jitter", "-1"]);
    expect(status).toBe(1);
    expect(stderr).toContain("--jitter must be a non-negative integer");
  });

  it("does not claim to tell the agents apart when only F3/F5 run (both are expected to pass there)", () => {
    const { stdout, status } = runCli(["benchmark", "--scenarios", "F3,F5"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Self-test PASSED");
    expect(stdout).toContain("BOTH reference agents are expected to pass");
    expect(stdout).not.toContain("is expected to fail in");
  });

  it("caps --runs and de-duplicates --scenarios", () => {
    const tooMany = runCli(["benchmark", "--runs", "1001"]);
    expect(tooMany.status).toBe(1);
    expect(tooMany.stderr).toContain("at most 1000");

    const dup = runCli(["benchmark", "--scenarios", "F1,F1,F1"]);
    expect(dup.status).toBe(0);
    expect(dup.stdout).toContain("Scenarios: F1\n");
  });

  it("--version prints the package version; benchmark --help prints usage", () => {
    const version = runCli(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);

    const help = runCli(["benchmark", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Usage:");

    const lateHelp = runCli(["benchmark", "--runs", "2", "-h"]);
    expect(lateHelp.status).toBe(0);
    expect(lateHelp.stdout).toContain("Usage:");

    const jitter = runCli(["benchmark", "--jitter", "99999999999"]);
    expect(jitter.status).toBe(1);
    expect(jitter.stderr).toContain("at most 60000");
  });

  it("announces the separate audit product once, unconditionally — not as a reaction to a failed run", () => {
    const failing = runCli(["benchmark"]);
    const passingOnly = runCli(["benchmark", "--scenarios", "F3,F5"]);
    for (const { stdout } of [failing, passingOnly]) {
      expect(stdout.match(/Coming soon — CuonzTech Agent Audit/g)).toHaveLength(1);
      expect(stdout).toContain("issues no certificate");
      expect(stdout).toContain("https://cuonztech.ch/agent-harness.html");
    }
    expect(runCli(["--help"]).stdout).toContain("Coming soon — CuonzTech Agent Audit");
  });

  it("--help prints usage and exits instead of hanging in stdio server mode", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stdout).toContain("proxy");
    expect(stdout).toContain("benchmark");
  });
});
