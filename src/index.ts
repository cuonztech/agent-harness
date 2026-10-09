#!/usr/bin/env node

import { createServer } from "./server/server.js";
import { startStdio } from "./server/stdio.js";
import { runBenchmark, defaultConfig } from "./benchmark/runner.js";
import { formatCTA, buildTelemetry } from "./benchmark/cta.js";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const args = process.argv.slice(2);

async function main(): Promise<void> {
  const mode = args[0];

  if (mode === "benchmark" || mode === "evaluate") {
    await runBenchmarkMode();
  } else {
    // Default: MCP server mode (stdio)
    const server = createServer();
    await startStdio(server);
  }
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

  process.stdout.write(`CuonzTech Agent-Harness Benchmark\n`);
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