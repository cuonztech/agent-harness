#!/usr/bin/env node

import { createServer } from "./server/server.js";
import { startStdio } from "./server/stdio.js";
import { runBenchmark, defaultConfig } from "./benchmark/runner.js";
import { formatCTA, buildTelemetry } from "./benchmark/cta.js";
import { ProxyInterceptor } from "./proxy/interceptor.js";
import { createProxyServer } from "./proxy/gateway.js";
import { getScenarioById, ALL_SCENARIOS } from "./scenarios/f1-f5.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const mode = args[0];

  if (mode === "benchmark" || mode === "evaluate") {
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

  // Parse optional flags
  const runsIdx = args.indexOf("--runs");
  if (runsIdx !== -1 && args[runsIdx + 1]) {
    config.runsPerScenario = parseInt(args[runsIdx + 1], 10);
  }
  const jitterIdx = args.indexOf("--jitter");
  if (jitterIdx !== -1 && args[jitterIdx + 1]) {
    config.jitterMs = parseInt(args[jitterIdx + 1], 10);
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