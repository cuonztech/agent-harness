// Real CLI E2E test for `proxy` mode's own argument validation and startup
// diagnostics — spawns the COMPILED harness (dist/index.js proxy ...) as its
// own process and inspects actual stderr/exit code, not just internal
// functions. Needs a fresh `dist/` — see "pretest" in package.json.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";

function runProxy(
  args: string[],
  timeoutMs = 3000,
): Promise<{ stderr: string; exited: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", ...args]);
    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("exit", () => {
      if (!settled) {
        settled = true;
        resolve({ stderr, exited: true });
      }
    });
    setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        resolve({ stderr, exited: false });
      }
    }, timeoutMs);
  });
}

describe("CLI `proxy` mode (real process)", () => {
  it("rejects an unknown --scenario instead of accepting it silently (unlike the old behavior)", async () => {
    const { stderr, exited } = await runProxy([
      "--upstream-command",
      process.execPath,
      "--upstream-args",
      "tests/fixtures/upstream-fixture-server.mjs",
      "--scenario",
      "BOGUS99",
    ]);
    expect(exited).toBe(true);
    expect(stderr).toContain("unknown scenario");
    expect(stderr).toContain("BOGUS99");
  });

  it("warns loudly on startup when no upstream tool matches any write-tool pattern", async () => {
    const { stderr } = await runProxy([
      "--upstream-command",
      process.execPath,
      "--upstream-args",
      "tests/fixtures/upstream-fixture-server.mjs",
      "--scenario",
      "F1",
      "--write-tools",
      "nonexistent_prefix_*",
    ]);
    expect(stderr).toContain("none of the upstream's");
    expect(stderr).toContain("NEVER trigger");
  });

  it("does NOT warn when the broadened default already covers the upstream's tools", async () => {
    const { stderr } = await runProxy([
      "--upstream-command",
      process.execPath,
      "--upstream-args",
      "tests/fixtures/upstream-fixture-server.mjs",
    ]);
    expect(stderr).not.toContain("none of the upstream's");
  });
});
