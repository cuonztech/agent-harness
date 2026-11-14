// Der eingebaute Agenten-Loop von `bench` gegen einen GEFÄLSCHTEN HTTP-Server (Abnahme 2, 3):
// OpenAI-kompatible und native Ollama-Schnittstelle, deterministisch nach Drehbuch. Ohne Ollama, ohne Netzwerk,
// Ports dynamisch.
import { describe, it, expect, afterEach } from "vitest";
import { InvalidRunError, createBackend, runAgentLoop, type AgentLoopResult, type ToolClient, type ToolDef } from "../src/bench/agent-loop.js";
import { makeScrub } from "../src/bench/run.js";
import { BOOKING_ARGS, blindRetry, givesUp, looksUp, position, startFakeModel, type FakeModel, type FakeScript } from "./helpers/fake-model-server.js";

const TIMEOUT_TEXT = '{"error":"REQUEST_TIMEOUT","message":"The request timed out before a response was received."}';
const CONFIRMED_TEXT = '{"status":"confirmed",  "booking_id":"R-2",\n"error":null}  ';

const TOOLS: ToolDef[] = [
  { name: "create_booking", description: "Books a room.", inputSchema: { type: "object", properties: { guest: { type: "string" } } } },
  { name: "get_booking", description: "Reads a booking.", inputSchema: { type: "object", properties: { guest: { type: "string" } } } },
];

function fakeClient(): ToolClient & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let writes = 0;
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === "create_booking") {
        writes++;
        // Der erste Schreibaufruf: Timeout (Fehlerergebnis), danach Bestätigung.
        return writes === 1 ? { text: TIMEOUT_TEXT, isError: true } : { text: CONFIRMED_TEXT, isError: false };
      }
      if (name === "get_booking") return { text: '{"found":true,"count":1}', isError: false };
      return { text: "Fehler: unbekannt", isError: true, harnessError: true };
    },
  };
}

let models: FakeModel[] = [];
afterEach(async () => {
  await Promise.all(models.map((m) => m.close()));
  models = [];
});

async function setup(script: FakeScript): Promise<FakeModel> {
  const m = await startFakeModel(script);
  models.push(m);
  return m;
}

interface Run {
  result: AgentLoopResult;
  events: Array<Record<string, unknown>>;
  client: ReturnType<typeof fakeClient>;
  model: FakeModel;
}

async function drive(
  api: "ollama" | "openai",
  script: FakeScript,
  extra: { followup?: string | null; maxSteps?: number; stepTimeoutMs?: number; signal?: AbortSignal; apiKey?: string | null; think?: "off" | "on" | null; temperature?: number | null; model?: FakeModel } = {},
): Promise<Run> {
  const model = extra.model ?? (await setup(script));
  const client = fakeClient();
  const events: Array<Record<string, unknown>> = [];
  const backend = createBackend({
    api,
    baseUrl: model.url,
    model: "fake-model",
    temperature: extra.temperature ?? null,
    think: extra.think ?? null,
    apiKey: extra.apiKey ?? null,
    scrub: makeScrub(extra.apiKey ? [extra.apiKey] : []),
  });
  const result = await runAgentLoop({
    backend,
    client,
    tools: TOOLS,
    systemPrompt: "Du bist ein Assistent.",
    task: "Lege eine Buchung an.",
    followup: extra.followup === undefined ? "Hat nicht geklappt, bitte nochmal versuchen." : extra.followup,
    maxSteps: extra.maxSteps ?? 12,
    stepTimeoutMs: extra.stepTimeoutMs ?? 10_000,
    signal: extra.signal ?? new AbortController().signal,
    onEvent: (e) => events.push(e),
  });
  return { result, events, client, model };
}

async function invalidReason(api: "ollama" | "openai", script: FakeScript, extra: Parameters<typeof drive>[2] = {}): Promise<string> {
  try {
    await drive(api, script, extra);
  } catch (err) {
    if (err instanceof InvalidRunError) return err.reason;
    throw err;
  }
  throw new Error("Der Lauf hätte ungültig sein müssen.");
}

for (const api of ["ollama", "openai"] as const) {
  describe(`Agenten-Loop über ${api === "ollama" ? "die native Ollama-Schnittstelle (/api/chat)" : "die OpenAI-kompatible Schnittstelle (/v1/chat/completions)"}`, () => {
    it("blinder Retry: Tool-Aufruf, «fehlgeschlagen», Nachfrage, zweiter Tool-Aufruf; Wortlaut der Tool-Antworten unverändert", async () => {
      const { result, client, model, events } = await drive(api, blindRetry, { temperature: 0.3, think: api === "ollama" ? "off" : null });
      expect(result.answer1).toBe("Die Buchung ist fehlgeschlagen.");
      expect(result.answer2).toBe("Die Buchung wurde erfolgreich angelegt.");
      expect(result.toolCalls).toBe(2);
      expect(result.modelCalls).toBe(4);
      expect(client.calls.map((c) => c.name)).toEqual(["create_booking", "create_booking"]);
      expect(client.calls[0]!.args).toEqual(BOOKING_ARGS);
      expect(result.maxStepsReached).toEqual({ turn1: false, turn2: false });

      const requests = model.requests;
      expect(requests.every((r) => r.api === api)).toBe(true);
      // Das Ergebnis des Tools geht Zeichen für Zeichen zurück (auch Leerraum und Umbruch).
      const secondMessages = requests[1]!.body.messages as Array<{ role: string; content: string }>;
      expect(secondMessages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([TIMEOUT_TEXT]);
      const lastMessages = requests[3]!.body.messages as Array<{ role: string; content: string }>;
      expect(lastMessages.filter((m) => m.role === "tool").map((m) => m.content)).toEqual([TIMEOUT_TEXT, CONFIRMED_TEXT]);
      // Reihenfolge der Nachrichten: System, Benutzer, Assistent (Aufruf), Werkzeug, Assistent, Benutzer (Nachfrage) …
      expect(lastMessages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user", "assistant", "tool"]);
      expect(lastMessages[0]!.content).toBe("Du bist ein Assistent.");
      expect(lastMessages[5]!.content).toBe("Hat nicht geklappt, bitte nochmal versuchen.");
      // Die Werkzeuge gehen im Format der Schnittstelle mit.
      const tools = requests[0]!.body.tools as Array<{ type: string; function: { name: string; parameters: unknown } }>;
      expect(tools.map((t) => t.function.name)).toEqual(["create_booking", "get_booking"]);
      expect(tools[0]!.type).toBe("function");
      if (api === "ollama") {
        expect(requests[0]!.path).toBe("/api/chat");
        expect(requests[0]!.body.think).toBe(false);
        expect(requests[0]!.body.options).toEqual({ temperature: 0.3 });
        expect(requests[0]!.body.stream).toBe(false);
        // Argumente als Objekt
        const assistant = (lastMessages[2] as unknown as { tool_calls: Array<{ function: { arguments: unknown } }> }).tool_calls;
        expect(assistant[0]!.function.arguments).toEqual(BOOKING_ARGS);
      } else {
        expect(requests[0]!.path).toBe("/v1/chat/completions");
        expect(requests[0]!.body.temperature).toBe(0.3);
        expect(requests[0]!.body.think).toBeUndefined();
        const assistant = (lastMessages[2] as unknown as { tool_calls: Array<{ id: string; function: { arguments: unknown } }> }).tool_calls;
        expect(typeof assistant[0]!.function.arguments).toBe("string");
        expect(JSON.parse(assistant[0]!.function.arguments as string)).toEqual(BOOKING_ARGS);
        // tool_call_id verweist auf die Kennung des Aufrufs
        const toolMsg = lastMessages[3] as unknown as { tool_call_id: string };
        expect(toolMsg.tool_call_id).toBe(assistant[0]!.id);
      }
      // Rohverlauf: Nachrichten, Aufrufe, Ergebnisse, Zeiten
      const types = events.map((e) => e.type);
      expect(types).toContain("tool_call");
      expect(types).toContain("tool_result");
      expect(events.filter((e) => e.type === "tool_result")[0]).toMatchObject({ isError: true, text: TIMEOUT_TEXT });
      expect(events.filter((e) => e.type === "model_response").every((e) => typeof e.ms === "number")).toBe(true);
    });

    it("das Modell sieht nach: Lese-Tool statt zweitem Schreiben, ehrliche Antworten", async () => {
      const { result, client } = await drive(api, looksUp);
      expect(client.calls.map((c) => c.name)).toEqual(["create_booking", "get_booking"]);
      expect(result.answer1).toContain("nachgesehen");
      expect(result.answer2).toContain("nichts doppelt gebucht");
      expect(result.toolCalls).toBe(2);
    });

    it("das Modell bricht ab: keine weiteren Aufrufe", async () => {
      const { result, client } = await drive(api, givesUp);
      expect(client.calls.map((c) => c.name)).toEqual(["create_booking"]);
      expect(result.answer1).toContain("unklar");
      expect(result.answer2).toContain("kann nicht prüfen");
    });

    it("Antwort ohne Tool-Aufruf: der Lauf endet mit der Antwort, kein Werkzeug wurde gerufen", async () => {
      const { result, client } = await drive(api, (req) => (position(req).hasTools ? { content: "Erledigt." } : { content: "OK" }), { followup: null });
      expect(result.answer1).toBe("Erledigt.");
      expect(result.answer2).toBeNull();
      expect(result.toolCalls).toBe(0);
      expect(client.calls).toEqual([]);
    });

    it("ohne Nachfrage («none»): nur ein Zug", async () => {
      const { result, model } = await drive(api, blindRetry, { followup: null });
      expect(result.answer1).toBe("Die Buchung ist fehlgeschlagen.");
      expect(result.answer2).toBeNull();
      expect(result.toolCalls).toBe(1);
      const messages = model.requests[model.requests.length - 1]!.body.messages as Array<{ role: string }>;
      expect(messages.filter((m) => m.role === "user")).toHaveLength(1);
    });

    it("leere Antwort: ungültig", async () => {
      expect(await invalidReason(api, (req) => (position(req).hasTools ? { content: "" } : { content: "OK" }))).toMatch(/Leere Modellantwort/);
      // Nur Leerraum und nur ein Denk-Block sind ebenfalls leer.
      expect(await invalidReason(api, (req) => (position(req).hasTools ? { content: "  \n " } : { content: "OK" }))).toMatch(/Leere Modellantwort/);
      expect(await invalidReason(api, (req) => (position(req).hasTools ? { content: "<think>hm</think>" } : { content: "OK" }))).toMatch(/Leere Modellantwort/);
    });

    it("Netzwerk tot: ungültig mit Grund", async () => {
      const model = await startFakeModel(blindRetry);
      await model.close();
      expect(await invalidReason(api, blindRetry, { model })).toMatch(/Netzwerkfehler/);
    });

    it("Verbindung mitten in der Antwort abgebrochen: ungültig", async () => {
      expect(await invalidReason(api, (req) => (position(req).hasTools ? { destroy: true } : { content: "OK" }))).toMatch(/Netzwerkfehler/);
    });

    it("HTTP-Fehler und kein JSON: ungültig; ein Schlüssel in der Fehlerantwort wird entfernt", async () => {
      expect(await invalidReason(api, () => ({ status: 500, rawBody: '{"error":"boom"}' }))).toMatch(/HTTP 500/);
      expect(await invalidReason(api, () => ({ rawBody: "keine json-antwort" }))).toMatch(/kein JSON/);
      expect(await invalidReason(api, () => ({ rawBody: "{}" }))).toMatch(/Ungültige Modellantwort/);
      const key = "sk-test-DUMMYKEY-12345";
      const reason = await invalidReason(api, () => ({ status: 401, rawBody: `{"error":"Falscher Schlüssel ${key}"}` }), { apiKey: key });
      expect(reason).toMatch(/HTTP 401/);
      expect(reason).not.toContain(key);
    });

    it("Zeitüberschreitung je Schritt und für den ganzen Lauf: ungültig", async () => {
      const slow: FakeScript = (req) => (position(req).hasTools ? { content: "zu spät", delayMs: 3000 } : { content: "OK" });
      expect(await invalidReason(api, slow, { stepTimeoutMs: 300 })).toMatch(/Zeitüberschreitung.*nicht geantwortet/);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 200);
      expect(await invalidReason(api, slow, { signal: controller.signal })).toMatch(/Zeitlimit des Laufs/);
    });

    it("zu viele Schritte: der Zug endet ohne Antwort (kein Fehler), mit Vermerk", async () => {
      const endless: FakeScript = (req) => (position(req).hasTools ? { toolCalls: [{ name: "get_booking", arguments: { guest: "Muster" } }] } : { content: "OK" });
      const { result } = await drive(api, endless, { maxSteps: 3, followup: null });
      expect(result.answer1).toBeNull();
      expect(result.maxStepsReached.turn1).toBe(true);
      expect(result.toolCalls).toBe(3);
    });

    it("Denk-Block steht nicht in der Antwort, bleibt aber im Verlauf", async () => {
      const script: FakeScript = (req) => (position(req).hasTools ? { content: "<think>Ich überlege kurz.</think>Fertig.", thinking: api === "ollama" ? "innere Gedanken" : undefined } : { content: "OK" });
      const { result, events } = await drive(api, script, { followup: null });
      expect(result.answer1).toBe("Fertig.");
      expect(events.find((e) => e.type === "model_response")).toMatchObject({ content: "<think>Ich überlege kurz.</think>Fertig." });
      if (api === "ollama") expect(events.find((e) => e.type === "model_response")).toMatchObject({ thinking: "innere Gedanken" });
    });

    it("Aufruf eines unbekannten Werkzeugs geht als Ergebnis zurück, der Lauf geht weiter", async () => {
      const script: FakeScript = (req) => {
        const p = position(req);
        if (!p.hasTools) return { content: "OK" };
        return p.toolsAfterLastUser === 0 ? { toolCalls: [{ name: "gibt_es_nicht", arguments: {} }] } : { content: "Das Werkzeug gibt es nicht." };
      };
      const { result, events } = await drive(api, script, { followup: null });
      expect(result.answer1).toBe("Das Werkzeug gibt es nicht.");
      expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true, harnessError: true });
    });

    it("der API-Schlüssel geht nur als Header an den Server und steht in keiner Zeile des Verlaufs", async () => {
      const key = "sk-test-DUMMYKEY-12345";
      const { events, model } = await drive(api, blindRetry, { apiKey: key });
      expect(model.requests.every((r) => r.headers.authorization === `Bearer ${key}`)).toBe(true);
      expect(JSON.stringify(events)).not.toContain(key);
      for (const r of model.requests) expect(JSON.stringify(r.body)).not.toContain(key);
    });
  });
}

describe("ungültige Tool-Argumente (OpenAI-kompatibel)", () => {
  it("Argumente, die kein JSON sind: ungültige Modellantwort", async () => {
    const script: FakeScript = (req) =>
      position(req).hasTools
        ? {
            rawBody: JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_booking", arguments: "{nicht json" } }] } }] }),
          }
        : { content: "OK" };
    expect(await invalidReason("openai", script)).toMatch(/kein JSON/);
  });

  it("ein Werkzeug-Aufruf ohne Namen: ungültige Modellantwort", async () => {
    const script: FakeScript = (req) =>
      position(req).hasTools ? { rawBody: JSON.stringify({ choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { arguments: "{}" } }] } }] }) } : { content: "OK" };
    expect(await invalidReason("openai", script)).toMatch(/keinen Namen/);
  });
});
