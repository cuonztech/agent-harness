#!/usr/bin/env node

import { createServer } from "./server/server.js";
import { startStdio } from "./server/stdio.js";
import { runBenchmark, defaultConfig } from "./benchmark/runner.js";
import { formatCTA, buildTelemetry } from "./benchmark/cta.js";
import { ProxyInterceptor } from "./proxy/interceptor.js";
import { createProxyServer } from "./proxy/gateway.js";
import { getScenarioById, ALL_SCENARIOS } from "./scenarios/f1-f5.js";
import { DEFAULT_WRITE_TOOL_PATTERNS, matchesAnyGlob } from "./engine/state-machine.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);

function printHelp(): void {
  process.stdout.write(
    `cuonztech-agent-harness — chaos/idempotency test harness for MCP agents\n\n` +
      `Usage:\n` +
      `  cuonztech-agent-harness                   Start as an MCP server (stdio)\n` +
      `  cuonztech-agent-harness benchmark [opts]   Run the fixed reference self-test\n` +
      `  cuonztech-agent-harness proxy --upstream-command <cmd> [opts]\n` +
      `                                             Run as a transparent chaos proxy\n` +
      `                                             in front of a real upstream MCP server\n\n` +
      `benchmark options:\n` +
      `  --scenarios F1,F2,...   Which scenarios to run (default: all)\n` +
      `  --runs <n>              Runs per scenario, positive integer (default: 1)\n` +
      `  --jitter <ms>           Random delay between scripted calls (default: 0)\n\n` +
      `proxy options:\n` +
      `  --upstream-command <cmd>       Command to spawn the upstream MCP server (required)\n` +
      `  --upstream-args <a,b,c>        Comma-separated args for the upstream command\n` +
      `  --upstream-cwd <dir>           Working directory for the upstream process\n` +
      `  --upstream-env KEY=VAL,...     Extra/override env vars for the upstream process\n` +
      `  --scenario F1..F5              Activate one deterministic scenario\n` +
      `  --mode chaos                   Stochastic error injection instead of a scenario\n` +
      `  --error-rate <0..1>             Error probability in chaos mode (default: 0)\n` +
      `  --write-tools pat1,pat2,...    Glob patterns ("*") for which tool names count as\n` +
      `                                  writes (default covers common verbs: write*,\n` +
      `                                  create_*, send_*, submit_*, post_*, update_*, ...\n` +
      `                                  — see DEFAULT_WRITE_TOOL_PATTERNS). Set this if\n` +
      `                                  your upstream's write tools use other naming.\n`,
  );
}

async function main(): Promise<void> {
  const mode = args[0];

  if (mode === "--help" || mode === "-h" || mode === "help") {
    printHelp();
  } else if (mode === "benchmark" || mode === "evaluate") {
    await runBenchmarkMode();
  } else if (mode === "proxy") {
    await runProxyMode();
  } else {
    // Default: MCP server mode (stdio)
    const server = createServer();
    await startStdio(server);
  }
}

async function runProxyMode(): Promise<void> {
  const cmdIdx = args.indexOf("--upstream-command");
  const upstreamCommand = cmdIdx !== -1 ? args[cmdIdx + 1] : undefined;
  if (!upstreamCommand) {
    process.stderr.write(
      "Error: proxy mode requires --upstream-command <cmd>\n" +
        "Example: cuonztech-agent-harness proxy --upstream-command node --upstream-args dist/server.js\n",
    );
    process.exit(1);
    return;
  }

  const argsIdx = args.indexOf("--upstream-args");
  const upstreamArgs =
    argsIdx !== -1 && args[argsIdx + 1] ? args[argsIdx + 1].split(",") : [];

  const cwdIdx = args.indexOf("--upstream-cwd");
  const upstreamCwd = cwdIdx !== -1 ? args[cwdIdx + 1] : undefined;

  const envIdx = args.indexOf("--upstream-env");
  const upstreamEnv: Record<string, string> = {};
  if (envIdx !== -1 && args[envIdx + 1]) {
    for (const pair of args[envIdx + 1].split(",")) {
      const eq = pair.indexOf("=");
      if (eq === -1) {
        process.stderr.write(
          `Error: --upstream-env entry "${pair}" is not KEY=VALUE.\n`,
        );
        process.exit(1);
        return;
      }
      upstreamEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }

  const writeToolsIdx = args.indexOf("--write-tools");
  const writeToolPatterns =
    writeToolsIdx !== -1 && args[writeToolsIdx + 1]
      ? args[writeToolsIdx + 1].split(",")
      : undefined;

  const scenarioIdx = args.indexOf("--scenario");
  const scenarioId = scenarioIdx !== -1 ? args[scenarioIdx + 1] : undefined;
  if (scenarioId && !getScenarioById(scenarioId)) {
    process.stderr.write(
      `Error: unknown scenario "${scenarioId}". Valid: ${ALL_SCENARIOS.map((s) => s.id).join(", ")}\n`,
    );
    process.exit(1);
    return;
  }

  const modeIdx = args.indexOf("--mode");
  const chaosModeRequested = modeIdx !== -1 ? args[modeIdx + 1] : undefined;
  const chaosMode: "deterministic" | "chaos" =
    chaosModeRequested === "chaos" ? "chaos" : "deterministic";

  const errorRateIdx = args.indexOf("--error-rate");
  const errorRate =
    errorRateIdx !== -1 && args[errorRateIdx + 1]
      ? parseFloat(args[errorRateIdx + 1])
      : 0.0;

  if (chaosMode === "chaos" && errorRateIdx === -1) {
    process.stderr.write(
      "[cuonztech-agent-harness] WARNING: --mode chaos without --error-rate defaults " +
        "to a 0% error rate — this run will inject nothing. Pass e.g. --error-rate 0.2 " +
        "to actually trigger stochastic failures.\n",
    );
  }

  if (scenarioId || chaosMode === "chaos") {
    process.stderr.write(
      "[cuonztech-agent-harness] WARNING: chaos/scenario injection is active — " +
        "the agent will sometimes receive errors or duplicate successes that do " +
        "NOT reflect what actually happened upstream. Only point --upstream-command " +
        "at a disposable test/staging backend, never production.\n",
    );
  }

  const interceptor = new ProxyInterceptor({
    upstream: {
      command: upstreamCommand,
      args: upstreamArgs,
      cwd: upstreamCwd,
      env: upstreamEnv,
    },
    scenarioId,
    mode: chaosMode,
    errorRate,
    writeToolPatterns,
  });

  await interceptor.connectUpstream();

  // If NOT ONE of the upstream's real tools matches any configured
  // write-tool pattern, ghost-write/duplicate-dispatch detection (F1/F4) and
  // idempotency-key tracking will NEVER trigger for this upstream — the
  // session stays silently inert while get_report/get_score can still print
  // a misleadingly clean 100/100. An adversarial test against the published
  // package found exactly this against a realistically-named tool. Warn
  // loudly instead of staying silent, even though DEFAULT_WRITE_TOOL_PATTERNS
  // is now broader than just "write*".
  const effectivePatterns =
    writeToolPatterns && writeToolPatterns.length > 0
      ? writeToolPatterns
      : DEFAULT_WRITE_TOOL_PATTERNS;
  const upstreamTools = interceptor.getUpstreamTools();
  const anyToolMatches = upstreamTools.some((t) =>
    matchesAnyGlob(t.name, effectivePatterns),
  );
  if (upstreamTools.length > 0 && !anyToolMatches) {
    process.stderr.write(
      `[cuonztech-agent-harness] WARNING: none of the upstream's ${upstreamTools.length} ` +
        `tool(s) (${upstreamTools.map((t) => t.name).join(", ")}) match any write-tool ` +
        `pattern (currently: ${effectivePatterns.join(", ")}). Ghost-write/duplicate-dispatch ` +
        `detection will NEVER trigger for this upstream, and real duplicate writes will go ` +
        `completely undetected. If your write tools use different naming, pass e.g. ` +
        `--write-tools "yourprefix_*".\n`,
    );
  }

  const shutdown = async (): Promise<void> => {
    await interceptor.disconnectUpstream();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const server = createProxyServer(interceptor);
  await startStdio(server);
}

async function runBenchmarkMode(): Promise<void> {
  const config = defaultConfig();

  // Strict integer parsing: parseInt() alone is too lenient (parseInt("1.5")
  // silently truncates to 1 instead of being rejected) — only a string
  // matching /^-?\d+$/ counts as a valid integer here.
  function parseStrictInt(raw: string): number | null {
    return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : null;
  }

  // Parse optional flags
  const runsIdx = args.indexOf("--runs");
  if (runsIdx !== -1 && args[runsIdx + 1]) {
    const parsed = parseStrictInt(args[runsIdx + 1]);
    if (parsed === null || parsed < 1) {
      // A non-positive/NaN/non-integer value used to silently run ZERO
      // scenarios while still printing a fake "Overall: 100/100 [EXCELLENT]"
      // (computeScore's "no data = perfect" default, which is correct for a
      // real session with genuinely nothing to flag, but dishonest here —
      // nothing was ever tested) and persisting that 100/100 into
      // .cuonztech/benchmark-report.json for anything (e.g. a CI gate) to
      // pick up as real.
      process.stderr.write(
        `Error: --runs must be a positive integer, got "${args[runsIdx + 1]}".\n`,
      );
      process.exit(1);
      return;
    }
    config.runsPerScenario = parsed;
  }
  const jitterIdx = args.indexOf("--jitter");
  if (jitterIdx !== -1 && args[jitterIdx + 1]) {
    const parsed = parseStrictInt(args[jitterIdx + 1]);
    if (parsed === null || parsed < 0) {
      process.stderr.write(
        `Error: --jitter must be a non-negative integer (ms), got "${args[jitterIdx + 1]}".\n`,
      );
      process.exit(1);
      return;
    }
    config.jitterMs = parsed;
  }
  const scenariosIdx = args.indexOf("--scenarios");
  if (scenariosIdx !== -1 && args[scenariosIdx + 1]) {
    config.scenarios = args[scenariosIdx + 1].split(",");
  }

  const unknown = config.scenarios.filter((id) => !getScenarioById(id));
  if (unknown.length > 0) {
    process.stderr.write(
      `Error: unknown scenario(s) "${unknown.join(", ")}". ` +
        `Valid: ${ALL_SCENARIOS.map((s) => s.id).join(", ")}\n`,
    );
    process.exit(1);
    return;
  }

  process.stdout.write(`CuonzTech Agent-Harness Benchmark\n`);
  process.stdout.write(
    "NOTE: this replays a fixed built-in reference call sequence — it does NOT\n" +
      "connect to or measure your own agent. It is a self-test of the harness's\n" +
      "scenario/scoring logic, useful as a reference point, not a verdict on your\n" +
      "system. To score YOUR agent, connect it to `proxy` mode or the MCP server's\n" +
      "`start_session`/`execute_call`/`get_score` tools instead.\n\n",
  );
  process.stdout.write(`Scenarios: ${config.scenarios.join(", ")}\n`);
  process.stdout.write(`Runs per scenario: ${config.runsPerScenario}\n`);
  process.stdout.write(`Jitter: ${config.jitterMs}ms\n\n`);

  const result = await runBenchmark(config);

  // Output score to stdout
  process.stdout.write(result.markdownScore + "\n");
  process.stdout.write(formatCTA(result.score) + "\n\n");

  // Output patches if any
  if (result.patches.length > 0) {
    process.stdout.write(result.markdownPatches + "\n");
  }

  // Save JSON report
  const reportDir = ".cuonztech";
  await mkdir(reportDir, { recursive: true });

  const jsonPath = `${reportDir}/benchmark-report.json`;
  const telemetry = buildTelemetry(result.score, result.patches);
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        ...telemetry,
        score: result.score,
        patches: result.patches.map((p) => ({
          category: p.category,
          severity: p.severity,
          trigger: p.trigger,
          promptSnippet: p.promptSnippet,
        })),
        reports: result.reports,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  process.stdout.write(`\nReport saved to ${jsonPath}\n`);

  // Exit code based on score
  process.exit(result.score.overall >= 70 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});