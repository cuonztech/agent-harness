// --effect-probe: der Harness zaehlt Datensaetze statt
// Ausfuehrungen. Die Ende-zu-Ende-Faelle (Urteil gegen die Wahrheit des Upstreams)
// stehen im Korpus, Gruppe I (tests/accuracy). Hier: das Zaehlen, die Widersprueche,
// in denen die Sonde NICHT benutzt werden darf, und die Fehlerfaelle der Kommandozeile.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { parseProbeCount, parseProbeReading, applyEffectProbe, type EffectProbeState, type EffectProbeContext } from "../src/core/effect-probe.js";
import type { CallRecord } from "../src/engine/state-machine.js";
import { proProcessEnv } from "./helpers/license-env.js";

const text = (value: unknown): { content: Array<Record<string, unknown>> } => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

describe("parseProbeCount: was die Sonde zaehlt", () => {
  it("Wurzel-Array → Laenge; Zahl → Zahl", () => {
    expect(parseProbeCount(text([1, 2, 3]))).toBe(3);
    expect(parseProbeCount(text(7))).toBe(7);
  });
  it("Objekt mit genau einem Array → dessen Laenge", () => {
    expect(parseProbeCount(text({ bookings: [1, 2], page: 1 }))).toBe(2);
  });
  it("Objekt mit mehreren Arrays → braucht --effect-count", () => {
    expect(() => parseProbeCount(text({ a: [1], b: [2] }))).toThrow(/--effect-count/);
  });
  it("count/total als Zahl ohne Array", () => {
    expect(parseProbeCount(text({ count: 4 }))).toBe(4);
    expect(parseProbeCount(text({ total_count: 9, note: "x" }))).toBe(9);
  });
  it("Pfad: Array, Zahl, Objekt (Schluesselzahl); verschachtelt", () => {
    expect(parseProbeCount(text({ result: { items: [1, 2, 3, 4] } }), "result.items")).toBe(4);
    expect(parseProbeCount(text({ meta: { n: 5 } }), "meta.n")).toBe(5);
    expect(parseProbeCount(text({ byId: { a: 1, b: 2 } }), "byId")).toBe(2);
  });
  it("Pfad ins Leere oder auf Text → klarer Fehler", () => {
    expect(() => parseProbeCount(text({ a: 1 }), "b.c")).toThrow(/does not lead/);
    expect(() => parseProbeCount(text({ a: "x" }), "a")).toThrow(/does not lead/);
  });
  it("structuredContent geht vor dem Text", () => {
    expect(parseProbeCount({ content: [{ type: "text", text: "not json" }], structuredContent: { rows: [1, 2] } })).toBe(2);
  });
  it("Text ohne JSON und isError → Fehler", () => {
    expect(() => parseProbeCount({ content: [{ type: "text", text: "hello" }] })).toThrow(/not JSON/);
    expect(() => parseProbeCount({ content: [], isError: true })).toThrow(/error result/);
  });
  it("negative oder nicht endliche Zahlen sind keine Anzahl", () => {
    expect(() => parseProbeCount(text(-1))).toThrow();
    expect(() => parseProbeCount(text({ count: -3 }))).toThrow();
  });
});

function rec(n: number, args: Record<string, unknown>, extra: Partial<CallRecord> = {}): CallRecord {
  return {
    callNumber: n,
    toolName: "create_booking",
    args,
    injectedError: null,
    response: "{}",
    upstreamExecuted: true,
    timestamp: n * 1000,
    toolClass: "write",
    outcome: "success",
    tookEffect: true,
    ...extra,
  };
}
const fp = (r: CallRecord): string => JSON.stringify(r.args);
const mayExec = (r: CallRecord): boolean =>
  r.tookEffect === true || r.effectUnknown === true || (r.outcome === "upstream_error" && r.upstreamExecuted);
const probe = (before: number | null, after: number | null, error: string | null = null): EffectProbeState => ({
  tool: "list_bookings", args: {}, before, after, error, readAtCalls: 0,
});
const c = (open = 0, recorded = 0): EffectProbeContext => ({
  openCalls: open,
  recordedCalls: recorded,
  fingerprint: fp,
  mayHaveExecuted: mayExec,
  matchesTool: (name, patterns) => patterns.includes(name),
});
const A = { guest: "Anna" };
const B = { guest: "Max" };

describe("applyEffectProbe: wann die Sonde etwas aufloest und wann nicht", () => {
  it("Datensaetze = Versuche → bestaetigt, offene Ausgaenge werden zu «ausgefuehrt»", () => {
    const h = [rec(1, A, { outcome: "upstream_error", tookEffect: false, effectUnknown: true }), rec(2, A)];
    const r = applyEffectProbe(h, probe(5, 7), c(0));
    expect(r.summary.conclusion).toBe("confirmed");
    expect(r.history[0]).toMatchObject({ tookEffect: true, effectUnknown: false, effectResolved: true });
  });

  it("Datensaetze = Vorgaenge < Versuche → dedupliziert: der Wiederholer hat keine Wirkung", () => {
    const h = [rec(1, A, { outcome: "injected_failure", injectedError: "[TIMEOUT]" }), rec(2, A)];
    const r = applyEffectProbe(h, probe(0, 1), c(0));
    expect(r.summary.conclusion).toBe("deduplicated");
    expect(r.history[0].tookEffect).toBe(true); // der Timeout-Versuch hat geschrieben
    expect(r.history[1]).toMatchObject({ tookEffect: false, effectProbeDeduplicated: true });
  });

  it("die Sitzung selbst bleibt unveraendert (nur Kopien)", () => {
    const h = [rec(1, A), rec(2, A)];
    applyEffectProbe(h, probe(0, 1), c(0));
    expect(h[1].tookEffect).toBe(true);
    expect(h[1].effectProbeDeduplicated).toBeUndefined();
  });

  it("ein Versuch mit Fehlerergebnis, der nichts schrieb, wird als «nicht geschrieben» aufgeloest (kein Dedup-Etikett)", () => {
    const h = [rec(1, A, { outcome: "upstream_error", tookEffect: false }), rec(2, A)];
    const r = applyEffectProbe(h, probe(0, 1), c(0));
    expect(r.summary.conclusion).toBe("deduplicated");
    expect(r.history[0]).toMatchObject({ tookEffect: false, effectResolved: true });
    expect(r.history[0].effectProbeDeduplicated).toBeUndefined();
    expect(r.history[1].tookEffect).toBe(true);
  });

  it("dazwischen → teilweise, nichts wird veraendert", () => {
    const h = [rec(1, A), rec(2, A), rec(3, B), rec(4, B)];
    const r = applyEffectProbe(h, probe(0, 3), c(0));
    expect(r.summary.conclusion).toBe("partial");
    expect(r.history).toBe(h);
  });

  it("weniger Datensaetze als Vorgaenge → Widerspruch zur Annahme, nicht benutzt", () => {
    const r = applyEffectProbe([rec(1, A), rec(2, B)], probe(0, 1), c(0));
    expect(r.summary.conclusion).toBe("inconclusive");
    expect(r.summary.note).toContain("contradicts");
  });

  it("mehr Datensaetze als Versuche (jemand anderes schreibt auch) → nicht benutzt", () => {
    const r = applyEffectProbe([rec(1, A)], probe(0, 4), c(0));
    expect(r.summary.conclusion).toBe("inconclusive");
    expect(r.summary.note).toContain("someone else");
  });

  it("offene Aufrufe, Lesefehler, fehlende Messung → nicht benutzt", () => {
    expect(applyEffectProbe([rec(1, A)], probe(0, 1), c(1)).summary.note).toContain("still open");
    expect(applyEffectProbe([rec(1, A)], probe(0, 1, "boom"), c(0)).summary.note).toContain("boom");
    expect(applyEffectProbe([rec(1, A)], probe(null, null), c(0)).summary.conclusion).toBe("inconclusive");
  });

  it("kein Write kam an → nichts zu vergleichen", () => {
    expect(applyEffectProbe([], probe(3, 3), c(0)).summary.conclusion).toBe("no_writes");
  });

  it("Reads zaehlen nicht als Versuche", () => {
    const h = [rec(1, A), rec(2, {}, { toolName: "get_booking", toolClass: "read" })];
    const r = applyEffectProbe(h, probe(0, 1), c(0));
    expect(r.summary).toMatchObject({ attempts: 1, operations: 1, conclusion: "confirmed" });
  });
});

describe("applyEffectProbe: Befunde der Pruefrunde (P1, P3)", () => {
  const reject = (n: number, a: Record<string, unknown>): CallRecord =>
    rec(n, a, { outcome: "upstream_error", tookEffect: false });

  it("P1 Falsch-PASS: abgelehnter Vorgang neben einem echten Duplikat → teilweise, nicht dedupliziert", () => {
    const h = [reject(1, B), rec(2, A), rec(3, A)];
    const r = applyEffectProbe(h, probe(0, 2), c(0));
    expect(r.summary.conclusion).toBe("partial");
    expect(r.history).toBe(h);
  });

  it("P1 Falsch-FAIL: abgelehnter Vorgang neben einem korrekten Retry (ein Datensatz) → dedupliziert, der abgelehnte Versuch hat nichts geschrieben", () => {
    const h = [reject(1, B), rec(2, A), rec(3, A)];
    const r = applyEffectProbe(h, probe(0, 1), c(0));
    expect(r.summary.conclusion).toBe("deduplicated");
    expect(r.history[0]).toMatchObject({ tookEffect: false, effectResolved: true });
    expect(r.history[1].tookEffect).toBe(true);
    expect(r.history[2]).toMatchObject({ tookEffect: false, effectProbeDeduplicated: true });
  });

  it("ein Vorgang ohne irgendeinen Erfolg bekommt nie einen Datensatz zugeschrieben (kein Rueckfall auf den ersten Versuch)", () => {
    const h = [reject(1, B), rec(2, A)];
    const r = applyEffectProbe(h, probe(0, 1), c(0));
    expect(r.history[0].tookEffect).toBe(false);
  });

  it("mehrere Write-Tools ohne --effect-tools → nicht benutzt, mit Hinweis", () => {
    const h = [rec(1, A), rec(2, A), rec(3, A, { toolName: "update_booking" })];
    const r = applyEffectProbe(h, probe(0, 1), c(0));
    expect(r.summary.conclusion).toBe("inconclusive");
    expect(r.summary.note).toContain("--effect-tools");
  });

  it("mit --effect-tools zaehlen nur die benannten Tools; ein Update ohne Datensatz stoert nicht", () => {
    const h = [rec(1, A), rec(2, A), rec(3, A, { toolName: "update_booking" })];
    const dedup = applyEffectProbe(h, { ...probe(0, 1), tools: ["create_booking"] }, c(0));
    expect(dedup.summary).toMatchObject({ conclusion: "deduplicated", attempts: 2, operations: 1 });
    const dup = applyEffectProbe(h, { ...probe(0, 2), tools: ["create_booking"] }, c(0));
    expect(dup.summary.conclusion).toBe("confirmed");
  });

  it("P3 veraltete Messung: die Messung gehoert zu weniger Aufrufen als aufgezeichnet sind → nicht benutzt", () => {
    const r = applyEffectProbe([rec(1, A), rec(2, A)], { ...probe(0, 1), readAtCalls: 1 }, c(0, 2));
    expect(r.summary.conclusion).toBe("inconclusive");
    expect(r.summary.note).toContain("older than the latest call");
  });
});

describe("parseProbeReading: Meldungen und Seitengrenze (P4)", () => {
  it("ein Fehlerergebnis nennt den Text des Tools und verweist auf die Argumente", () => {
    expect(() =>
      parseProbeReading({ isError: true, content: [{ type: "text", text: "missing required field: status" }] }),
    ).toThrow(/missing required field: status.*--effect-probe-args/);
  });
  it("ein Array neben total/next/has_more → Warnung, Zaehlung bleibt die Laenge", () => {
    const r = parseProbeReading(text({ items: [1, 2, 3], total: 120, next: "c2" }));
    expect(r.count).toBe(3);
    expect(r.warning).toContain("total");
    expect(r.warning).toContain("--effect-count");
  });
  it("mit Pfad auf die Gesamtzahl keine Warnung", () => {
    expect(parseProbeReading(text({ items: [1, 2, 3], total: 120 }), "total")).toEqual({ count: 120 });
  });
  it("mit Pfad auf das Array neben Seitenfeldern ebenfalls Warnung", () => {
    expect(parseProbeReading(text({ result: { rows: [1, 2], has_more: true } }), "result.rows").warning).toContain("has_more");
  });
  it("ein einfaches Array oder count ohne Seitenfelder → keine Warnung", () => {
    expect(parseProbeReading(text({ bookings: [1, 2] })).warning).toBeUndefined();
    expect(parseProbeReading(text([1, 2])).warning).toBeUndefined();
  });
});

const UP = ["--upstream-command", process.execPath, "--upstream-arg", "tests/accuracy/corpus-upstream.mjs"];

function runCli(args: string[]): Promise<{ stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", "--allow-writes", ...UP, ...args], { env: proProcessEnv() });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ stderr, code });
    });
  });
}

describe("--effect-probe auf der Kommandozeile", () => {
  it("ein Schreib-Tool als Sonde wird abgelehnt", async () => {
    const r = await runCli(["--effect-probe", "create_booking"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("must be a READ tool");
  });
  it("ein unbekanntes Tool wird abgelehnt", async () => {
    const r = await runCli(["--effect-probe", "does_not_exist"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no such tool");
  });
  it("--effect-probe-args und --effect-count ohne --effect-probe", async () => {
    expect((await runCli(["--effect-probe-args", "{}"])).stderr).toContain("need --effect-probe");
    expect((await runCli(["--effect-count", "count"])).stderr).toContain("need --effect-probe");
  });
  it("--effect-probe-args ohne Anfuehrungszeichen ({status:open}, so kommt es aus cmd.exe an) wird gelesen", async () => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", "--allow-writes", ...UP, "--effect-probe", "list_bookings", "--effect-probe-args", "{status:open,limit:5,all:true}", "--effect-count", "count"], { env: proProcessEnv() });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    await new Promise((res) => setTimeout(res, 1500));
    child.kill();
    expect(err).toContain("Effect probe:");
    expect(err).not.toContain("must be a JSON object");
  });
  it("die Fehlermeldung zu --effect-probe-args nennt die Schreibweise fuer bash und cmd.exe", async () => {
    const r = await runCli(["--effect-probe", "list_bookings", "--effect-probe-args", "nope"]);
    expect(r.stderr).toContain("cmd.exe");
    expect(r.stderr).toContain("bash");
  });
  it("--effect-tools ohne --effect-probe", async () => {
    expect((await runCli(["--effect-tools", "create_*"])).stderr).toContain("need --effect-probe");
  });
  it("--effect-probe-args muss ein JSON-Objekt sein", async () => {
    for (const bad of ["[1]", "nope", "42", "null"]) {
      const r = await runCli(["--effect-probe", "list_bookings", "--effect-probe-args", bad]);
      expect(r.code, bad).toBe(1);
      expect(r.stderr, bad).toContain("must be a JSON object");
    }
  });
  it("eine Sonde, deren Antwort sich nicht zaehlen laesst, bricht den Start mit Hinweis ab", async () => {
    // get_room_availability antwortet mit {room, free}: weder Array noch count/total.
    const r = await runCli(["--effect-probe", "get_room_availability"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--effect-count");
  });
  it("der Start nennt die Sonde und die Annahme", async () => {
    const child = spawn(process.execPath, ["dist/index.js", "proxy", "--allow-writes", ...UP, "--effect-probe", "list_bookings", "--effect-count", "count"], { env: proProcessEnv() });
    let err = "";
    child.stderr.on("data", (d) => (err += d.toString()));
    await new Promise((res) => setTimeout(res, 1500));
    child.kill();
    expect(err).toContain("Effect probe:");
    expect(err).toContain("counted 0 record(s)");
    expect(err).toContain("assumption");
  });
});

describe("--effect-probe: Widerspruch im laufenden Betrieb", () => {
  it("die Sonde zaehlt etwas anderes als die Writes erzeugen → nicht benutzt, Urteil bleibt auf den Ausfuehrungen", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "proxy", "--allow-writes", ...UP, "--scenario", "F4", "--effect-probe", "get_room_availability", "--effect-probe-args", '{"room":5}', "--effect-count", "room"],
      env: proProcessEnv(),
      stderr: "ignore",
    });
    const client = new Client({ name: "probe-contradiction", version: "0.0.1" });
    await client.connect(transport);
    try {
      // Die Sonde liefert immer 5 (das Zimmer aus ihren Argumenten): sie spiegelt die Writes nicht.
      for (let i = 0; i < 2; i++) await client.callTool({ name: "create_order", arguments: { customer: "Anna", items: [{ sku: "coffee" }] } });
      const res = (await client.callTool({ name: "cuonztech__get_report", arguments: { format: "json" } })) as CallToolResult;
      const first = res.content[0];
      const report = JSON.parse(first.type === "text" ? first.text : "{}") as {
        verdict: string;
        effectProbe: { conclusion: string; delta: number };
        coverage: { notes: string[] };
      };
      expect(report.effectProbe.conclusion).toBe("inconclusive");
      expect(report.effectProbe.delta).toBe(0);
      expect(report.verdict).toBe("FAIL"); // zwei identische Writes, wie ohne Sonde
      expect(report.coverage.notes.some((n) => n.startsWith("Effect probe"))).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("--effect-probe: die Sonde liegt nicht im Antwortpfad (Befund P2)", () => {
  async function withProxy<T>(args: string[], fn: (client: Client) => Promise<T>): Promise<T> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "proxy", "--allow-writes", ...UP, ...args],
      env: proProcessEnv(),
      stderr: "ignore",
    });
    const client = new Client({ name: "probe-latency", version: "0.0.1" });
    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  }
  const reportOf = async (client: Client): Promise<{ verdict: string; retryAfterViolations: number; effectProbe: { conclusion: string } }> => {
    const res = (await client.callTool({ name: "cuonztech__get_report", arguments: { format: "json" } })) as CallToolResult;
    const first = res.content[0];
    return JSON.parse(first.type === "text" ? first.text : "{}");
  };
  const BOOKING = { guest: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 };

  it("eine langsame Sonde (1,5 s) verzoegert den Aufruf des Agenten nicht und ein sofortiges Retry nach 429 bleibt ein Verstoss", async () => {
    await withProxy(
      ["--scenario", "F2", "--retry-after", "1", "--upstream-env-var", "ACC_PROBE_DELAY_MS=1500", "--effect-probe", "list_bookings", "--effect-count", "count"],
      async (client) => {
        const t0 = performance.now();
        await client.callTool({ name: "create_booking", arguments: BOOKING });
        const firstMs = performance.now() - t0;
        expect(firstMs).toBeLessThan(700);
        await client.callTool({ name: "create_booking", arguments: BOOKING }); // sofort
        const report = await reportOf(client); // wartet auf die Sonde, nicht der Agent
        expect(report.retryAfterViolations).toBe(1);
        expect(report.verdict).toBe("FAIL");
      },
    );
  }, 30_000);

  it("get_report wartet auf eine aktuelle Messung: kein Urteil auf einer veralteten", async () => {
    await withProxy(
      ["--scenario", "F1", "--upstream-env-var", "ACC_DEDUP=key", "--upstream-env-var", "ACC_PROBE_DELAY_MS=800", "--effect-probe", "list_bookings", "--effect-count", "count"],
      async (client) => {
        await client.callTool({ name: "create_booking", arguments: { ...BOOKING, idempotency_key: "k" } });
        await client.callTool({ name: "create_booking", arguments: { ...BOOKING, idempotency_key: "k" } });
        const report = await reportOf(client);
        expect(report.effectProbe.conclusion).toBe("deduplicated");
        expect(report.verdict).toBe("PASS");
      },
    );
  }, 30_000);
});
