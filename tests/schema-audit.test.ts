// Schnittstellen-Gutachten (src/schema-audit.ts), deutsche Beobachtungstexte,
// deutscher Prompt-Baustein und die Abschnitte im Bericht. Das Gutachten liest
// nur Schemas; hier mit selbst gebauten Tool-Listen und mit einem echten
// Proxy-Lauf gegen den Fixture-Server.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { proProcessEnv } from "./helpers/license-env.js";
import { auditToolSchemas } from "../src/schema-audit.js";
import { collectDoctor } from "../src/doctor.js";
import { OBSERVATION_DE, observationDe } from "../src/core/report-generator.js";
import { generatePromptPatchDe } from "../src/hardening/patch-generator.js";
import { renderHtml, renderMarkdown, type ReportFile } from "../src/plain-report.js";
import type { ToolInput } from "../src/types.js";

const tool = (
  name: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
  annotations?: Record<string, unknown>,
): ToolInput => ({
  name,
  inputSchema: { type: "object", properties, required },
  ...(annotations ? { annotations } : {}),
});

const entryOf = (tools: ToolInput[], name: string) => {
  const entry = auditToolSchemas(tools).tools.find((t) => t.name === name);
  if (!entry) throw new Error(`no entry for ${name}`);
  return entry;
};

describe("Idempotenz-Schlüssel", () => {
  it.each(["idempotency_key", "idempotencyKey", "Idempotency-Key", "request_id", "requestId", "client_reference_id", "clientReferenceId", "dedup_key", "dedupKey", "transaction_id", "transactionId"])(
    "erkennt das Feld %s",
    (field) => {
      const e = entryOf([tool("create_booking", { guest: {}, [field]: {} })], "create_booking");
      expect(e.hasIdempotencyKey).toBe(true);
      expect(e.idempotencyFieldName).toBe(field);
      expect(e.recommendedSchemaPatch).toBeNull();
      expect(e.findingsDe.join(" ")).not.toContain("Kein Idempotenz-Schlüssel");
    },
  );

  it("erkennt ein fehlendes Feld bei einem Schreib-Tool und liefert ein kopierfertiges Schema", () => {
    const e = entryOf([tool("create_booking", { guest: {}, room: {} })], "create_booking");
    expect(e.classification).toBe("write");
    expect(e.hasIdempotencyKey).toBe(false);
    expect(e.idempotencyFieldName).toBeNull();
    expect(e.findingsDe[0]).toContain("Kein Idempotenz-Schlüssel (z. B. idempotency_key)");
    expect(e.recommendedSchemaPatch).toEqual({
      type: "string",
      description: "Eindeutiger Schlüssel zur Vermeidung von Doppelausführungen bei Wiederholungsversuchen",
    });
  });

  it("ein Feld nur im Namen eines anderen Felds zählt nicht (nicht 'user_request_identifier')", () => {
    expect(entryOf([tool("create_booking", { user_request_identifier: {} })], "create_booking").hasIdempotencyKey).toBe(false);
  });
});

describe("Nachsehen ohne ID (canVerifyWithoutId)", () => {
  it("get_booking mit Pflicht-ID reicht nicht, list_bookings ohne Pflicht-ID reicht", () => {
    const onlyGet = [tool("create_booking", { guest: {} }), tool("get_booking", { booking_id: {} }, ["booking_id"])];
    const a = entryOf(onlyGet, "create_booking");
    expect(a.matchingReadTools).toEqual(["get_booking"]);
    expect(a.canVerifyWithoutId).toBe(false);
    expect(a.findingsDe.join(" ")).toContain("verlangen alle eine ID als Pflichtfeld");

    const withList = [...onlyGet, tool("list_bookings", { guest: {} })];
    const b = entryOf(withList, "create_booking");
    expect(b.matchingReadTools).toEqual(["get_booking", "list_bookings"]);
    expect(b.canVerifyWithoutId).toBe(true);
  });

  it.each(["id", "booking_id", "bookingId", "invoiceId", "uuid", "booking-id"])("Pflichtfeld %s zählt als ID", (field) => {
    const tools = [tool("create_booking"), tool("get_booking", { [field]: {} }, [field])];
    expect(entryOf(tools, "create_booking").canVerifyWithoutId).toBe(false);
  });

  it("ein Pflichtfeld, das keine ID ist (guest, valid), verhindert das Nachsehen nicht", () => {
    const tools = [tool("create_booking"), tool("search_bookings", { guest: {}, valid: {} }, ["guest", "valid"])];
    expect(entryOf(tools, "create_booking").canVerifyWithoutId).toBe(true);
  });

  it("ein ID-Feld, das nicht Pflicht ist, zählt nicht", () => {
    const tools = [tool("create_booking"), tool("get_booking", { booking_id: {}, guest: {} }, [])];
    expect(entryOf(tools, "create_booking").canVerifyWithoutId).toBe(true);
  });

  it("ohne passendes Lese-Tool: nicht möglich, mit eigenem Befund", () => {
    const e = entryOf([tool("create_booking"), tool("list_users")], "create_booking");
    expect(e.matchingReadTools).toEqual([]);
    expect(e.canVerifyWithoutId).toBe(false);
    expect(e.findingsDe.join(" ")).toContain("Kein passendes Lese- oder Such-Tool ohne Pflicht-ID gefunden");
  });

  it("ein Lese-Tool ohne Bezug zum Objekt zählt nicht als Gegenstück", () => {
    expect(entryOf([tool("create_booking"), tool("list_users")], "create_booking").matchingReadTools).toEqual([]);
  });

  it("allgemeine Such- und Listen-Tools gelten für jedes Schreib-Tool", () => {
    const tools = [tool("create_booking"), tool("search_records", { query: {} }), tool("list_all")];
    expect(entryOf(tools, "create_booking").matchingReadTools).toEqual(["search_records", "list_all"]);
  });
});

describe("Einzahl und Mehrzahl", () => {
  it.each([
    ["create_invoice", "list_invoices"],
    ["add_entry", "list_entries"],
    ["create_address", "list_addresses"],
    ["send_message", "search_messages"],
    ["createAppointment", "listAppointments"],
    ["create_bookings", "get_booking"],
  ])("%s findet %s", (write, read) => {
    expect(entryOf([tool(write), tool(read)], write).matchingReadTools).toEqual([read]);
  });

  it("'status' und 'class' werden nicht verstümmelt", () => {
    expect(entryOf([tool("update_status"), tool("get_status")], "update_status").matchingReadTools).toEqual(["get_status"]);
    expect(entryOf([tool("create_class"), tool("list_classes")], "create_class").matchingReadTools).toEqual(["list_classes"]);
  });
});

describe("Risikostufe", () => {
  const key = { idempotency_key: {} };
  it("HOCH: weder Schlüssel noch Nachsehen", () => {
    expect(entryOf([tool("create_booking")], "create_booking").riskLevel).toBe("HIGH");
  });
  it("MITTEL: nur der Schlüssel, oder nur das Nachsehen", () => {
    expect(entryOf([tool("create_booking", key)], "create_booking").riskLevel).toBe("MEDIUM");
    expect(entryOf([tool("create_booking"), tool("list_bookings")], "create_booking").riskLevel).toBe("MEDIUM");
  });
  it("NIEDRIG: beides", () => {
    expect(entryOf([tool("create_booking", key), tool("list_bookings")], "create_booking").riskLevel).toBe("LOW");
  });
  it("Lese-Tools sind immer NIEDRIG und bekommen keine Befunde", () => {
    const e = entryOf([tool("list_bookings"), tool("create_booking")], "list_bookings");
    expect(e.classification).toBe("read");
    expect(e.riskLevel).toBe("LOW");
    expect(e.findingsDe).toEqual([]);
    expect(e.recommendedSchemaPatch).toBeNull();
    expect(e.matchingReadTools).toEqual([]);
  });
});

describe("MCP-Annotationen und Einordnung", () => {
  it("erkennt readOnlyHint, destructiveHint und idempotentHint, auch mit Wert false", () => {
    for (const annotations of [{ readOnlyHint: false }, { destructiveHint: false }, { idempotentHint: true }]) {
      expect(entryOf([tool("create_booking", {}, [], annotations)], "create_booking").hasMcpAnnotations).toBe(true);
    }
    expect(entryOf([tool("create_booking", {}, [], { title: "Buchung" })], "create_booking").hasMcpAnnotations).toBe(false);
    const missing = entryOf([tool("create_booking")], "create_booking");
    expect(missing.hasMcpAnnotations).toBe(false);
    expect(missing.findingsDe.join(" ")).toContain("Keine MCP-Tool-Annotationen");
  });

  it("nutzt die Einordnung des Proxys: Annotation vor Namen, --write-tools vor beidem", () => {
    expect(entryOf([tool("frobnicate", {}, [], { readOnlyHint: true })], "frobnicate").classification).toBe("read");
    expect(entryOf([tool("frobnicate", {}, [], { readOnlyHint: false })], "frobnicate").classification).toBe("write");
    const custom = auditToolSchemas([tool("frobnicate")], { writeToolPatterns: ["frob*"] });
    expect(custom.tools[0]!.classification).toBe("write");
  });

  it("ein Tool, das sich nicht einordnen lässt, ist 'ambiguous' und wird wie ein Schreib-Tool beurteilt", () => {
    const e = entryOf([tool("frobnicate")], "frobnicate");
    expect(e.classification).toBe("ambiguous");
    expect(e.riskLevel).toBe("HIGH");
    expect(e.findingsDe[0]).toContain("eindeutig als lesend oder schreibend einordnen");
  });
});

describe("Gesamtergebnis", () => {
  const tools = [
    tool("create_booking", { guest: {} }),
    tool("create_invoice", { idempotency_key: {} }, [], { readOnlyHint: false }),
    tool("list_invoices", {}),
    tool("get_booking", { booking_id: {} }, ["booking_id"]),
    tool("frobnicate"),
  ];
  const report = auditToolSchemas(tools);

  it("zählt und listet", () => {
    expect(report.totalTools).toBe(5);
    expect(report.writeToolsCount).toBe(2);
    expect(report.readToolsCount).toBe(2);
    expect(report.ambiguousToolsCount).toBe(1);
    expect(report.writeToolsWithoutIdempotencyKey).toEqual(["create_booking", "frobnicate"]);
    expect(report.writeToolsWithoutLookupTool).toEqual(["create_booking", "frobnicate"]);
    expect(report.highRiskToolsCount).toBe(2);
    expect(report.tools).toHaveLength(5);
  });

  it("fasst auf Deutsch zusammen", () => {
    expect(report.summaryDe).toContain("5 Tools: 2 schreibend, 2 lesend, 1 nicht eindeutig");
    expect(report.summaryDe).toContain("create_booking");
    expect(report.summaryDe).toContain("Risikostufe HOCH");
  });

  it("eine leere Tool-Liste und eine ohne Schreib-Tools ergeben eine ehrliche Aussage", () => {
    expect(auditToolSchemas([]).summaryDe).toContain("keine Tools");
    expect(auditToolSchemas([tool("list_bookings")]).summaryDe).toContain("kein Schreib-Tool erkannt");
  });

  it("verträgt Tools ohne Schema und mit seltsamen Annotationen", () => {
    const odd: ToolInput[] = [{ name: "create_x" }, { name: "get_x", inputSchema: { properties: undefined, required: undefined } }];
    expect(() => auditToolSchemas(odd)).not.toThrow();
    // create_x hat mit get_x ein Gegenstück ohne Pflicht-ID, aber keinen Schlüssel.
    expect(auditToolSchemas(odd).tools[0]!.riskLevel).toBe("MEDIUM");
  });
});

describe("Deutsche Texte: Schweizer Rechtschreibung (kein ß)", () => {
  const audit = auditToolSchemas([
    tool("create_booking", { guest: {} }),
    tool("get_booking", { booking_id: {} }, ["booking_id"]),
    tool("frobnicate"),
    tool("create_invoice", { idempotency_key: {} }),
  ]);

  it("Gutachten: Befunde, Zusammenfassung, Schema-Vorschlag", () => {
    const text = [audit.summaryDe, ...audit.tools.flatMap((t) => t.findingsDe), JSON.stringify(audit.tools.map((t) => t.recommendedSchemaPatch))].join("\n");
    expect(text).not.toContain("ß");
    expect(text).toContain("Idempotenz");
  });

  it("Beobachtungen: jede Art hat einen deutschen Text ohne ß", () => {
    for (const [type, text] of Object.entries(OBSERVATION_DE)) {
      expect(text.length, type).toBeGreaterThan(20);
      expect(text, type).not.toContain("ß");
    }
    const line = observationDe({ callNumber: 3, type: "VERIFIED_NO_RETRY", tool: "create_booking", description: "english" });
    expect(line.startsWith("Aufruf 3, create_booking: ")).toBe(true);
    expect(line).not.toContain("english");
  });

  it("Beobachtung: ein Tool-Name mit Zeilenumbruch kann keine Zeile vortäuschen", () => {
    const line = observationDe({ callNumber: 1, type: "EXECUTION_UNKNOWN", tool: "x\n## Fake\u2028y", description: "" });
    expect(line).not.toMatch(/[\n\u2028]/);
  });

  it("Prompt-Baustein: deutsch, mit Tool-Namen, ohne ß", () => {
    const patch = generatePromptPatchDe([], ["create_booking"], ["list_bookings", "get_booking"]);
    expect(patch).not.toContain("ß");
    expect(patch).toContain("Schreibende Tools: create_booking.");
    expect(patch).toContain("Lesende Tools zum Nachsehen: list_bookings, get_booking.");
    expect(patch).toContain("Sende denselben Schreibvorgang nicht noch einmal");
    expect(generatePromptPatchDe([], [], [])).not.toContain("Schreibende Tools");
  });

  it("Quelltexte mit deutschen Ausgaben enthalten kein ß", async () => {
    for (const file of ["src/plain-report.ts", "src/schema-audit.ts", "src/core/report-generator.ts", "src/hardening/patch-generator.ts", "src/doctor.ts", "src/ui/page.ts", "src/ui/server.ts"]) {
      const code = (await readFile(file, "utf8")).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      expect(code, file).not.toContain("ß");
    }
  });
});

describe("Bericht: Abschnitt Schnittstellen- & Schema-Prüfung", () => {
  const audit = auditToolSchemas([tool("create_booking", { guest: {} }), tool("get_booking", { booking_id: {} }, ["booking_id"]), tool("create_invoice", { idempotency_key: {} }), tool("list_invoices")]);
  const file: ReportFile = { harnessVersion: "0.7.0", verdict: "NOT_TESTED", schema_audit: audit, recommended_prompt_patch_de: "Teste Deutsch" };

  it("Markdown: Risikostufen, Schlüssel, Nachsehen, Befunde, Schema-Vorschlag", () => {
    const md = renderMarkdown(file);
    expect(md).toContain("## Schnittstellen- & Schema-Prüfung (MCP-Tools)");
    expect(md).toContain("### create_booking — Risiko HOCH");
    expect(md).toContain("### create_invoice — Risiko NIEDRIG");
    expect(md).toContain("- Idempotenz-Schlüssel: fehlt");
    expect(md).toContain("- Idempotenz-Schlüssel: vorhanden (`idempotency_key`)");
    expect(md).toContain("- Nachsehen nach einem Timeout ohne ID: nicht möglich");
    expect(md).toContain("- Nachsehen nach einem Timeout ohne ID: möglich (list_invoices)");
    expect(md).toContain("- Befund: Kein Idempotenz-Schlüssel");
    expect(md).toContain('"idempotency_key": {');
    expect(md.indexOf("create_booking — Risiko HOCH")).toBeLessThan(md.indexOf("create_invoice — Risiko NIEDRIG"));
    expect(md).not.toContain("ß");
  });

  it("HTML: derselbe Abschnitt, maskiert", () => {
    const html = renderHtml(file);
    expect(html).toContain("<h2>Schnittstellen- &amp; Schema-Prüfung (MCP-Tools)</h2>");
    expect(html).toContain("<h3>create_booking — Risiko HOCH</h3>");
    expect(html).not.toContain("<script");
  });

  it("ein Tool-Name mit Markdown-Zeichen kann den Bericht nicht umbauen", () => {
    const evil = auditToolSchemas([tool("create_x\n## Gefälscht\n```")]);
    const md = renderMarkdown({ harnessVersion: "0.7.0", schema_audit: evil });
    expect(md).not.toMatch(/^## Gefälscht/m);
    expect(md.split("\n").filter((l) => l.startsWith("```")).length % 2).toBe(0);
  });

  it("ohne schema_audit erscheint der Abschnitt nicht (Berichte aus 0.6.x)", () => {
    expect(renderMarkdown({ harnessVersion: "0.6.0", verdict: "NOT_TESTED" })).not.toContain("Schema-Prüfung");
  });
});

describe("doctor und Proxy-Report liefern das Gutachten mit", () => {
  const FIXTURE = "tests/fixtures/upstream-fixture-server.mjs";

  it("collectDoctor hängt schemaAudit an, die bestehenden Felder bleiben", async () => {
    const result = await collectDoctor({ command: process.execPath, upstreamArgs: [FIXTURE], writeTools: [], readTools: [] });
    expect(result.checks.length).toBeGreaterThan(0);
    expect(Array.isArray(result.toolLines)).toBe(true);
    expect(typeof result.ok).toBe("boolean");
    expect(result.schemaAudit?.totalTools).toBeGreaterThan(5);
    expect(result.schemaAudit?.summaryDe).toContain("Der Server bietet");
  }, 40_000);

  it("ohne erreichbaren Server gibt es kein Gutachten und keinen Absturz", async () => {
    const result = await collectDoctor({ command: process.execPath, upstreamArgs: ["no/such/file.js"], writeTools: [], readTools: [] });
    expect(result.schemaAudit).toBeUndefined();
    expect(result.ok).toBe(false);
  }, 40_000);

  it("die doctor-Ausgabe enthält die Schnittstellen-Prüfung", async () => {
    const out = await new Promise<string>((ok) => {
      const child = spawn(process.execPath, ["dist/index.js", "doctor", "--upstream-command", process.execPath, "--upstream-arg", FIXTURE]);
      let text = "";
      child.stdout.on("data", (d) => (text += d.toString()));
      child.on("exit", () => ok(text));
    });
    expect(out).toContain("Schnittstellen-Prüfung (nur Schema, nichts wurde aufgerufen)");
    expect(out).toContain("Der Server bietet");
  }, 40_000);

  it("die Report-Datei des Proxys hat schema_audit, deutsche Beobachtungen und den deutschen Baustein; der Bericht zeigt sie", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schema-audit-"));
    const reportFile = join(dir, "report.json");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js", "proxy", "--upstream-command", process.execPath, "--upstream-arg", FIXTURE, "--scenario", "F1", "--allow-writes", "--audit-tools", "off", "--report-file", reportFile],
      env: proProcessEnv(),
      stderr: "ignore",
    });
    const client = new Client({ name: "schema-audit-test", version: "0" });
    await client.connect(transport);
    try {
      await client.callTool({ name: "create_booking", arguments: { guest: "A", room: 1 } }).catch(() => undefined);
      await client.callTool({ name: "get_ledger", arguments: {} }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      const file = JSON.parse(await readFile(reportFile, "utf8")) as ReportFile & { report: { observations: unknown[]; observations_de: string[] } };
      expect(file.schema_audit?.totalTools).toBeGreaterThan(5);
      expect(file.recommended_prompt_patch_de).toContain("Schreibende Tools:");
      expect(file.report.observations_de).toHaveLength(file.report.observations.length);
      expect(file.report.observations_de.length).toBeGreaterThan(0);
      // Die bisherigen Felder bleiben.
      expect(file.harnessVersion).toBeTruthy();
      expect(file.report.observations.length).toBeGreaterThan(0);
      expect(Array.isArray(file.patches)).toBe(true);

      const md = renderMarkdown(file);
      expect(md).toContain("## Beobachtungen");
      expect(md).not.toContain("Technische Beobachtungen (Originaltext des Harness)");
      expect(md).toContain("Textbaustein für den Prompt des Agenten (Deutsch");
      expect(md).toContain("Schnittstellen- & Schema-Prüfung (MCP-Tools)");
      for (const line of file.report.observations_de) expect(md).toContain(line);
    } finally {
      await client.close();
    }
  }, 60_000);
});
