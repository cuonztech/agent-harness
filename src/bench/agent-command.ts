// Vertrag für `--agent-command`: ein eigener Agent, den der Harness je Lauf als Prozess startet.
//
// Umgebung:   HARNESS_MCP_COMMAND, HARNESS_MCP_ARGS (JSON-Liste): so startet der Agent den Proxy als MCP-Server (stdio);
//             HARNESS_TASK, HARNESS_FOLLOWUP (leer = keine Nachfrage), HARNESS_SYSTEM_PROMPT_EXTRA (Textbaustein oder leer).
// Aufgabe:    Der Agent erledigt Aufgabe UND Nachfrage selbst und schreibt seine Antworten nach stdout
//             (Zeilen «ANSWER_1:» und «ANSWER_2:»; fehlen beide, gilt der ganze stdout als Antwort 2) und beendet sich mit Exit 0.
// Nie:        Lizenz- und Schlüsselmaterial des Kunden wird weder an den Agenten gereicht noch ausgegeben.
import { spawn } from "node:child_process";

// Umgebungsvariablen, die der Harness dem Agenten nicht weitergibt.
const WITHHELD = ["AGENT_AUDIT_LICENSE", "AGENT_AUDIT_LICENSE_PUBLIC_KEY", "AGENT_AUDIT_ALLOW_TEST_KEY", "CUONZTECH_LICENSE_KEY", "CPCG_LICENSE_KEY"];

export interface ParsedAgentOutput {
  answer1: string | null;
  answer2: string | null;
}

/** Zerlegt stdout eines Agenten in die Antworten 1 und 2. */
export function parseAgentOutput(stdout: string): ParsedAgentOutput {
  const text = stdout.replace(/\r\n/g, "\n");
  const marker = /^[ \t]*ANSWER_([12]):[ \t]?/gm;
  const hits: Array<{ n: 1 | 2; start: number; end: number }> = [];
  for (let m = marker.exec(text); m !== null; m = marker.exec(text)) {
    hits.push({ n: m[1] === "1" ? 1 : 2, start: m.index, end: m.index + m[0].length });
  }
  if (hits.length === 0) {
    const whole = text.trim();
    return { answer1: null, answer2: whole === "" ? null : whole };
  }
  const out: ParsedAgentOutput = { answer1: null, answer2: null };
  hits.forEach((hit, i) => {
    const next = hits[i + 1];
    const body = text.slice(hit.end, next ? next.start : text.length).trim();
    const key = hit.n === 1 ? "answer1" : "answer2";
    if (body !== "") out[key] = out[key] === null ? body : `${out[key]}\n${body}`;
  });
  return out;
}

export interface AgentProcessInput {
  command: string;
  args: string[];
  proxyCommand: string;
  proxyArgs: string[];
  task: string;
  followup: string | null;
  systemPromptExtra: string;
  timeoutMs: number;
  cwd?: string;
}

export interface AgentProcessResult {
  code: number | null;
  stdout: string;
  stderrTail: string;
  timedOut: boolean;
  spawnError: string | null;
}

const MAX_STDOUT = 1024 * 1024;
const STDERR_TAIL = 4096;

/** Die Umgebung des Agenten: die des Harness ohne Lizenzmaterial, dazu die HARNESS_*-Variablen des Vertrags. */
export function agentEnvironment(input: Pick<AgentProcessInput, "proxyCommand" | "proxyArgs" | "task" | "followup" | "systemPromptExtra">, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !WITHHELD.includes(key)) env[key] = value;
  }
  env.HARNESS_MCP_COMMAND = input.proxyCommand;
  env.HARNESS_MCP_ARGS = JSON.stringify(input.proxyArgs);
  env.HARNESS_TASK = input.task;
  env.HARNESS_FOLLOWUP = input.followup ?? "";
  env.HARNESS_SYSTEM_PROMPT_EXTRA = input.systemPromptExtra;
  return env;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => undefined);
    } catch {
      // ignorieren
    }
  } else {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignorieren
    }
  }
}

export function runAgentProcess(input: AgentProcessInput, signal?: AbortSignal): Promise<AgentProcessResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(input.command, input.args, {
        env: agentEnvironment(input),
        cwd: input.cwd,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ code: null, stdout: "", stderrTail: "", timedOut: false, spawnError: err instanceof Error ? err.message : String(err) });
      return;
    }
    const finish = (result: Omit<AgentProcessResult, "stdout" | "stderrTail" | "timedOut">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, stdout, stderrTail: stderr.slice(-STDERR_TAIL), timedOut });
    };
    const stop = (): void => {
      timedOut = true;
      killTree(child.pid);
      try {
        child.kill();
      } catch {
        // ignorieren
      }
    };
    const timer = setTimeout(stop, input.timeoutMs);
    const onAbort = (): void => stop();
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_STDOUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL * 2);
    });
    child.on("error", (err) => finish({ code: null, spawnError: err.message }));
    child.on("close", (code) => finish({ code, spawnError: null }));
  });
}
