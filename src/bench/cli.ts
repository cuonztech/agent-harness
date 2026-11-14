// Befehl `bench`: Befehlszeile, Lizenz-Sperre, Vorbedingungen (nichts wird geschrieben, bevor sie erfüllt sind), Ausgabe.
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lockedNotice, resolveProGate } from "../license/index.js";
import { VERSION } from "../version.js";
import { redactSecrets } from "../cli-args.js";
import { describeFsError, fileInPathAbove } from "../fs-errors.js";
import { BENCH_HELP, BENCH_USAGE, DEFAULT_SYSTEM_PROMPT_DE, parseBenchArgs, type BenchOptions } from "./args.js";
import { runBench, type BenchRunInput } from "./run.js";
import { summaryLines } from "./report.js";

const WARNING_DE =
  "ACHTUNG: bench führt die Schreibvorgänge des Agenten wirklich am Upstream aus und löst absichtlich Fehler, Wiederholungen und Verzögerungen aus. " +
  "Nur Testsystem mit synthetischen Daten, keine Produktivumgebung (LICENSE Ziffer 4a). Mit --allow-writes bestätigst du das.";

// Einfache Anführungszeichen: gelten in bash und PowerShell 7 und schützen Klammern, Leerzeichen und spitze Klammern der Platzhalter.
const quote = (s: string): string => (/^[\w.:/@=,+-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);

const leafOf = (path: string): string => path.split(/[\\/]/).filter((p) => p !== "").pop() ?? path;
const isPathLike = (a: string): boolean => /^[A-Za-z]:[\\/]/.test(a) || a.startsWith("\\\\") || a.startsWith("/") || /^\.{1,2}[\\/]/.test(a) || (/[\\/]/.test(a) && !/^-/.test(a));
const SECRET_FLAG = /(key|token|secret|passw|auth|bearer)/i;

/** Ein Argument für den Befehl: lokale Pfade werden Platzhalter (mit dem Dateinamen), Werte hinter Schlüssel-Optionen gehen nicht in den Befehl. */
function placeholderArg(arg: string, previous: string | undefined, pathName: string): string {
  const eq = arg.startsWith("-") ? arg.indexOf("=") : -1;
  if (eq !== -1) {
    const name = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    if (SECRET_FLAG.test(name)) return `${name}=<Wert>`;
    return isPathLike(value) ? `${name}=<${pathName}>/${leafOf(value)}` : redactSecrets(arg);
  }
  if (previous !== undefined && previous.startsWith("-") && !previous.includes("=") && SECRET_FLAG.test(previous)) return "<Wert>";
  return isPathLike(arg) ? `<${pathName}>/${leafOf(arg)}` : redactSecrets(arg);
}

/** Der Wert einer Umgebungsvariable des Upstreams: nur Werte aus den Platzhaltern des Harness ({RUN_DIR}, {RUN_ID}, mit Dateiendung) bleiben, jeder andere Wert steht als «<Wert>». */
function placeholderEnv(entry: [string, string]): string {
  const [name, value] = entry;
  return `${name}=${/^(?:(?:\{RUN_DIR\}[\\/])?\{RUN_ID\}|\{RUN_DIR\}[\\/]?)[\w.-]*$/.test(value) ? value : "<Wert>"}`;
}

export const REPRODUCTION_NOTE_DE =
  "(Lokale Pfade stehen als Platzhalter in spitzen Klammern, zum Beispiel <Pfad-zum-Testsystem>; vor dem Ausführen durch deine Pfade ersetzen. Werte von Umgebungsvariablen des Upstreams stehen als <Wert>, bei --api-key-env nur der Name der Variable. Nicht im Befehl: Lizenzcode (--license oder Umgebungsvariable AGENT_AUDIT_LICENSE) und API-Schlüssel.)";

/**
 * Der Befehl, der die Messung wiederholt, aus den tatsächlich verwendeten Optionen: ohne Lizenzcode und API-Schlüsselwert, Umgebungsvariablen
 * nur als Name, lokale Pfade als lesbare Platzhalter (der Text darunter sagt es).
 */
export function reproductionCommand(options: BenchOptions, task: string | null, followup: string | null): string {
  const up = options.upstream;
  const parts: string[] = ["cuonztech-agent-harness", "bench", "--upstream-command", leafOf(up.command)];
  up.args.forEach((a, i) => parts.push("--upstream-arg", placeholderArg(a, up.args[i - 1], "Pfad-zum-Testsystem")));
  if (up.cwd !== null) parts.push("--upstream-cwd", "<Arbeitsordner-des-Testsystems>");
  for (const entry of Object.entries(up.env)) parts.push("--upstream-env-var", placeholderEnv(entry));
  if (options.probe) {
    parts.push("--effect-probe", options.probe.tool);
    if (options.probe.argsRaw !== null) parts.push("--effect-probe-args", redactSecrets(options.probe.argsRaw));
    if (options.probe.countPath !== null) parts.push("--effect-count", options.probe.countPath);
    if (options.probe.tools.length > 0) parts.push("--effect-tools", options.probe.tools.join(","));
  }
  if (options.writeTools) parts.push("--write-tools", options.writeTools.join(","));
  if (options.readTools) parts.push("--read-tools", options.readTools.join(","));
  if (options.keyFields) parts.push("--key-fields", options.keyFields.join(","));
  parts.push("--allow-writes");
  const agent = options.agent;
  if (agent.kind === "builtin") {
    parts.push("--model", agent.model, "--api", agent.api, "--url", new URL(agent.url).origin);
    if (agent.apiKeyEnv !== null) parts.push("--api-key-env", agent.apiKeyEnv);
    if (agent.systemPromptFile !== null) parts.push("--system-prompt-file", "<Pfad-zur-System-Prompt-Datei>");
    if (agent.temperature !== null) parts.push("--temperature", String(agent.temperature));
    if (agent.think !== null) parts.push("--think", agent.think);
    parts.push("--max-steps", String(agent.maxSteps));
  } else {
    parts.push("--agent-command", leafOf(agent.command));
    agent.args.forEach((a, i) => parts.push("--agent-arg", placeholderArg(a, agent.args[i - 1], "Pfad-zum-Agenten")));
  }
  if (task !== null) parts.push("--task", redactSecrets(task));
  // Die Nachfrage gehört zu F1: Ohne F1 gibt es sie nicht (und die Option gilt dann nicht).
  if (options.scenarios.includes("F1")) parts.push("--followup", followup === null ? "none" : redactSecrets(followup));
  parts.push("--scenario", options.scenarios.join(","), "--conditions", options.conditions.join(","), "--patch-lang", options.patchLang, "--runs", String(options.runs));
  if (options.scenarios.includes("F2")) parts.push("--retry-after", String(options.retryAfterSec), "--max-retry-wait", String(options.maxRetryWaitSec));
  parts.push("--run-timeout", String(options.runTimeoutSec), "--step-timeout", String(options.stepTimeoutSec), "--out", "<Ausgabeordner>");
  return `${parts.map(quote).join(" ")}
${REPRODUCTION_NOTE_DE}`;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runBenchMode(argv: string[], proxyEntry?: string): Promise<number> {
  const parsed = parseBenchArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(BENCH_HELP);
    return 0;
  }
  if ("error" in parsed) {
    process.stderr.write(`Fehler: ${parsed.error}\n${BENCH_USAGE}`);
    return 1;
  }
  const { options } = parsed;

  // Pro-Umfang: ohne gültige Lizenz läuft bench nicht und fasst keine Datei an.
  const gate = resolveProGate(options.license);
  if (!gate.pro) {
    process.stderr.write(lockedNotice("bench", gate.verdict));
    return 1;
  }
  if (!options.allowWrites) {
    process.stderr.write(
      "Fehler: Diese Messung schreibt wirklich: Der Agent führt seine Schreibvorgänge am Upstream aus, und der Harness löst absichtlich einen Timeout nach dem ersten Schreibvorgang aus.\n" +
        "Nur gegen ein Testsystem mit synthetischen Daten, nie gegen Produktion. Zeigt --upstream-command auf ein solches System, bestätige das mit --allow-writes.\n",
    );
    return 1;
  }

  let apiKey: string | null = null;
  let baseSystemPrompt = DEFAULT_SYSTEM_PROMPT_DE;
  let systemPromptSource: "standard" | "datei" = "standard";
  if (options.agent.kind === "builtin") {
    if (options.agent.apiKeyEnv !== null) {
      const value = process.env[options.agent.apiKeyEnv];
      if (value === undefined || value.trim() === "") {
        process.stderr.write(`Fehler: Die Umgebungsvariable ${options.agent.apiKeyEnv} (--api-key-env) ist nicht gesetzt oder leer.\n`);
        return 1;
      }
      apiKey = value.trim();
    }
    if (options.agent.systemPromptFile !== null) {
      try {
        const text = (await readFile(options.agent.systemPromptFile, "utf8")).trim();
        if (text === "") throw new Error("leer");
        baseSystemPrompt = text;
        systemPromptSource = "datei";
      } catch {
        process.stderr.write(`Fehler: Die System-Prompt-Datei ${basename(options.agent.systemPromptFile)} (--system-prompt-file) lässt sich nicht lesen oder ist leer.\n`);
        return 1;
      }
    }
  }

  // Ausgabeordner: nie ein bestehender, nicht leerer Ordner ohne --force.
  const outDir = resolve(options.out ?? `bench-${stamp()}`);
  // Liegt der Pfad unter einer Datei, entstünde der Ordner nie: vor der Messung melden (sonst «Fatal: ENOTDIR» nach dem Start).
  const blocking = fileInPathAbove(outDir);
  if (blocking !== null) {
    process.stderr.write(`Fehler: --out ${outDir} liegt unter einer Datei (${blocking}); ein Teil des Pfads ist kein Ordner. Wähle einen Ordner, der existiert oder angelegt werden kann.\nEs wurde nichts geschrieben.\n`);
    return 1;
  }
  if (existsSync(outDir)) {
    const info = await stat(outDir);
    if (!info.isDirectory()) {
      process.stderr.write(`Fehler: --out ${basename(outDir)} ist eine Datei, kein Ordner.\n`);
      return 1;
    }
    const entries = await readdir(outDir);
    if (entries.length > 0 && !options.force) {
      process.stderr.write(
        `Fehler: Der Ausgabeordner ${outDir} ist nicht leer. Wähle einen neuen Ordner mit --out, oder gib --force an: Dann werden bench-report.json, bench-report.md und runs/ nach _vorher-<Zeit>/ verschoben (nichts wird gelöscht).\n`,
      );
      return 1;
    }
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const secrets = [options.license, process.env.AGENT_AUDIT_LICENSE, process.env.CUONZTECH_LICENSE_KEY].filter((s): s is string => typeof s === "string" && s.trim() !== "");
  const log = (line: string): void => {
    process.stderr.write(`[bench] ${line}\n`);
  };
  process.stderr.write(`${WARNING_DE}\n`);
  const input: BenchRunInput = {
    options,
    apiKey,
    secrets,
    outDir,
    proxyEntry: proxyEntry ?? fileURLToPath(new URL("../index.js", import.meta.url)),
    baseSystemPrompt,
    systemPromptSource,
    licenseStatus: "gültig (Pro)",
    log,
    signal: controller.signal,
    reproduction: reproductionCommand(options, options.task, options.followup),
  };
  let outcome: Awaited<ReturnType<typeof runBench>>;
  try {
    outcome = await runBench(input);
  } catch (err) {
    // Ein Pfad, der sich nicht anlegen oder beschreiben lässt, ist kein Programmfehler: ein Satz mit Ursache.
    const friendly = describeFsError(err, "de");
    if (friendly === null) throw err;
    process.stderr.write(`Fehler: ${friendly}\n`);
    return 1;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  if (outcome.status === "fehler") {
    process.stderr.write(`Fehler: ${outcome.error}\nEs wurde nichts geschrieben.\n`);
    return 1;
  }
  const doc = outcome.document;
  process.stdout.write(`CuonzTech Agent-Harness ${VERSION} · Mehrlauf-Messung (bench)\n`);
  if (outcome.status === "abgebrochen") process.stdout.write(`ABGEBROCHEN: ${doc.abortReason}\n`);
  for (const line of summaryLines(doc)) process.stdout.write(`${line}\n`);
  process.stdout.write(`Bericht: ${outcome.jsonPath}\nLesetext: ${outcome.mdPath}\nLäufe: ${resolve(outDir, "runs")}\n`);
  if (doc.integrity) process.stdout.write(`Prüfsumme (SHA-256): ${doc.integrity.payloadSha256}\nPrüfen: cuonztech-agent-harness verify ${outcome.jsonPath}\n`);
  return outcome.status === "abgeschlossen" ? 0 : 1;
}
