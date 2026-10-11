#!/usr/bin/env node

import { createServer } from "./server/server.js";
import { startStdio } from "./server/stdio.js";
import { runBenchmark, defaultConfig, type ReferenceRun } from "./benchmark/runner.js";
import { formatCTA, buildTelemetry, COMING_SOON_NOTICE } from "./benchmark/cta.js";
import { computeScore } from "./benchmark/score.js";
import { generatePatches } from "./hardening/patch-generator.js";
import { generateReport } from "./core/report-generator.js";
import { ProxyInterceptor } from "./proxy/interceptor.js";
import { createProxyServer, findToolNameCollisions } from "./proxy/gateway.js";
import { getScenarioById, ALL_SCENARIOS } from "./scenarios/f1-f5.js";
import { VERSION } from "./version.js";
import { writeFile, mkdir, rename, stat } from "node:fs/promises";
import { writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, basename } from "node:path";

const args = process.argv.slice(2);

function printHelp(): void {
  process.stdout.write(
    `cuonztech-agent-harness — chaos/idempotency test harness for MCP agents\n\n` +
      `Usage:\n` +
      `  cuonztech-agent-harness                   Start as an MCP server (stdio, demo/self-test sessions)\n` +
      `  cuonztech-agent-harness --version         Print the version\n` +
      `  cuonztech-agent-harness benchmark [opts]   Run the harness self-test (two fixed reference agents;\n` +
      `                                             "evaluate" is an alias)\n` +
      `  cuonztech-agent-harness proxy --upstream-command <cmd> [opts]\n` +
      `                                             Run as a transparent chaos proxy\n` +
      `                                             in front of a real upstream MCP server\n\n` +
      `benchmark options:\n` +
      `  --scenarios F1,F2,...   Which scenarios to run (default: all)\n` +
      `  --runs <n>              Runs per scenario, 1-1000 (default: 1). The reference agents\n` +
      `                          are deterministic: more runs repeat the same result.\n` +
      `  --jitter <ms>           Random delay between the careful agent's calls (default: 0);\n` +
      `                          does not change any verdict\n\n` +
      `proxy options:\n` +
      `  --upstream-command <cmd>       Command to spawn the upstream MCP server (required)\n` +
      `  --upstream-arg <arg>           One argument for the upstream command; repeat the flag\n` +
      `                                  for several. Use this for arguments containing commas.\n` +
      `  --upstream-args <a,b,c>        Comma-separated args (cannot contain commas themselves);\n` +
      `                                  always placed before the --upstream-arg values\n` +
      `  --upstream-cwd <dir>           Working directory for the upstream process\n` +
      `  --upstream-env-var KEY=VALUE   One env var for the upstream process; repeatable.\n` +
      `                                  The value may contain commas.\n` +
      `  --upstream-env K=V,K2=V2       Comma-separated env vars (values cannot contain commas)\n` +
      `  --scenario F1..F5              Activate one deterministic scenario\n` +
      `  --mode deterministic|chaos     chaos = stochastic error injection (needs --error-rate)\n` +
      `  --error-rate <0..1>            Error probability in chaos mode\n` +
      `  --retry-after <seconds>        retry_after announced by F2's 429 (default: 60;\n` +
      `                                  only with --scenario F2)\n` +
      `  --write-tools pat1,pat2,...    Glob patterns ("*") for tool names that count as\n` +
      `                                  writes. Replaces the default verb list (write*,\n` +
      `                                  create_*, send_*, book_*, pay_*, transfer_*, ...).\n` +
      `  --read-tools pat1,pat2,...     Extra glob patterns for tool names that count as reads\n` +
      `  --key-fields a,b               Argument names that carry an idempotency key\n` +
      `                                  (default: idempotency_key, any case/separator)\n` +
      `  --audit-tools on|off           Expose cuonztech__get_report / cuonztech__get_score\n` +
      `                                  to the connected agent (default: on)\n` +
      `  --report-file <path>           Write report + score as JSON to this file after every\n` +
      `                                  call and on shutdown (for CI)\n\n` +
      `Options may be written as "--flag value" or "--flag=value".\n\n` +
      `Tool classification in proxy mode: explicit flags first, then the upstream's own\n` +
      `MCP annotations (readOnlyHint/destructiveHint), then name patterns. The result is\n` +
      `printed to stderr at startup; unclassified tools are passed through but not scored.\n\n` +
      `The proxy is a long-running server: its exit code says nothing about the verdict.\n` +
      `Read the verdict from --report-file.\n\n` +
      `${COMING_SOON_NOTICE}\n`,
  );
}

type FlagKind = "single" | "multi";

// Strict flag parsing: an unknown flag, a flag without a value, a repeated
// single-value flag and a stray positional argument are all errors. The old
// indexOf()-based lookup silently ignored typos like "--scenaro F1" — the
// run then tested nothing while looking normal.
function parseFlags(
  argv: string[],
  spec: Record<string, FlagKind>,
): { values: Map<string, string[]> } | { error: string } | { help: true } {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    // Only where an option is expected — as the VALUE of an option (e.g.
    // --upstream-arg --help) it is passed on, not interpreted.
    if (token === "--help" || token === "-h") {
      return { help: true };
    }
    if (!token.startsWith("--")) {
      return { error: `unexpected argument "${token}".` };
    }
    // "--flag=value" form
    let inlineValue: string | undefined;
    const eq = token.indexOf("=");
    if (eq !== -1 && spec[token.slice(0, eq)]) {
      inlineValue = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const kind = spec[token];
    if (!kind) {
      return { error: `unknown option "${token}".` };
    }
    let value: string | undefined;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined) {
      return { error: `option ${token} needs a value.` };
    }
    // An empty value is almost always a broken shell variable; treating it
    // as "flag not given" would silently change what the run tests.
    // (--upstream-arg is the exception: an empty string is a legitimate
    // argument to hand to the upstream command.)
    if (value.trim() === "" && token !== "--upstream-arg") {
      return { error: `option ${token} was given an empty value.` };
    }
    const existing = values.get(token);
    if (existing) {
      if (kind === "single") {
        return { error: `option ${token} was given more than once.` };
      }
      existing.push(value);
    } else {
      values.set(token, [value]);
    }
  }
  return { values };
}

// Set as soon as proxy mode knows where its --report-file goes, so that ANY
// failed start — including a rejected command line — replaces a report left
// over from an earlier run instead of leaving its old PASS in place.
let startupReportFile: string | null = null;

function writeStartupFailureSync(reason: string): void {
  if (!startupReportFile) return;
  try {
    if (statSync(startupReportFile, { throwIfNoEntry: false })?.isDirectory()) return;
    mkdirSync(dirname(startupReportFile), { recursive: true });
    writeFileSync(
      startupReportFile,
      JSON.stringify(
        {
          harnessVersion: VERSION,
          certification: "UNVERIFIED_FOR_PRODUCTION",
          verdict: "NOT_TESTED",
          startupError: reason,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );
  } catch {
    // The start already failed; the original error is what gets reported.
  }
}

function fail(message: string): never {
  writeStartupFailureSync(message);
  process.stderr.write(`Error: ${message}\nRun with --help for usage.\n`);
  process.exit(1);
}

// Windows device names: writing to "NUL" or "CON" as a relative path can
// create a real file of that name (or block on a device).
function isReservedFileName(path: string): boolean {
  return (
    process.platform === "win32" &&
    /^(nul|con|prn|aux|com[1-9]|lpt[1-9])(\..*)?$/i.test(basename(path))
  );
}

// Best-effort lookup of --report-file before the full parse, so a command
// line that is rejected by the parser still updates that file.
function peekReportFile(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--report-file" && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith("--report-file=")) return argv[i].slice("--report-file=".length) || null;
  }
  return null;
}

function splitList(raw: string | undefined, flag: string): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(",").map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) {
    fail(`${flag} contains no pattern/name.`);
  }
  return parts;
}

async function main(): Promise<void> {
  const mode = args[0];

  if (mode === "--help" || mode === "-h" || mode === "help") {
    printHelp();
  } else if (mode === "--version" || mode === "-v") {
    process.stdout.write(`${VERSION}\n`);
  } else if (mode === "benchmark" || mode === "evaluate") {
    await runBenchmarkMode(args.slice(1));
  } else if (mode === "proxy") {
    await runProxyMode(args.slice(1));
  } else if (mode === undefined) {
    // Default: MCP server mode (stdio)
    const server = createServer();
    await startStdio(server);
  } else {
    fail(`unknown command "${mode}". Commands: benchmark, proxy, --help (no command = MCP server).`);
  }
}

const PROXY_FLAGS: Record<string, FlagKind> = {
  "--upstream-command": "single",
  "--upstream-args": "single",
  "--upstream-arg": "multi",
  "--upstream-cwd": "single",
  "--upstream-env": "single",
  "--upstream-env-var": "multi",
  "--scenario": "single",
  "--mode": "single",
  "--error-rate": "single",
  "--retry-after": "single",
  "--write-tools": "single",
  "--read-tools": "single",
  "--key-fields": "single",
  "--audit-tools": "single",
  "--report-file": "single",
};

function parseEnvPair(pair: string, flag: string, into: Record<string, string>): void {
  const eq = pair.indexOf("=");
  const key = eq === -1 ? "" : pair.slice(0, eq).trim();
  if (key === "") {
    fail(`${flag} entry "${pair}" is not KEY=VALUE.`);
  }
  into[key] = pair.slice(eq + 1);
}

async function runProxyMode(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, PROXY_FLAGS);
  if ("help" in parsed) {
    printHelp();
    return;
  }
  const peeked = peekReportFile(argv);
  if (peeked && peeked.trim() !== "" && !isReservedFileName(peeked)) {
    startupReportFile = peeked;
  }
  if ("error" in parsed) fail(parsed.error);
  const one = (name: string): string | undefined => parsed.values.get(name)?.[0];
  const many = (name: string): string[] => parsed.values.get(name) ?? [];

  const upstreamCommand = one("--upstream-command");
  if (!upstreamCommand) {
    fail(
      "proxy mode requires --upstream-command <cmd>\n" +
        "Example: cuonztech-agent-harness proxy --upstream-command node --upstream-arg dist/server.js",
    );
  }

  const upstreamArgs = [
    ...(one("--upstream-args") ? one("--upstream-args")!.split(",") : []),
    ...many("--upstream-arg"),
  ];

  const upstreamEnv: Record<string, string> = {};
  const envList = one("--upstream-env");
  if (envList !== undefined) {
    for (const pair of envList.split(",")) parseEnvPair(pair, "--upstream-env", upstreamEnv);
  }
  for (const pair of many("--upstream-env-var")) {
    parseEnvPair(pair, "--upstream-env-var", upstreamEnv);
  }

  const scenarioId = one("--scenario");
  if (scenarioId !== undefined && !getScenarioById(scenarioId)) {
    fail(
      `unknown scenario "${scenarioId}". Valid: ${ALL_SCENARIOS.map((s) => s.id).join(", ")}`,
    );
  }

  const modeRaw = one("--mode");
  if (modeRaw !== undefined && modeRaw !== "deterministic" && modeRaw !== "chaos") {
    fail(`--mode must be "deterministic" or "chaos", got "${modeRaw}".`);
  }
  const chaosMode: "deterministic" | "chaos" = modeRaw === "chaos" ? "chaos" : "deterministic";

  const errorRateRaw = one("--error-rate");
  let errorRate = 0.0;
  if (errorRateRaw !== undefined) {
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(errorRateRaw) || Number(errorRateRaw) > 1) {
      fail(`--error-rate must be a number between 0 and 1, got "${errorRateRaw}".`);
    }
    if (chaosMode !== "chaos") {
      fail("--error-rate only has an effect together with --mode chaos.");
    }
    errorRate = Number(errorRateRaw);
  }

  if (scenarioId !== undefined && chaosMode === "chaos") {
    fail(
      "--scenario and --mode chaos cannot be combined: a scenario is deterministic, " +
        "and with both set the chaos mode would never inject anything.",
    );
  }

  const retryAfterRaw = one("--retry-after");
  let retryAfterSec: number | undefined;
  if (retryAfterRaw !== undefined) {
    const value = Number(retryAfterRaw);
    if (!/^(\d+(\.\d+)?|\.\d+)$/.test(retryAfterRaw) || value <= 0 || value > 86_400) {
      fail(
        `--retry-after must be a positive number of seconds (at most 86400), got "${retryAfterRaw}".`,
      );
    }
    if (scenarioId !== "F2") {
      fail("--retry-after only has an effect together with --scenario F2.");
    }
    retryAfterSec = value;
  }

  const auditToolsRaw = one("--audit-tools");
  if (auditToolsRaw !== undefined && auditToolsRaw !== "on" && auditToolsRaw !== "off") {
    fail(`--audit-tools must be "on" or "off", got "${auditToolsRaw}".`);
  }
  const auditTools = auditToolsRaw !== "off";

  const reportFile = one("--report-file");
  const writeToolPatterns = splitList(one("--write-tools"), "--write-tools");
  const readToolPatterns = splitList(one("--read-tools"), "--read-tools");
  const keyFields = splitList(one("--key-fields"), "--key-fields");

  const upstreamCwd = one("--upstream-cwd");
  if (upstreamCwd !== undefined) {
    const info = await stat(upstreamCwd).catch(() => null);
    if (!info || !info.isDirectory()) {
      fail(`--upstream-cwd "${upstreamCwd}" is not an existing directory.`);
    }
  }
  if (reportFile !== undefined) {
    if (isReservedFileName(reportFile)) {
      fail(`--report-file "${reportFile}" is a reserved device name, not a usable file.`);
    }
    const info = await stat(reportFile).catch(() => null);
    if (info?.isDirectory()) {
      fail(`--report-file "${reportFile}" is a directory, not a file.`);
    }
  }

  const log = (line: string): void => {
    process.stderr.write(`[cuonztech-agent-harness] ${line}\n`);
  };

  if (chaosMode === "chaos" && errorRate === 0) {
    log(
      "WARNING: --mode chaos with a 0% error rate — this run will inject nothing. " +
        "Pass e.g. --error-rate 0.2 to actually trigger stochastic failures.",
    );
  }

  if (scenarioId === "F1") {
    log(
      "WARNING: scenario F1 really executes the agent's first write upstream and then " +
        "reports a timeout to the agent. Only point --upstream-command at a disposable " +
        "test/staging backend, never production.",
    );
  } else if (scenarioId || chaosMode === "chaos") {
    log(
      "WARNING: failure injection is active — the agent will receive errors for calls " +
        "that were never sent upstream. Every other write is executed for real. Only " +
        "point --upstream-command at a disposable test/staging backend, never production.",
    );
  }
  if (!scenarioId && chaosMode !== "chaos") {
    log(
      "NOTE: no --scenario and no chaos mode — calls are passed through unchanged. A " +
        "result from this run is a baseline, not a resilience test.",
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
    readToolPatterns,
    keyFields,
    retryAfterSec,
  });

  try {
    await interceptor.connectUpstream();
  } catch (err) {
    const tail = interceptor.getUpstreamStderrTail().trim();
    const reason =
      `could not start or connect to the upstream MCP server ` +
      `("${upstreamCommand}${upstreamArgs.length > 0 ? " " + upstreamArgs.join(" ") : ""}"): ` +
      `${err instanceof Error ? err.message : String(err)}`;
    fail(
      reason +
        (tail.length > 0
          ? `\nUpstream stderr:\n${tail}`
          : "\nThe upstream wrote nothing to stderr. Check the command, its arguments and that it speaks MCP over stdio."),
    );
  }

  const upstreamTools = interceptor.getUpstreamTools();

  const collisions = findToolNameCollisions(upstreamTools);
  if (auditTools && collisions.length > 0) {
    await interceptor.disconnectUpstream();
    fail(
      `the upstream already has tool(s) named ${collisions.join(", ")}, which collide with ` +
        "the harness's own audit tools. Start with --audit-tools off (and --report-file to " +
        "collect the result).",
    );
  }

  // Say what each upstream tool was taken for. Scoring depends entirely on
  // this, and a wrong or missing classification is otherwise invisible.
  const classification = interceptor.getToolClassification();
  log(`Upstream tools (${classification.length}):`);
  for (const entry of classification) {
    log(`  ${entry.class.padEnd(12)} ${entry.name}  (${entry.source})`);
  }
  for (const entry of classification.filter((c) => c.class === "unclassified")) {
    log(
      `WARNING: tool "${entry.name}" could not be classified as read or write. Its calls ` +
        "are passed through but never trigger a scenario and are not scored — if it writes, " +
        `duplicates through it stay undetected. Classify it with --write-tools "${entry.name}" ` +
        `or --read-tools "${entry.name}".`,
    );
  }
  if (upstreamTools.length > 0 && !classification.some((c) => c.class === "write")) {
    log(
      `WARNING: none of the upstream's ${upstreamTools.length} tool(s) ` +
        `(${upstreamTools.map((t) => t.name).join(", ")}) is classified as a write. ` +
        "Scenarios will NEVER trigger for this upstream and every report will read NOT_TESTED. " +
        'If your write tools use different naming, pass e.g. --write-tools "yourprefix_*".',
    );
  }
  const keyCapable = interceptor.getKeyCapableTools();
  log(
    keyCapable.length > 0
      ? `Idempotency-key argument recognized on: ${keyCapable.join(", ")}`
      : "NOTE: no upstream tool has an argument recognized as an idempotency key " +
          "(looked for: " +
          (keyFields ?? ["idempotency_key"]).join(", ") +
          "). " +
          (keyFields
            ? "Check the names given to --key-fields against the tools' input schemas."
            : "If your tools use another name (request_id, client_token, ...), pass " +
              "--key-fields — otherwise a retry under a new such value looks like a different operation."),
  );
  log(
    "Only tools are proxied. The upstream's resources, prompts and notifications are not forwarded.",
  );
  if (auditTools && (scenarioId || chaosMode === "chaos")) {
    log(
      "NOTE: the audit tools (cuonztech__get_report, cuonztech__get_score) are visible to " +
        "the connected agent and reveal what really happened upstream. For a measurement " +
        "the agent must not be able to peek: use --audit-tools off with --report-file.",
    );
  }
  if (!auditTools && !reportFile) {
    log(
      "WARNING: --audit-tools off without --report-file — this run has no way to hand " +
        "out its result.",
    );
  }

  // --report-file: rewritten after every call (a proxy is usually killed,
  // not shut down politely, so waiting for exit would lose the result).
  // Writes are chained so they cannot overlap, and go through a temp file
  // so a reader never sees a half-written report.
  let pendingWrite: Promise<void> = Promise.resolve();
  let reportWriteFailed = false;
  const writeReportFile = (): Promise<void> => {
    if (!reportFile) return Promise.resolve();
    pendingWrite = pendingWrite.then(async () => {
      const report = generateReport(interceptor.getSession());
      const score = computeScore([report]);
      const patches = generatePatches([report], score);
      const body = JSON.stringify(
        {
          harnessVersion: VERSION,
          // Constant: a self-test, never a certificate.
          certification: "UNVERIFIED_FOR_PRODUCTION",
          // The audit verdict (PASS / FAIL / NOT_TESTED), same as report.verdict.
          verdict: report.verdict,
          report,
          score,
          patches,
          toolClassification: classification,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      try {
        await mkdir(dirname(reportFile), { recursive: true });
        const tmp = `${reportFile}.tmp`;
        await writeFile(tmp, body, "utf-8");
        await rename(tmp, reportFile);
      } catch (err) {
        if (!reportWriteFailed) {
          reportWriteFailed = true;
          log(`WARNING: could not write --report-file "${reportFile}": ${err}`);
        }
      }
    });
    return pendingWrite;
  };
  if (reportFile) {
    interceptor.onCallRecorded = () => {
      void writeReportFile();
    };
    await writeReportFile();
    if (reportWriteFailed) {
      await interceptor.disconnectUpstream();
      fail(`cannot write --report-file "${reportFile}".`);
    }
  }

  interceptor.onUpstreamLost = (stderrTail) => {
    log(
      "ERROR: the upstream MCP server process exited or closed its connection. Every " +
        "further tool call is answered with UPSTREAM_UNAVAILABLE; the proxy does not " +
        "restart it.",
    );
    if (stderrTail.trim().length > 0) {
      log(`Last upstream stderr output:\n${stderrTail.trimEnd()}`);
    }
  };

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await writeReportFile();
    await interceptor.disconnectUpstream();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The client closing our stdin is the normal way an MCP stdio session
  // ends; without this the proxy (and its upstream child) would linger.
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  startupReportFile = null;
  const server = createProxyServer(interceptor, { auditTools });
  await startStdio(server);
}

const BENCHMARK_FLAGS: Record<string, FlagKind> = {
  "--runs": "single",
  "--jitter": "single",
  "--scenarios": "single",
};

async function runBenchmarkMode(argv: string[]): Promise<void> {
  const parsed = parseFlags(argv, BENCHMARK_FLAGS);
  if ("help" in parsed) {
    printHelp();
    return;
  }
  if ("error" in parsed) fail(parsed.error);
  const one = (name: string): string | undefined => parsed.values.get(name)?.[0];

  const config = defaultConfig();

  // Strict integer parsing: parseInt() alone is too lenient (parseInt("1.5")
  // silently truncates to 1 instead of being rejected) — only a string
  // matching /^-?\d+$/ counts as a valid integer here.
  function parseStrictInt(raw: string): number | null {
    return /^-?\d+$/.test(raw) ? parseInt(raw, 10) : null;
  }

  const runsRaw = one("--runs");
  if (runsRaw !== undefined) {
    const value = parseStrictInt(runsRaw);
    if (value === null || value < 1 || value > 1000) {
      fail(`--runs must be a positive integer (at most 1000), got "${runsRaw}".`);
    }
    config.runsPerScenario = value;
  }
  const jitterRaw = one("--jitter");
  if (jitterRaw !== undefined) {
    const value = parseStrictInt(jitterRaw);
    if (value === null || value < 0 || value > 60_000) {
      fail(`--jitter must be a non-negative integer (ms, at most 60000), got "${jitterRaw}".`);
    }
    config.jitterMs = value;
  }
  const scenariosRaw = one("--scenarios");
  if (scenariosRaw !== undefined) {
    config.scenarios = [...new Set(scenariosRaw.split(",").map((s) => s.trim()))];
  }

  const unknown = config.scenarios.filter((id) => !getScenarioById(id));
  if (unknown.length > 0) {
    fail(
      `unknown scenario(s) "${unknown.join(", ")}". ` +
        `Valid: ${ALL_SCENARIOS.map((s) => s.id).join(", ")}`,
    );
  }

  process.stdout.write(`CuonzTech Agent-Harness Benchmark\n`);
  process.stdout.write(
    "NOTE: this replays two fixed built-in reference agents — it does NOT\n" +
      "connect to or measure your own agent. It is a self-test of the harness:\n" +
      "it checks that each reference agent gets the verdict expected for it. To\n" +
      "score YOUR agent, put the harness in front of your MCP server with `proxy` mode.\n\n",
  );
  process.stdout.write(`Scenarios: ${config.scenarios.join(", ")}\n`);
  process.stdout.write(`Runs per scenario: ${config.runsPerScenario}\n`);
  process.stdout.write(`Jitter: ${config.jitterMs}ms\n\n`);

  const result = await runBenchmark(config);

  const printRun = (title: string, run: ReferenceRun): void => {
    process.stdout.write(`${"#".repeat(60)}\n${title}\n${"#".repeat(60)}\n\n`);
    process.stdout.write(run.markdownScore + "\n");
    process.stdout.write(formatCTA(run.score) + "\n\n");
    if (run.patches.length > 0) {
      process.stdout.write(run.markdownPatches + "\n");
    }
  };

  printRun(
    "Reference agent 1/2: CAREFUL (checks after a failure, never re-sends blindly)",
    result.careful,
  );
  printRun(
    "Reference agent 2/2: NAIVE (re-sends every write immediately, no key)",
    result.naive,
  );

  if (result.selfTest.passed) {
    const separating = config.scenarios.filter((id) => ["F1", "F2", "F4"].includes(id));
    process.stdout.write(
      "Self-test PASSED: every run got the verdict expected for its reference agent.\n" +
        (separating.length > 0
          ? `The naive agent is expected to fail in ${separating.join(", ")} and did.\n`
          : "Note: in the selected scenarios (F3/F5) the failed attempt never executes, so an " +
            "immediate retry is harmless and BOTH reference agents are expected to pass — " +
            "this selection does not show the harness telling them apart.\n"),
    );
  } else {
    process.stdout.write(
      "Self-test FAILED — the harness did not judge its own reference agents as expected:\n" +
        result.selfTest.mismatches.map((m) => `  - ${m}`).join("\n") +
        "\n",
    );
  }

  // Save JSON report
  const reportDir = ".cuonztech";
  const jsonPath = `${reportDir}/benchmark-report.json`;
  const serializeRun = (run: ReferenceRun) => ({
    ...buildTelemetry(run.score, run.patches),
    score: run.score,
    patches: run.patches.map((p) => ({
      category: p.category,
      severity: p.severity,
      trigger: p.trigger,
      promptSnippet: p.promptSnippet,
    })),
    reports: run.reports,
  });
  // The exit code reflects the self-test only; a report that cannot be
  // written is a warning, not a different test result.
  try {
   await mkdir(reportDir, { recursive: true });
   await writeFile(
    jsonPath,
    JSON.stringify(
      {
        // Same constant under both names: `certification` matches the
        // proxy's report file, `verdict` is kept for readers of older reports.
        certification: "UNVERIFIED_FOR_PRODUCTION",
        verdict: "UNVERIFIED_FOR_PRODUCTION",
        isReferenceRun: true,
        note:
          "Self-test of the harness with two built-in reference agents. Neither score " +
          "says anything about your own agent.",
        selfTest: result.selfTest,
        careful: serializeRun(result.careful),
        naive: serializeRun(result.naive),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
   );
   process.stdout.write(`\nReport saved to ${jsonPath}\n`);
  } catch (err) {
    process.stderr.write(
      `Warning: could not write ${jsonPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  process.stdout.write(`\n${COMING_SOON_NOTICE}\n`);

  // Exit code reflects the self-test, not a score: 0 = the harness judged
  // both reference agents as expected.
  process.exit(result.selfTest.passed ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
