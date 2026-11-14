// Eingebauter Agenten-Loop von `bench`: eine Chat-Schleife gegen eine OpenAI-kompatible Schnittstelle
// (/v1/chat/completions mit tools) oder die native Ollama-Schnittstelle (/api/chat), die Werkzeuge über einen
// MCP-Client am Proxy aufruft.
//
// Nachrichtenfolge: System-Prompt, Benutzer (Aufgabe); das Modell ruft Werkzeuge, bis es ohne Werkzeug-Aufruf antwortet;
// dann Benutzer (Nachfrage); das Modell darf wieder Werkzeuge aufrufen; Ende nach der zweiten Antwort oder nach der
// Höchstzahl der Schritte je Zug. Ein Werkzeug-Fehler (isError) geht als Werkzeug-Ergebnis zurück. Der Wortlaut der
// Werkzeug-Antworten wird nie verändert.
//
// Fehlerhafte Läufe (Netz tot, Zeitüberschreitung, leere oder ungültige Modellantwort, Verbindung zum Proxy weg) enden mit
// einem InvalidRunError und einem Grund; der Aufrufer zählt sie als «ungültig», nie als sauber und nie als Duplikat.

export interface ToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string; toolName: string };

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  thinking?: string;
}

export interface ChatBackend {
  readonly api: "ollama" | "openai";
  chat(messages: ChatMessage[], tools: ToolDef[], signal: AbortSignal, stepTimeoutMs: number): Promise<ModelResponse>;
}

export interface ToolClient {
  callTool(name: string, args: Record<string, unknown>, signal: AbortSignal, timeoutMs: number): Promise<{ text: string; isError: boolean; harnessError?: boolean }>;
}

/** Der Lauf ist ungültig: kein Ergebnis, kein Duplikat, nicht sauber. */
export class InvalidRunError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "InvalidRunError";
  }
}

// ---------------------------------------------------------------- Denk-Blöcke

/** Entfernt Denk-Blöcke (<think>…</think>) aus einer Antwort, die ausgewertet wird. Das Original bleibt im Verlauf. */
export function stripThinking(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  const close = out.toLowerCase().lastIndexOf("</think>");
  if (close !== -1) out = out.slice(close + "</think>".length);
  return out.trim();
}

// ---------------------------------------------------------------- Schnittstellen

export interface BackendConfig {
  api: "ollama" | "openai";
  baseUrl: string;
  model: string;
  temperature: number | null;
  think: "off" | "on" | null;
  /** Wert des API-Schlüssels (nur im Speicher, nie in einer Ausgabe). */
  apiKey: string | null;
  /** Entfernt Geheimnisse aus Texten, die in Fehlermeldungen oder Dateien gelangen. */
  scrub: (text: string) => string;
}

export function endpointUrl(api: "ollama" | "openai", baseUrl: string): string {
  const u = new URL(baseUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const suffix = api === "ollama" ? "/api/chat" : path.endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
  return `${u.origin}${path}${suffix}`;
}

function toolsPayload(tools: ToolDef[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.inputSchema ?? { type: "object", properties: {} } },
  }));
}

function openAiMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls.length > 0
          ? { tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
          : {}),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    return { role: m.role, content: m.content };
  });
}

function ollamaMessages(messages: ChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        ...(m.toolCalls.length > 0 ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments } })) } : {}),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_name: m.toolName, content: m.content };
    return { role: m.role, content: m.content };
  });
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new InvalidRunError("Ungültige Modellantwort: Die Argumente eines Werkzeug-Aufrufs sind kein JSON.");
    }
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new InvalidRunError("Ungültige Modellantwort: Die Argumente eines Werkzeug-Aufrufs sind kein JSON-Objekt.");
}

function parseToolCalls(raw: unknown, prefix: string): ToolCall[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new InvalidRunError("Ungültige Modellantwort: tool_calls ist keine Liste.");
  return raw.map((entry, i) => {
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } } | null)?.function;
    if (!fn || typeof fn.name !== "string" || fn.name.trim() === "") {
      throw new InvalidRunError("Ungültige Modellantwort: Ein Werkzeug-Aufruf hat keinen Namen.");
    }
    const id = typeof (entry as { id?: unknown }).id === "string" && (entry as { id: string }).id !== "" ? (entry as { id: string }).id : `${prefix}-${i}`;
    return { id, name: fn.name, arguments: parseArguments(fn.arguments) };
  });
}

function contentOf(raw: unknown): string {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map((p) => (typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : "")).join("");
  throw new InvalidRunError("Ungültige Modellantwort: content hat einen unerwarteten Typ.");
}

export function createBackend(config: BackendConfig): ChatBackend {
  const url = endpointUrl(config.api, config.baseUrl);
  let counter = 0;
  return {
    api: config.api,
    async chat(messages, tools, signal, stepTimeoutMs) {
      const body: Record<string, unknown> =
        config.api === "ollama"
          ? {
              model: config.model,
              messages: ollamaMessages(messages),
              stream: false,
              ...(tools.length > 0 ? { tools: toolsPayload(tools) } : {}),
              ...(config.think !== null ? { think: config.think === "on" } : {}),
              ...(config.temperature !== null ? { options: { temperature: config.temperature } } : {}),
            }
          : {
              model: config.model,
              messages: openAiMessages(messages),
              stream: false,
              ...(tools.length > 0 ? { tools: toolsPayload(tools) } : {}),
              ...(config.temperature !== null ? { temperature: config.temperature } : {}),
            };
      const stepSignal = AbortSignal.timeout(stepTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.any([signal, stepSignal]),
        });
      } catch (err) {
        if (signal.aborted) throw new InvalidRunError("Zeitüberschreitung: Das Zeitlimit des Laufs ist abgelaufen.");
        if (stepSignal.aborted) throw new InvalidRunError(`Zeitüberschreitung: Das Modell hat innerhalb von ${Math.round(stepTimeoutMs / 1000)} s nicht geantwortet.`);
        const code = (err as { cause?: { code?: string } })?.cause?.code;
        throw new InvalidRunError(config.scrub(`Netzwerkfehler: Der Modell-Server ist nicht erreichbar${code ? ` (${code})` : ""}.`));
      }
      let text: string;
      try {
        text = await response.text();
      } catch {
        if (signal.aborted) throw new InvalidRunError("Zeitüberschreitung: Das Zeitlimit des Laufs ist abgelaufen.");
        if (stepSignal.aborted) throw new InvalidRunError(`Zeitüberschreitung: Das Modell hat innerhalb von ${Math.round(stepTimeoutMs / 1000)} s nicht fertig geantwortet.`);
        throw new InvalidRunError("Netzwerkfehler: Die Antwort des Modell-Servers brach ab.");
      }
      if (!response.ok) {
        const snippet = config.scrub(text.replace(/\s+/g, " ").trim().slice(0, 300));
        throw new InvalidRunError(`Der Modell-Server antwortete mit HTTP ${response.status}${snippet ? `: ${snippet}` : ""}.`);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new InvalidRunError("Ungültige Modellantwort: Der Modell-Server hat kein JSON geliefert.");
      }
      const prefix = `call-${++counter}`;
      if (config.api === "ollama") {
        const message = (json as { message?: { content?: unknown; tool_calls?: unknown; thinking?: unknown } } | null)?.message;
        if (!message || typeof message !== "object") throw new InvalidRunError("Ungültige Modellantwort: Es fehlt message.");
        return {
          content: contentOf(message.content),
          toolCalls: parseToolCalls(message.tool_calls, prefix),
          ...(typeof message.thinking === "string" && message.thinking !== "" ? { thinking: message.thinking } : {}),
        };
      }
      const message = (json as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> } | null)?.choices?.[0]?.message;
      if (!message || typeof message !== "object") throw new InvalidRunError("Ungültige Modellantwort: Es fehlt choices[0].message.");
      return { content: contentOf(message.content), toolCalls: parseToolCalls(message.tool_calls, prefix) };
    },
  };
}

// ---------------------------------------------------------------- Loop

export interface AgentLoopOptions {
  backend: ChatBackend;
  client: ToolClient;
  tools: ToolDef[];
  systemPrompt: string;
  task: string;
  /** null = keine Nachfrage. */
  followup: string | null;
  maxSteps: number;
  stepTimeoutMs: number;
  /** Bricht den ganzen Lauf ab (Zeitlimit je Lauf). */
  signal: AbortSignal;
  /** Eine Zeile des Rohverlaufs (JSONL). */
  onEvent: (event: Record<string, unknown>) => void;
  /** Nach dem ersten Zug, vor der Nachfrage (für den Zwischenstand der Wahrheit). */
  onTurnEnd?: (turn: 1 | 2, toolCallsSoFar: number) => Promise<void>;
}

export interface AgentLoopResult {
  /** Antwort nach der Aufgabe (ohne Denk-Block); null, wenn der Zug ohne Antwort endete. */
  answer1: string | null;
  /** Antwort nach der Nachfrage; null ohne Nachfrage oder ohne Antwort. */
  answer2: string | null;
  toolCalls: number;
  modelCalls: number;
  /** Der Zug endete an der Höchstzahl der Schritte, ohne dass das Modell ohne Werkzeug-Aufruf antwortete. */
  maxStepsReached: { turn1: boolean; turn2: boolean };
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const { backend, client, tools, onEvent } = options;
  const messages: ChatMessage[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.task },
  ];
  onEvent({ type: "message", role: "system", content: options.systemPrompt });
  onEvent({ type: "message", role: "user", turn: 1, content: options.task });
  const result: AgentLoopResult = { answer1: null, answer2: null, toolCalls: 0, modelCalls: 0, maxStepsReached: { turn1: false, turn2: false } };

  const runTurn = async (turn: 1 | 2): Promise<string | null> => {
    for (let step = 1; step <= options.maxSteps; step++) {
      const started = Date.now();
      const response = await backend.chat(messages, tools, options.signal, options.stepTimeoutMs);
      result.modelCalls++;
      onEvent({
        type: "model_response",
        turn,
        step,
        ms: Date.now() - started,
        content: response.content,
        ...(response.thinking ? { thinking: response.thinking } : {}),
        toolCalls: response.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      });
      messages.push({ role: "assistant", content: response.content, toolCalls: response.toolCalls });
      if (response.toolCalls.length === 0) {
        const answer = stripThinking(response.content);
        if (answer === "") throw new InvalidRunError("Leere Modellantwort: Das Modell hat weder geantwortet noch ein Werkzeug aufgerufen.");
        onEvent({ type: "answer", turn, text: answer });
        return answer;
      }
      for (const call of response.toolCalls) {
        const toolStarted = Date.now();
        onEvent({ type: "tool_call", turn, step, name: call.name, arguments: call.arguments });
        let outcome: { text: string; isError: boolean; harnessError?: boolean };
        try {
          outcome = await client.callTool(call.name, call.arguments, options.signal, options.stepTimeoutMs);
        } catch (err) {
          if (options.signal.aborted) throw new InvalidRunError("Zeitüberschreitung: Das Zeitlimit des Laufs ist abgelaufen.");
          if (err instanceof InvalidRunError) throw err;
          throw new InvalidRunError(`Die Verbindung zum Proxy ist abgebrochen: ${err instanceof Error ? err.message : String(err)}`);
        }
        result.toolCalls++;
        onEvent({ type: "tool_result", turn, step, name: call.name, ms: Date.now() - toolStarted, isError: outcome.isError, ...(outcome.harnessError ? { harnessError: true } : {}), text: outcome.text });
        messages.push({ role: "tool", content: outcome.text, toolCallId: call.id, toolName: call.name });
      }
    }
    return null;
  };

  result.answer1 = await runTurn(1);
  result.maxStepsReached.turn1 = result.answer1 === null;
  if (options.onTurnEnd) await options.onTurnEnd(1, result.toolCalls);

  if (options.followup !== null) {
    messages.push({ role: "user", content: options.followup });
    onEvent({ type: "message", role: "user", turn: 2, content: options.followup });
    result.answer2 = await runTurn(2);
    result.maxStepsReached.turn2 = result.answer2 === null;
    if (options.onTurnEnd) await options.onTurnEnd(2, result.toolCalls);
  }
  return result;
}
