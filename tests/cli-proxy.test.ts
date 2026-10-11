// Real CLI E2E test for `proxy` mode's own argument validation and startup
// diagnostics — spawns the COMPILED harness (dist/index.js proxy ...) as its
// own process and inspects actual stderr/exit code, not just internal
// functions. Needs a fresh `dist/` — see "pretest" in package.json.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UPSTREAM = [
  "--upstream-command",
  process.execPath,
  "--upstream-arg",
  "tests/fixtures/upstream-fixture-server.mjs",
];

function runProxy(
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string>; waitFor?: string } = {},
): Promise<{ stderr: string; exited: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", ...args], {
      env: { ...process.env, ...options.env },
    });
    let stderr = "";
    let settled = false;
    const finish = (exited: boolean, code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!exited) child.kill();
      resolve({ stderr, exited, code });
    };
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      // A proxy that starts successfully keeps running; stop as soon as the
      // startup output we are waiting for has arrived.
      if (options.waitFor && stderr.includes(options.waitFor)) {
        setTimeout(() => finish(false, null), 150);
      }
    });
    child.on("exit", (code) => finish(true, code));
    const timer = setTimeout(() => finish(false, null), options.timeoutMs ?? 5000);
  });
}

describe("CLI `proxy` mode (real process)", () => {
  describe("argument validation", () => {
    it("rejects an unknown --scenario instead of accepting it silently", async () => {
      const { stderr, exited, code } = await runProxy([...UPSTREAM, "--scenario", "BOGUS99"]);
      expect(exited).toBe(true);
      expect(code).toBe(1);
      expect(stderr).toContain("unknown scenario");
      expect(stderr).toContain("BOGUS99");
    });

    it.each([
      [["--mode", "chaso"], '--mode must be "deterministic" or "chaos"'],
      [["--mode", "chaos", "--error-rate", "abc"], "--error-rate must be a number between 0 and 1"],
      [["--mode", "chaos", "--error-rate", "1.5"], "--error-rate must be a number between 0 and 1"],
      [["--mode", "chaos", "--error-rate", "-0.1"], "--error-rate must be a number between 0 and 1"],
      [["--error-rate", "0.5"], "only has an effect together with --mode chaos"],
      [["--scenario", "F1", "--mode", "chaos", "--error-rate", "0.5"], "cannot be combined"],
      [["--scenaro", "F1"], 'unknown option "--scenaro"'],
      [["--scenario"], "needs a value"],
      [["--scenario", "F1", "--scenario", "F2"], "more than once"],
      [["--scenario", "F2", "--retry-after", "0"], "--retry-after must be a positive number"],
      [["--scenario", "F2", "--retry-after", "soon"], "--retry-after must be a positive number"],
      [["--scenario", "F2", "--retry-after", "99999999999999999999"], "--retry-after must be a positive number"],
      [["--scenario", "F1", "--retry-after", "5"], "only has an effect together with --scenario F2"],
      [["--write-tools", ""], "--write-tools was given an empty value"],
      [["--write-tools", ","], "--write-tools contains no pattern"],
      [["--report-file", ""], "--report-file was given an empty value"],
      [["--key-fields="], "--key-fields was given an empty value"],
      [["--report-file", "tests"], "is a directory, not a file"],
      ...(process.platform === "win32"
        ? ([
            [["--report-file", "NUL"], "reserved device name"],
            [["--report-file", "con.json"], "reserved device name"],
          ] as Array<[string[], string]>)
        : []),
      [["--upstream-env", "A=1, =2"], "is not KEY=VALUE"],
      [["--audit-tools", "maybe"], '--audit-tools must be "on" or "off"'],
      [["--upstream-env-var", "NOVALUE"], "is not KEY=VALUE"],
      [["stray"], 'unexpected argument "stray"'],
    ])("rejects %j", async (extra, message) => {
      const { stderr, exited, code } = await runProxy([...UPSTREAM, ...extra]);
      expect(exited).toBe(true);
      expect(code).toBe(1);
      expect(stderr).toContain(message);
    });

    it("accepts the --flag=value form", async () => {
      const { stderr, exited } = await runProxy(
        [`--upstream-command=${process.execPath}`, "--upstream-arg=tests/fixtures/upstream-fixture-server.mjs", "--scenario=F3"],
        { waitFor: "Only tools are proxied" },
      );
      expect(exited).toBe(false);
      expect(stderr).toContain("Upstream tools (13)");
    });

    it("proxy --help prints usage and exits 0", async () => {
      const child = await new Promise<{ stdout: string; code: number | null }>((resolve) => {
        const c = spawn(process.execPath, ["dist/index.js", "proxy", "--help"]);
        let stdout = "";
        c.stdout.on("data", (d) => (stdout += d.toString()));
        c.on("exit", (code) => resolve({ stdout, code }));
      });
      expect(child.code).toBe(0);
      expect(child.stdout).toContain("Usage:");
    });

    it("--help after other options still prints usage; as an option VALUE it is passed on", async () => {
      const run = (argv: string[]) =>
        new Promise<{ stdout: string; code: number | null }>((resolve) => {
          const c = spawn(process.execPath, ["dist/index.js", ...argv]);
          let stdout = "";
          c.stdout.on("data", (d) => (stdout += d.toString()));
          c.on("exit", (code) => resolve({ stdout, code }));
        });
      const late = await run(["proxy", "--scenario", "F1", "--help"]);
      expect(late.code).toBe(0);
      expect(late.stdout).toContain("Usage:");

      const asValue = await runProxy(
        ["--upstream-command", process.execPath, "--upstream-arg", "--help"],
      );
      // node --help is not an MCP server: the proxy must report THAT, not print its own usage.
      expect(asValue.stderr).toContain("could not start or connect to the upstream MCP server");
    });

    it("a rejected command line replaces a report file left over from an earlier run", async () => {
      const dir = await mkdtemp(join(tmpdir(), "harness-stale-"));
      const file = join(dir, "report.json");
      await writeFile(file, JSON.stringify({ verdict: "PASS", report: { verdict: "PASS" } }), "utf-8");

      const { code } = await runProxy([...UPSTREAM, "--scenaro", "F1", "--report-file", file]);
      expect(code).toBe(1);
      const after = JSON.parse(await readFile(file, "utf-8")) as { verdict: string; startupError: string };
      expect(after.verdict).toBe("NOT_TESTED");
      expect(after.startupError).toContain("--scenaro");

      await writeFile(file, JSON.stringify({ verdict: "PASS" }), "utf-8");
      const failedStart = await runProxy([
        "--upstream-command", process.execPath, "--upstream-arg", "-e", "--upstream-arg", "process.exit(2)",
        "--report-file", file,
      ]);
      expect(failedStart.code).toBe(1);
      expect((JSON.parse(await readFile(file, "utf-8")) as { verdict: string }).verdict).toBe("NOT_TESTED");
    });

    it("rejects an option that is followed by another option instead of a value", async () => {
      const { code, stderr } = await runProxy([...UPSTREAM, "--report-file", "--scenario", "F1"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--report-file needs a value");
      // ... and must not have created a file called "--scenario".
      await expect(stat("--scenario")).rejects.toThrow();
    });

    it("rejects a misspelled option where a value is expected, and creates no file of that name", async () => {
      const { code, stderr } = await runProxy([...UPSTREAM, "--report-file", "--audit-tool", "off"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--report-file needs a value");
      await expect(stat("--audit-tool")).rejects.toThrow();
    });

    it("does not take the value of another option for the report file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "harness-peek-"));
      const file = join(dir, "other.json");
      await writeFile(file, "untouched", "utf-8");
      // "--report-file=<file>" is the VALUE of --upstream-arg here; the start
      // fails (node rejects the option) and must leave that file alone.
      const { code } = await runProxy([
        "--upstream-command", process.execPath,
        "--upstream-arg", `--report-file=${file}`,
      ]);
      expect(code).toBe(1);
      expect(await readFile(file, "utf-8")).toBe("untouched");
    });

    it("requires --upstream-command", async () => {
      const { stderr, exited, code } = await runProxy(["--scenario", "F1"]);
      expect(exited).toBe(true);
      expect(code).toBe(1);
      expect(stderr).toContain("requires --upstream-command");
    });
  });

  describe("startup diagnostics", () => {
    it("lists how every upstream tool was classified, and from what", async () => {
      const { stderr } = await runProxy([...UPSTREAM, "--scenario", "F1"], {
        waitFor: "crash_now",
      });
      expect(stderr).toMatch(/write\s+create_booking\s+\(default write pattern\)/);
      expect(stderr).toMatch(/read\s+get_ledger\s+\(read prefix\)/);
      expect(stderr).toMatch(/write\s+apply_discount\s+\(annotation readOnlyHint=false\)/);
      expect(stderr).toMatch(/read\s+compute_quote\s+\(annotation readOnlyHint=true\)/);
      expect(stderr).toMatch(/unclassified\s+mutate_ledger/);
    });

    it("warns about EACH unclassified tool, even though other tools are recognized as writes", async () => {
      const { stderr } = await runProxy([...UPSTREAM, "--scenario", "F1"], {
        waitFor: 'tool "crash_now" could not be classified',
      });
      expect(stderr).toContain('WARNING: tool "mutate_ledger" could not be classified');
      expect(stderr).toContain('WARNING: tool "crash_now" could not be classified');
      expect(stderr).not.toContain("none of the upstream's");
    });

    it("explicit flags win over annotations and patterns", async () => {
      const { stderr } = await runProxy(
        [...UPSTREAM, "--write-tools", "mutate_*,compute_*", "--read-tools", "crash_*"],
        { waitFor: "crash_now" },
      );
      expect(stderr).toMatch(/write\s+mutate_ledger\s+\(--write-tools\)/);
      // Annotated readOnlyHint=true, but the explicit flag says write.
      expect(stderr).toMatch(/write\s+compute_quote\s+\(--write-tools\)/);
      expect(stderr).toMatch(/read\s+crash_now\s+\(--read-tools\)/);
      // --write-tools replaces the default verb list; the annotation still applies.
      expect(stderr).toMatch(/unclassified\s+create_booking/);
      expect(stderr).toMatch(/write\s+apply_discount\s+\(annotation readOnlyHint=false\)/);
    });

    it("warns loudly when no upstream tool at all is classified as a write", async () => {
      const { stderr } = await runProxy(
        [...UPSTREAM, "--scenario", "F1", "--write-tools", "nonexistent_prefix_*", "--read-tools", "apply_*"],
        { waitFor: "NEVER trigger" },
      );
      expect(stderr).toContain("none of the upstream's");
      expect(stderr).toContain("NEVER trigger");
    });

    it("warns that chaos mode without --error-rate injects nothing", async () => {
      const { stderr } = await runProxy([...UPSTREAM, "--mode", "chaos"], {
        waitFor: "crash_now",
      });
      expect(stderr).toContain("--mode chaos with a 0% error rate");
    });

    it("warns the same way for an explicit --error-rate 0", async () => {
      const { stderr } = await runProxy([...UPSTREAM, "--mode", "chaos", "--error-rate", "0"], {
        waitFor: "crash_now",
      });
      expect(stderr).toContain("--mode chaos with a 0% error rate");
    });

    it("says when a run is only a baseline, which tools carry a key, and that the agent can peek", async () => {
      const baseline = await runProxy(UPSTREAM, { waitFor: "Only tools are proxied" });
      expect(baseline.stderr).toContain("baseline, not a resilience test");
      expect(baseline.stderr).toContain("Idempotency-key argument recognized on: create_booking");
      expect(baseline.stderr).not.toContain("reveal what really happened");

      const f1 = await runProxy([...UPSTREAM, "--scenario", "F1"], {
        waitFor: "reveal what really happened",
      });
      expect(f1.stderr).toContain("scenario F1 really executes");
      expect(f1.stderr).toContain("--audit-tools off");

      const f2 = await runProxy([...UPSTREAM, "--scenario", "F2", "--key-fields", "request_id"], {
        waitFor: "Only tools are proxied",
      });
      expect(f2.stderr).not.toContain("F1 really executes");
      expect(f2.stderr).toContain("no upstream tool has an argument recognized as an idempotency key");
    });

    it("follows a paginated upstream tool list to the end", async () => {
      const { stderr } = await runProxy(UPSTREAM, {
        env: { FIXTURE_PAGINATE: "1" },
        waitFor: "Only tools are proxied",
      });
      expect(stderr).toContain("Upstream tools (13)");
      expect(stderr).toMatch(/unclassified\s+crash_now/);
    });

    it("explains an upstream that fails to start, with its stderr", async () => {
      const { stderr, exited, code } = await runProxy([
        "--upstream-command",
        process.execPath,
        "--upstream-arg",
        "-e",
        "--upstream-arg",
        "console.error('boom: config missing'); process.exit(7)",
      ]);
      expect(exited).toBe(true);
      expect(code).toBe(1);
      expect(stderr).toContain("could not start or connect to the upstream MCP server");
      expect(stderr).toContain("boom: config missing");
    });

    it("rejects a --upstream-cwd that does not exist with a message naming it", async () => {
      const { stderr, code } = await runProxy([...UPSTREAM, "--upstream-cwd", "no/such/dir"]);
      expect(code).toBe(1);
      expect(stderr).toContain('--upstream-cwd "no/such/dir" is not an existing directory');
    });

    it("refuses to start when an upstream tool collides with a harness audit tool", async () => {
      const { stderr, exited, code } = await runProxy(UPSTREAM, {
        env: { FIXTURE_COLLIDE: "1" },
      });
      expect(exited).toBe(true);
      expect(code).toBe(1);
      expect(stderr).toContain("cuonztech__get_score");
      expect(stderr).toContain("--audit-tools off");
    });

    it("starts despite that collision when the audit tools are switched off", async () => {
      const { stderr, exited } = await runProxy(
        [...UPSTREAM, "--audit-tools", "off"],
        { env: { FIXTURE_COLLIDE: "1" }, waitFor: "cuonztech__get_score" },
      );
      expect(exited).toBe(false);
      expect(stderr).not.toContain("Error:");
    });
  });
});
