// Transparenter MCP-Gateway: verbindet sich zu einem echten Upstream-MCP-
// Server, discovered dessen Tools und injected Chaos (F1–F5 oder stochastisch)
// bevor/nachdem Calls durchgereicht werden. Verdrahtet über `proxy`-CLI-Modus
// in `src/index.ts` → `src/proxy/gateway.ts` (dynamische Tool-Registrierung
// anhand `getUpstreamTools()`).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  createSession,
  getSession,
  incrementCall,
  addRecord,
  type SessionState,
} from "../engine/state-machine.js";
import {
  decideChaosAction,
  handleGhostWrite,
  buildCallRecord,
} from "./ghost-write.js";

export interface ProxyConfig {
  upstream: UpstreamConfig;
  scenarioId?: string;
  mode?: "deterministic" | "chaos";
  errorRate?: number;
}

export interface UpstreamConfig {
  command: string;
  args?: string[];
  cwd?: string;
}

export class ProxyInterceptor {
  private upstreamClient: Client | null = null;
  private upstreamTransport: Transport | null = null;
  private session: SessionState;
  private config: ProxyConfig;
  private upstreamTools: Tool[] = [];

  constructor(config: ProxyConfig) {
    this.config = config;
    this.session = createSession(
      config.scenarioId ?? null,
      config.mode ?? "deterministic",
      config.errorRate ?? 0.0,
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
      stderr: "pipe",
    });

    this.upstreamClient = new Client(
      { name: "cuonztech-harness-proxy", version: "0.2.0" },
      { capabilities: {} },
    );
    await this.upstreamClient.connect(this.upstreamTransport);

    // Discover upstream tools (full definitions, including inputSchema, so
    // the gateway can advertise them to its own client unchanged)
    const tools = await this.upstreamClient.listTools();
    this.upstreamTools = tools.tools;
  }

  async disconnectUpstream(): Promise<void> {
    if (this.upstreamClient) {
      await this.upstreamClient.close();
      this.upstreamClient = null;
    }
  }

  getUpstreamTools(): Tool[] {
    return this.upstreamTools;
  }

  getSession(): SessionState {
    return this.session;
  }

  async interceptToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<Record<string, unknown>>;
    isError: boolean;
  }> {
    const callNumber = incrementCall(this.session.sessionId);

    // Merge idempotency key into args
    const mergedArgs = { ...args };
    const key = args["idempotency_key"] as string | undefined;

    // Decide chaos action
    const decision = decideChaosAction(
      this.session,
      callNumber,
      toolName,
      mergedArgs,
    );

    let upstreamResponse: Record<string, unknown> | null = null;
    let upstreamContent: Array<Record<string, unknown>> | null = null;
    let upstreamIsError = false;
    let upstreamExecuted = false;
    // responseText only ever feeds the audit trail (buildCallRecord/history),
    // never the agent — see agentContent below.
    let responseText = "";
    let injectedError: string | null = null;

    if (decision.executeUpstream && this.upstreamClient) {
      // Forward to upstream
      try {
        const result = await this.upstreamClient.callTool({
          name: toolName,
          arguments: mergedArgs,
        });
        upstreamContent = result.content as Array<Record<string, unknown>>;
        upstreamIsError = Boolean(result.isError);
        const textPart = upstreamContent.find((c) => c.type === "text") as
          | { text?: string }
          | undefined;
        responseText = textPart?.text ?? JSON.stringify(upstreamContent);
        upstreamExecuted = true;

        try {
          upstreamResponse = JSON.parse(responseText);
        } catch {
          upstreamResponse = { raw: responseText };
        }
      } catch (err) {
        responseText = JSON.stringify({
          error: "UPSTREAM_ERROR",
          message: err instanceof Error ? err.message : String(err),
        });
        injectedError = "[UPSTREAM_ERROR]";
      }
    }

    // A genuine simulated failure (timeout/rate_limit/malformed/error) must
    // replace whatever the agent sees, even if the upstream really executed
    // (F1's ghost-write). A "success"-typed match (F4) is NOT a failure —
    // once it actually ran upstream above, the agent must see that REAL
    // response, not a canned one, or the proxy is lying about what happened.
    const isSimulatedFailure = decision.injectError && decision.errorType !== null;

    let isGhostWrite = false;
    let agentContent: Array<Record<string, unknown>>;
    let agentIsError: boolean;

    if (isSimulatedFailure) {
      injectedError = decision.errorType;
      const errorText =
        typeof decision.errorBody === "string"
          ? decision.errorBody
          : JSON.stringify(decision.errorBody);
      responseText = errorText;
      agentContent = [{ type: "text", text: errorText }];
      agentIsError = true;

      isGhostWrite = decision.executeUpstream && upstreamExecuted && Boolean(key);
    } else if (upstreamExecuted) {
      // Real passthrough: forward the upstream's actual content unchanged
      // (all blocks — text, images, structured content — not just the first
      // text block) and its real isError, instead of wrapping it in an
      // audit envelope. Audit-only facts (upstreamExecuted, injectedError,
      // callNumber) are recorded via buildCallRecord()/addRecord() below and
      // surfaced through get_report/get_score — never in the tool response
      // itself, so an agent reading the response can't trivially infer the
      // harness's internal chaos state.
      agentContent = upstreamContent ?? [{ type: "text", text: responseText }];
      agentIsError = upstreamIsError;
    } else if (injectedError === "[UPSTREAM_ERROR]") {
      agentContent = [{ type: "text", text: responseText }];
      agentIsError = true;
    } else {
      // No scenario triggered and no real upstream call was attempted
      // (shouldn't normally happen once connected) — synthetic ok mock.
      responseText = JSON.stringify({
        result: "ok",
        timestamp: new Date().toISOString(),
      });
      agentContent = [{ type: "text", text: responseText }];
      agentIsError = false;
    }

    // Record the call
    const record = buildCallRecord(
      callNumber,
      toolName,
      mergedArgs,
      injectedError,
      responseText,
      upstreamExecuted,
    );
    addRecord(this.session.sessionId, record);

    // Ghost-write: upstream executed but the agent sees an error. Mark this
    // AFTER addRecord(), mirroring handlers.ts's order — marking it first
    // makes addRecord() treat the freshly-created key entry as "existing"
    // (double-counting writeCalls and clobbering GHOST_COMMITTED back to
    // FAILED_DOWNSTREAM via its own isError branch).
    if (isGhostWrite) {
      handleGhostWrite(this.session, mergedArgs, upstreamResponse);
    }

    return {
      content: agentContent,
      isError: agentIsError,
    };
  }
}