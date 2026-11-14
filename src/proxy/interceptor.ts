// Transparenter MCP-Gateway: verbindet sich zu einem echten Upstream-MCP-
// Server, discovered dessen Tools und injected Chaos (F1–F5 oder stochastisch)
// bevor/nachdem Calls durchgereicht werden. Verdrahtet über `proxy`-CLI-Modus
// in `src/index.ts` → `src/proxy/gateway.ts` (dynamische Tool-Registrierung
// anhand `getUpstreamTools()`).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../version.js";
import { classificationDoubtText } from "./classification-doubt.js";
import {
  classifyByDescriptionOpener,
  compoundWriteGuess,
  classifyByVerbWords,
  readPrefixThenWrites,
  weakReadPrefixThenWrites,
} from "./verb-words.js";
import { looksLikeErrorAnswer } from "./error-answer.js";
import { parseProbeReading, type EffectProbeConfig } from "../core/effect-probe.js";
import { readFileSync, readdirSync } from "node:fs";
import {
  createSession,
  incrementCall,
  addRecord,
  classifyTool,
  extractKey,
  isKeyField,
  isReadTool,
  matchesAnyGlob,
  releaseScenarioFire,
  DEFAULT_WRITE_TOOL_PATTERNS,
  type CallOutcome,
  type SessionState,
  type ToolClass,
} from "../engine/state-machine.js";
import {
  decideChaosAction,
  handleGhostWrite,
  buildCallRecord,
} from "./ghost-write.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProxyConfig {
  upstream: UpstreamConfig;
  scenarioId?: string;
  mode?: "deterministic" | "chaos";
  errorRate?: number;
  // Explicit --write-tools. Replaces the default write patterns.
  writeToolPatterns?: string[];
  // Explicit --read-tools. Added to the built-in read prefixes.
  readToolPatterns?: string[];
  keyFields?: string[];
  retryAfterSec?: number;
  // --effect-probe: a read tool of the upstream the harness calls itself to
  // count records (see core/effect-probe.ts).
  effectProbe?: EffectProbeConfig;
}

export interface UpstreamConfig {
  command: string;
  args?: string[];
  cwd?: string;
  // Extra/override env vars for the upstream process, e.g. an API token it
  // reads from its environment. Without this, the MCP SDK's StdioClientTransport
  // only passes a small OS-level allowlist (PATH, HOME, etc. — see
  // DEFAULT_INHERITED_ENV_VARS in its stdio.js) to the child process, not the
  // caller's full environment, so any upstream expecting credentials from env
  // would silently start unauthenticated.
  env?: Record<string, string>;
}

export interface ToolClassification {
  name: string;
  class: ToolClass;
  // Where the decision came from, for the startup listing.
  source: string;
  // The tool's own description contradicts a name-based classification
  // (see classification-doubt.ts). Informational: the class is not changed.
  doubt?: string;
  // The same in German, for the readable reports.
  doubtDe?: string;
  // Taken from a verb inside the name: a guess, named as such at startup and in the report.
  guess?: boolean;
}

// The result handed back to the gateway's CallTool handler. A passed-through
// call carries the upstream's whole result object (structuredContent, _meta,
// ...), not just content/isError.
export type InterceptResult = Record<string, unknown> & {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
};

// Decides once, at startup, what each upstream tool is. Order of precedence:
// explicit flags, then the tool's own MCP annotations, then name patterns.
// Anything left over stays "unclassified" — and is reported as such instead
// of being quietly treated as a harmless read.
export function classifyUpstreamTool(
  tool: Tool,
  config: Pick<ProxyConfig, "writeToolPatterns" | "readToolPatterns">,
): ToolClassification {
  const result = classifyByRules(tool, config);
  const doubt = classificationDoubtText(tool, result.class, result.source);
  return doubt ? { ...result, doubt: doubt.en, doubtDe: doubt.de } : result;
}

function classifyByRules(
  tool: Tool,
  config: Pick<ProxyConfig, "writeToolPatterns" | "readToolPatterns">,
): ToolClassification {
  const name = tool.name;
  const explicitWrite = config.writeToolPatterns ?? [];
  const explicitRead = config.readToolPatterns ?? [];

  if (matchesAnyGlob(name, explicitWrite)) {
    return { name, class: "write", source: "--write-tools" };
  }
  if (matchesAnyGlob(name, explicitRead)) {
    return { name, class: "read", source: "--read-tools" };
  }

  const annotations = tool.annotations;
  if (annotations?.readOnlyHint === true) {
    return { name, class: "read", source: "annotation readOnlyHint=true" };
  }
  if (annotations?.readOnlyHint === false) {
    return { name, class: "write", source: "annotation readOnlyHint=false" };
  }
  if (annotations?.destructiveHint === true) {
    return { name, class: "write", source: "annotation destructiveHint=true" };
  }

  // Explicit --write-tools replaces the default pattern list (documented).
  // The defaults are snake_case ("create_*"); a camelCase name is matched
  // through its snake_case form, so "createAppointment" is a write too.
  const snake = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
  if (
    explicitWrite.length === 0 &&
    (matchesAnyGlob(name, DEFAULT_WRITE_TOOL_PATTERNS) ||
      matchesAnyGlob(snake, DEFAULT_WRITE_TOOL_PATTERNS))
  ) {
    return { name, class: "write", source: "default write pattern" };
  }
  if (isReadTool(name)) {
    // "get_or_create_user", "read_and_delete": the read prefix alone would call a write a read.
    if (explicitWrite.length === 0 && readPrefixThenWrites(name)) {
      if (explicitRead.length === 0 && compoundWriteGuess(tool.description) === "write") {
        return { name, class: "write", source: "read verb, then a write verb (and/or/then)", guess: true };
      }
      return { name, class: "unclassified", source: "read prefix, but a write verb follows (and/or/then)" };
    }
    // "check_in_guest", "status_change": a weak read prefix (a noun as often as a verb) followed by a write verb.
    if (explicitWrite.length === 0 && explicitRead.length === 0) {
      const weak = weakReadPrefixThenWrites(name, tool.description);
      if (weak === "write") return { name, class: "write", source: "verb word after a weak read prefix", guess: true };
      if (weak === "unclassified") {
        return { name, class: "unclassified", source: "weak read prefix, then a write verb, but the description says it reads" };
      }
    }
    return { name, class: "read", source: "read prefix" };
  }
  // Last resort for what nothing above could place: a verb inside the name (`slack_post_message`).
  // Not when the caller gave explicit patterns: then they decide what writes and what reads.
  if (explicitWrite.length === 0 && explicitRead.length === 0) {
    const byWord = classifyByVerbWords(name, tool.description);
    if (byWord !== "unclassified") return { name, class: byWord, source: "verb word in name", guess: true };
    // Nothing in the name: the description opens with a plain write verb ("Creates a booking").
    if (classifyByDescriptionOpener(tool.description) === "write") {
      return { name, class: "write", source: "description opens with a write verb", guess: true };
    }
  }
  return { name, class: "unclassified", source: "no annotation, no pattern match" };
}

const STDERR_TAIL_CHARS = 2000;
const PROBE_TIMEOUT_MS = 15_000;
const MAX_TOOL_LIST_PAGES = 1000;

interface ProcessRef {
  pid: number;
  startTime: string;
}

// Linux only (/proc). [ppid, starttime] of a process, or null if it is gone.
function procStat(pid: number): { ppid: number; startTime: string } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // The command name (field 2) may contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { ppid: Number(fields[1]), startTime: fields[19] };
  } catch {
    return null;
  }
}

function listDescendants(root: number | null): ProcessRef[] {
  if (root === null || process.platform !== "linux") return [];
  try {
    const children = new Map<number, ProcessRef[]>();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      const stat = procStat(pid);
      if (!stat) continue;
      const list = children.get(stat.ppid) ?? [];
      list.push({ pid, startTime: stat.startTime });
      children.set(stat.ppid, list);
    }
    const found: ProcessRef[] = [];
    const queue = [root];
    while (queue.length > 0 && found.length < 1000) {
      for (const child of children.get(queue.shift() as number) ?? []) {
        found.push(child);
        queue.push(child.pid);
      }
    }
    return found;
  } catch {
    return [];
  }
}

function killSurvivors(processes: ProcessRef[]): void {
  for (const ref of processes) {
    // Same pid AND same start time: never a process that reused the number.
    if (procStat(ref.pid)?.startTime !== ref.startTime) continue;
    try {
      process.kill(ref.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export class ProxyInterceptor {
  private upstreamClient: Client | null = null;
  private upstreamTransport: StdioClientTransport | null = null;
  private session: SessionState;
  private config: ProxyConfig;
  private upstreamTools: Tool[] = [];
  private toolClassification: ToolClassification[] = [];
  private upstreamAlive = false;
  private closing = false;
  private stderrTail = "";
  // Called when a call is forwarded upstream and again once it has been
  // recorded (--report-file). The answer to the agent waits for the second
  // one, so the file is never behind what the agent has already seen.
  onCallRecorded: (() => Promise<void> | void) | null = null;
  // Called once if the upstream connection drops while the proxy is running.
  onUpstreamLost: ((stderrTail: string) => void) | null = null;
  // --effect-probe: called when a background reading of the probe has landed,
  // so the report file can be written again with it.
  onProbeRefreshed: (() => void) | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  private probeInFlight: Promise<void> | null = null;

  constructor(config: ProxyConfig) {
    this.config = config;
    this.session = createSession(
      config.scenarioId ?? null,
      config.mode ?? "deterministic",
      config.errorRate ?? 0.0,
      config.writeToolPatterns,
      {
        readToolPatterns: config.readToolPatterns,
        keyFields: config.keyFields,
        retryAfterSec: config.retryAfterSec,
      },
    );
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  async connectUpstream(): Promise<void> {
    this.upstreamTransport = new StdioClientTransport({
      command: this.config.upstream.command,
      args: this.config.upstream.args,
      cwd: this.config.upstream.cwd,
      // Inherit the full parent environment (same as any normal child
      // process spawn) instead of the SDK's restrictive default allowlist,
      // then layer --upstream-env on top for additions/overrides.
      env: {
        ...(process.env as Record<string, string>),
        ...this.config.upstream.env,
      },
      stderr: "pipe",
    });

    // Keep the last part of the upstream's stderr: if it dies, that is
    // usually where the reason is. Reading the pipe also keeps a chatty
    // upstream from blocking on a full buffer.
    this.upstreamTransport.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });

    this.upstreamClient = new Client(
      { name: "cuonztech-harness-proxy", version: VERSION },
      { capabilities: {} },
    );
    this.upstreamClient.onclose = () => {
      const wasAlive = this.upstreamAlive;
      this.upstreamAlive = false;
      if (wasAlive && !this.closing) {
        this.onUpstreamLost?.(this.stderrTail);
      }
    };
    // connect() spawns the process before its first await.
    const connecting = this.upstreamClient.connect(this.upstreamTransport);
    const pid = this.upstreamTransport.pid;
    try {
      await connecting;
    } catch (err) {
      // The SDK starts closing the transport on its own but does not wait
      // for it; this process is about to exit, which left an upstream that
      // never answered (a hanging start) running. It is our own child and
      // has not been collected yet, so the pid is certainly still its own.
      if (pid !== null) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      throw err;
    }
    this.upstreamAlive = true;

    // Discover upstream tools (full definitions, including inputSchema, so
    // the gateway can advertise them to its own client unchanged). The list
    // may be paginated: follow nextCursor to the end, or every tool after
    // the first page would be invisible to the agent and unknown to the audit.
    const discovered: Tool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_LIST_PAGES; page++) {
      const result = await this.upstreamClient.listTools(cursor ? { cursor } : undefined);
      discovered.push(...result.tools);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    this.upstreamTools = discovered;
    this.session.knownToolsOnly = true;
    this.session.kind = "proxy";
    this.session.pending = new Map();

    this.toolClassification = this.upstreamTools.map((tool) =>
      classifyUpstreamTool(tool, this.config),
    );
    for (const entry of this.toolClassification) {
      this.session.toolClassOverrides.set(entry.name, entry.class);
      if (entry.doubt) {
        (this.session.classificationDoubts ??= new Map()).set(entry.name, entry.doubt);
        if (entry.doubtDe) (this.session.classificationDoubtsDe ??= new Map()).set(entry.name, entry.doubtDe);
      }
      if (entry.guess) (this.session.verbWordGuesses ??= new Set()).add(entry.name);
    }
    for (const tool of this.upstreamTools) {
      const properties = (tool.inputSchema?.properties ?? {}) as Record<string, unknown>;
      if (Object.keys(properties).some((p) => isKeyField(p, this.session.keyFields))) {
        this.session.keyCapableTools.add(tool.name);
      }
    }
  }

  async disconnectUpstream(): Promise<void> {
    this.closing = true;
    // A wrapper command ("sh -c ...", "npx ...") ends on its own, but the
    // server it started may not: note its descendants first, and end those
    // that are still there afterwards.
    const descendants = listDescendants(this.upstreamTransport?.pid ?? null);
    if (this.upstreamClient) {
      await this.upstreamClient.close().catch(() => undefined);
      this.upstreamClient = null;
    }
    // After a failed start the client never took over the transport.
    await this.upstreamTransport?.close().catch(() => undefined);
    this.upstreamTransport = null;
    killSurvivors(descendants);
  }

  // --effect-probe: take the baseline reading. Called once after connect, before
  // the first agent call. Throws with a message that says what to fix.
  async initEffectProbe(): Promise<void> {
    const cfg = this.config.effectProbe;
    if (!cfg) return;
    const entry = this.toolClassification.find((t) => t.name === cfg.tool);
    if (!entry) {
      throw new Error(`--effect-probe "${cfg.tool}": the upstream has no such tool.`);
    }
    if (entry.class !== "read") {
      throw new Error(
        `--effect-probe "${cfg.tool}": the probe must be a READ tool, but it is taken for ${entry.class === "write" ? "a write" : "a tool that is neither read nor write"} (${entry.source}). The harness calls it itself, repeatedly: a write would change what it measures. Pick a read tool, or classify it with --read-tools.`,
      );
    }
    let reading;
    try {
      reading = await this.readProbe();
    } catch (err) {
      throw new Error(`--effect-probe "${cfg.tool}": ${err instanceof Error ? err.message : String(err)}`);
    }
    this.session.effectProbe = {
      ...cfg,
      before: reading.count,
      after: reading.count,
      error: null,
      readAtCalls: 0,
      ...(reading.warning ? { warning: reading.warning } : {}),
    };
  }

  // The probe is read OFF the answer path: after a call a trailing, debounced
  // reading is scheduled, and the report file is written again when it lands.
  // The agent never waits for it, and its timing (retry_after) is not touched.
  // After an error the next scheduled reading waits 10 s.
  scheduleEffectProbeRefresh(): void {
    const probe = this.session.effectProbe;
    if (!probe || this.probeTimer || this.closing) return;
    const wait = probe.error !== null ? 10_000 : 400;
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      void this.refreshEffectProbe().then(() => {
        this.onProbeRefreshed?.();
        // Calls were still open (or arrived meanwhile): the reading is behind.
        if (probe.readAtCalls !== this.session.history.length) this.scheduleEffectProbeRefresh();
      });
    }, wait);
    this.probeTimer.unref?.();
  }

  // Latest reading. `force` (a report is being read, the proxy is ending) waits
  // for a reading even right after an error. One reading at a time; a second
  // caller waits for the one in flight and uses it.
  async refreshEffectProbe(force = false): Promise<void> {
    const probe = this.session.effectProbe;
    if (!probe) return;
    if (this.probeInFlight) await this.probeInFlight;
    const calls = this.session.history.length;
    if (calls === probe.readAtCalls && probe.error === null) return;
    if (!force && probe.error !== null && probe.lastAttemptAt !== undefined && Date.now() - probe.lastAttemptAt < 10_000) return;
    // Calls still open: a record may be half-written. Leave the old reading;
    // the report treats open calls as "inconclusive".
    if ((this.session.pending?.size ?? 0) > 0) return;
    this.probeInFlight = (async () => {
      probe.lastAttemptAt = Date.now();
      try {
        const reading = await this.readProbe();
        probe.after = reading.count;
        probe.error = null;
        if (reading.warning) probe.warning = reading.warning;
        else delete probe.warning;
      } catch (err) {
        probe.error = err instanceof Error ? err.message : String(err);
      }
      // The history length BEFORE the reading: calls that arrived during it
      // make the reading older than the history, and the report says so.
      probe.readAtCalls = calls;
    })();
    try {
      await this.probeInFlight;
    } finally {
      this.probeInFlight = null;
    }
  }

  private async readProbe(): Promise<{ count: number; warning?: string }> {
    const cfg = this.config.effectProbe;
    if (!cfg) throw new Error("no probe configured");
    if (!this.upstreamClient || !this.upstreamAlive) {
      throw new Error("the upstream is not running any more");
    }
    let result;
    try {
      result = await this.upstreamClient.callTool(
        { name: cfg.tool, arguments: cfg.args },
        undefined,
        { timeout: PROBE_TIMEOUT_MS },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/timed out/i.test(message)) {
        throw new Error(`the probe tool did not answer within ${PROBE_TIMEOUT_MS / 1000} s (use a faster read tool, or narrow it with --effect-probe-args)`);
      }
      throw new Error(`the probe call failed: ${message}`);
    }
    return parseProbeReading(result as Parameters<typeof parseProbeReading>[0], cfg.countPath);
  }

  getUpstreamTools(): Tool[] {
    return this.upstreamTools;
  }

  getToolClassification(): ToolClassification[] {
    return this.toolClassification;
  }

  getSession(): SessionState {
    return this.session;
  }

  getUpstreamStderrTail(): string {
    return this.stderrTail;
  }

  // The upstream's own `instructions` from its initialize result, so the
  // gateway can hand them on to the agent unchanged.
  getUpstreamInstructions(): string | undefined {
    return this.upstreamClient?.getInstructions();
  }

  getKeyCapableTools(): string[] {
    return [...this.session.keyCapableTools];
  }

  async interceptToolCall(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<InterceptResult> {
    const result = await this.handleToolCall(toolName, args, signal);
    try {
      await this.onCallRecorded?.();
    } catch {
      // Reporting must never change what the agent gets back.
    }
    this.scheduleEffectProbeRefresh();
    return result;
  }

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<InterceptResult> {
    // Everything up to the first await runs synchronously, so two calls
    // dispatched in parallel still get distinct, ordered write positions —
    // only one of them can be "the first write" a scenario fires on.
    const receivedAt = Date.now();
    const callNumber = incrementCall(this.session.sessionId);
    const mergedArgs = { ...args };
    const key = extractKey(mergedArgs, this.session.keyFields);
    // A tool the upstream did not list is unclassified whatever its name
    // and whatever --write-tools says: F2/F3/F5 answer without asking the
    // upstream, so a call to a tool that does not exist would otherwise use
    // up the scenario and the real write would never see a failure.
    const toolClass = classifyTool(this.session, toolName);

    // A dead upstream is reported as exactly that. No scenario is applied:
    // an injected "timeout" on top would hide the real problem.
    if (!this.upstreamAlive || !this.upstreamClient) {
      const text = JSON.stringify({
        error: "UPSTREAM_UNAVAILABLE",
        message:
          "The upstream MCP server process is no longer running. Restart the proxy.",
      });
      return this.finish(
        buildCallRecord(callNumber, toolName, mergedArgs, null, text, false, {
          receivedAt,
          outcome: "upstream_error",
          toolClass,
          // Never sent: this one definitely did not execute.
          tookEffect: false,
        }),
        { content: [{ type: "text", text }], isError: true },
      );
    }

    const decision = decideChaosAction(
      this.session,
      callNumber,
      toolName,
      mergedArgs,
    );

    let upstreamResult: Record<string, unknown> | null = null;
    let upstreamResponse: Record<string, unknown> | null = null;
    let upstreamText: string | undefined;
    let upstreamIsError = false;
    let upstreamExecuted = false;
    let upstreamFailure: string | null = null;

    if (decision.executeUpstream) {
      // Until the upstream answers, this call is "sent, effect unknown". A
      // report written in the meantime — the session ends, the proxy is
      // killed — must not leave it out: 0.5.0 gave PASS for a duplicate
      // whose second write was still open when the client disconnected.
      this.session.pending?.set(callNumber, {
        ...buildCallRecord(callNumber, toolName, mergedArgs, null, "", false, {
          receivedAt,
          outcome: "upstream_error",
          toolClass,
          tookEffect: false,
          effectUnknown: true,
        }),
        timestamp: receivedAt,
      });
      // Waited for: if the proxy is killed the moment the upstream executes
      // this call, the report file must already show it as open. (Not
      // waiting left a 1-2 ms window in which the file still read PASS.)
      try {
        await this.onCallRecorded?.();
      } catch {
        // see interceptToolCall
      }
      try {
        // The client cancelled while this call waited (onCallRecorded or a
        // scenario delay). Do not start the upstream write at all.
        if (signal?.aborted) {
          throw new Error("cancelled by client before dispatch");
        }
        const result = (await this.upstreamClient.callTool(
          { name: toolName, arguments: mergedArgs },
          undefined,
          { signal },
        )) as Record<string, unknown>;
        upstreamResult = result;
        upstreamIsError = Boolean(result.isError);
        const content = Array.isArray(result.content)
          ? (result.content as Array<Record<string, unknown>>)
          : [];
        const textPart = content.find((c) => c.type === "text") as
          | { text?: string }
          | undefined;
        upstreamText = textPart?.text ?? JSON.stringify(result.structuredContent ?? content);
        upstreamExecuted = true;

        try {
          upstreamResponse = JSON.parse(upstreamText);
        } catch {
          upstreamResponse = { raw: upstreamText };
        }
      } catch (err) {
        // An upstream that throws an McpError gets its "MCP error <code>: "
        // prefix added a second time by the SDK client.
        upstreamFailure = (err instanceof Error ? err.message : String(err)).replace(
          /^(MCP error -?\d+: )\1+/,
          "$1",
        );
      }
    }

    // The call to the real upstream itself failed without an answer
    // (timeout, crash, dropped connection, protocol error). The agent sees
    // that real error — never a scenario's simulated one, which would cover
    // it up — and the scenario is given back for the next write. Whether
    // the upstream executed the call before failing is unknown: the SDK's
    // request timeout (60 s) fires while a slow upstream may still commit.
    if (upstreamFailure !== null) {
      if (decision.scenarioTriggered) releaseScenarioFire(this.session);
      const text = JSON.stringify({ error: "UPSTREAM_ERROR", message: upstreamFailure });
      return this.finish(
        buildCallRecord(callNumber, toolName, mergedArgs, null, text, false, {
          receivedAt,
          outcome: "upstream_error",
          toolClass,
          tookEffect: false,
          // No JSON-RPC error code is taken as proof of "not executed": a
          // tool handler can throw any of them itself after it has already
          // written (-32602 "invalid params" and -32601 "method not found"
          // were both tried as exceptions, and both turned a real duplicate
          // into a clean-looking recovery).
          effectUnknown: true,
        }),
        { content: [{ type: "text", text }], isError: true },
      );
    }

    // F1 was meant for this write, but the upstream itself rejected it
    // (isError): there is no ghost-write to simulate. The agent gets the
    // upstream's real error, and F1 stays armed for the next write —
    // otherwise the run would count as "scenario fired" without ever having
    // tested anything, and a blind retry would look like a clean recovery.
    const ghostRejected =
      decision.injectError &&
      decision.errorType !== null &&
      decision.executeUpstream &&
      upstreamExecuted &&
      upstreamIsError;
    if (ghostRejected) {
      releaseScenarioFire(this.session);
    }

    // A genuine simulated failure (timeout/rate_limit/malformed/error) must
    // replace whatever the agent sees, even if the upstream really executed
    // (F1's ghost-write). A "success"-typed match (F4) is NOT a failure —
    // once it actually ran upstream above, the agent must see that REAL
    // response, not a canned one, or the proxy is lying about what happened.
    const isSimulatedFailure =
      decision.injectError && decision.errorType !== null && !ghostRejected;

    if (isSimulatedFailure) {
      if (decision.delayMs > 0) {
        await sleep(decision.delayMs);
      }

      const errorText =
        typeof decision.errorBody === "string"
          ? decision.errorBody
          : JSON.stringify(decision.errorBody);
      // Ghost-write: the upstream executed and accepted the write, but the
      // agent is told it timed out.
      const tookEffect = toolClass === "write" && upstreamExecuted && !upstreamIsError;

      const record = buildCallRecord(
        callNumber,
        toolName,
        mergedArgs,
        decision.errorType,
        errorText,
        upstreamExecuted,
        {
          receivedAt,
          outcome: "injected_failure",
          toolClass,
          tookEffect,
          // The agent is told "timeout", but the upstream's own answer may read like an error ("Fehler: …"
          // without isError): the effect probe must not take it for a record that exists (same as below).
          ...(tookEffect && looksLikeErrorAnswer(upstreamText) ? { answerLooksLikeError: true } : {}),
          scenarioTriggered: decision.scenarioTriggered,
          ...(decision.retryAfterSec !== null ? { retryAfterSec: decision.retryAfterSec } : {}),
          ...(upstreamText !== undefined ? { upstreamResponse: upstreamText } : {}),
        },
      );
      // markGhostCommitted must run AFTER addRecord() (inside finish):
      // marking it first makes addRecord() treat the freshly-created key
      // entry as "existing" (double-counting writeCalls and clobbering
      // GHOST_COMMITTED back to FAILED_DOWNSTREAM).
      return this.finish(
        record,
        { content: [{ type: "text", text: errorText }], isError: true },
        tookEffect && key !== undefined ? upstreamResponse : null,
      );
    }

    if (upstreamExecuted && upstreamResult) {
      // Real passthrough: the upstream's whole result object, unchanged —
      // all content blocks, structuredContent, _meta and its real isError.
      // Audit-only facts (upstreamExecuted, injectedError, callNumber) are
      // recorded below and surfaced through the audit tools / report file —
      // never in the tool response itself.
      const outcome: CallOutcome = upstreamIsError ? "upstream_error" : "success";
      const content = Array.isArray(upstreamResult.content)
        ? (upstreamResult.content as Array<Record<string, unknown>>)
        : [];
      return this.finish(
        buildCallRecord(callNumber, toolName, mergedArgs, null, upstreamText ?? "", true, {
          receivedAt,
          outcome,
          toolClass,
          tookEffect: toolClass === "write" && !upstreamIsError,
          ...(toolClass === "write" && !upstreamIsError && looksLikeErrorAnswer(upstreamText)
            ? { answerLooksLikeError: true }
            : {}),
          scenarioTriggered: decision.scenarioTriggered && !ghostRejected,
          upstreamResponse: upstreamText ?? "",
        }),
        // isError is passed on only if the upstream sent one: adding
        // "isError: false" to a success would change the upstream's answer.
        { ...upstreamResult, content },
      );
    }

    // No scenario triggered and no upstream call was attempted — cannot
    // happen with the current decision logic; answered as an error rather
    // than a made-up success.
    const text = JSON.stringify({
      error: "HARNESS_INTERNAL",
      message: "The call was neither forwarded upstream nor answered by a scenario.",
    });
    return this.finish(
      buildCallRecord(callNumber, toolName, mergedArgs, null, text, false, {
        receivedAt,
        outcome: "upstream_error",
        toolClass,
        tookEffect: false,
      }),
      { content: [{ type: "text", text }], isError: true },
    );
  }

  private finish(
    record: ReturnType<typeof buildCallRecord>,
    result: InterceptResult,
    ghostUpstreamResponse: Record<string, unknown> | null = null,
  ): InterceptResult {
    this.session.pending?.delete(record.callNumber);
    addRecord(this.session.sessionId, record);
    if (ghostUpstreamResponse) {
      handleGhostWrite(this.session, record.args, ghostUpstreamResponse);
    }
    return result;
  }
}
