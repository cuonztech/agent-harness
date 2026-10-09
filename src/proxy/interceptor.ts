// EXPERIMENTAL — NICHT VERDRAHTET: Diese Klasse implementiert den in der
// README beworbenen "transparenten MCP-Gateway"-Modus (Proxy zu einem echten
// Upstream-MCP-Server inkl. Chaos-Injection). Weder `src/index.ts` noch
// `src/server/server.ts` instanziieren sie — es gibt aktuell keinen CLI-Pfad,
// der einen Upstream-Server konfiguriert und hierher verbindet. Die einzigen
// heute über `npx @cuonztech/agent-harness` erreichbaren Modi sind die
// selbstständige Session (`execute_call`-Tool) und `benchmark`, beide über
// src/tools/handlers.ts. Diese Klasse hat außerdem keine eigene Testdatei.
// Vor einer Produktivverdrahtung: CLI-Flag für Upstream-Config, dynamische
// Tool-Registrierung anhand `getUpstreamTools()`, und Tests.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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
  private upstreamTools: Array<{ name: string; description?: string }> = [];

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

    // Discover upstream tools
    const tools = await this.upstreamClient.listTools();
    this.upstreamTools = tools.tools.map((t) => ({
      name: t.name,
      description: t.description,
    }));
  }

  async disconnectUpstream(): Promise<void> {
    if (this.upstreamClient) {
      await this.upstreamClient.close();
      this.upstreamClient = null;
    }
  }

  getUpstreamTools(): Array<{ name: string; description?: string }> {
    return this.upstreamTools;
  }

  getSession(): SessionState {
    return this.session;
  }

  async interceptToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{
    content: Array<{ type: "text"; text: string }>;
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
    let upstreamExecuted = false;
    let responseText = "";
    let statusCode = 200;
    let injectedError: string | null = null;

    if (decision.executeUpstream && this.upstreamClient) {
      // Forward to upstream
      try {
        const result = await this.upstreamClient.callTool({
          name: toolName,
          arguments: mergedArgs,
        });
        const content = result.content as Array<{ type: string; text?: string }>;
        const textPart = content.find((c) => c.type === "text");
        responseText = textPart?.text ?? JSON.stringify(result.content);
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

    // Apply chaos decision (after upstream execution for ghost-writes)
    if (decision.injectError) {
      injectedError = decision.errorType;
      statusCode = decision.statusCode;
      responseText =
        typeof decision.errorBody === "string"
          ? decision.errorBody
          : JSON.stringify(decision.errorBody);

      // Ghost-write: upstream was executed but agent gets error
      if (decision.executeUpstream && upstreamExecuted && key) {
        handleGhostWrite(this.session, mergedArgs, upstreamResponse);
      }
    } else {
      statusCode = 200;
      if (!upstreamExecuted) {
        // No upstream, no error — passthrough mock
        responseText = JSON.stringify({
          result: "ok",
          callNumber,
          timestamp: new Date().toISOString(),
        });
      }
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

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              callNumber,
              statusCode,
              injectedError,
              upstreamExecuted,
              response: (() => {
                try {
                  return JSON.parse(responseText);
                } catch {
                  return responseText;
                }
              })(),
            },
            null,
            2,
          ),
        },
      ],
      isError: statusCode >= 400,
    };
  }
}