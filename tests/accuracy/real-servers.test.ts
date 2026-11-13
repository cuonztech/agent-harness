// Tool-Einordnung an echten MCP-Servern (docs/MESSUNG-ECHTE-SERVER.md).
// Datensatz real-servers.json: 376 Tools aus 24 oeffentlichen Servern (nur Name und Wahrheit, gelesen
// per tools/list, nichts aufgerufen). Wahrheit: readOnlyHint des Servers (annotation), sonst eigene
// Beschriftung nach der Beschreibung (manual); mehrdeutige Tools sind nicht enthalten.
// Menge A diente zum Finden der Luecken, Menge B wurde vor der Aenderung als Kontrollmenge gemessen
// (die Verbliste wurde danach um Woerter erweitert, die in B fehlten: B ist darum nicht mehr voellig
// unabhaengig, siehe Dokument).
//
// Gemessen wird die Einordnung nach Name UND Beschreibung, ohne Annotation (so, wie bei einem Server ohne
// Annotationen); die Beschreibung ist auf 600 Zeichen gekuerzt (so viel liest der Harness).
// Die Zahlen sind festgenagelt: jede Aenderung der Muster zeigt sich hier mit ihrer Wirkung.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "../../src/proxy/interceptor.js";

interface Row { set: "A" | "B"; server: string; version: string; tool: string; truth: "read" | "write"; source: "annotation" | "manual"; description: string }
const rows = JSON.parse(readFileSync("tests/accuracy/real-servers.json", "utf8")) as Row[];
const cfg = { writeToolPatterns: [] as string[], readToolPatterns: [] as string[] };

function measure(set: "A" | "B") {
  const rs = rows.filter((r) => r.set === set);
  const c = { right: 0, writeAsRead: 0, writeUnclassified: 0, readAsWrite: 0, readUnclassified: 0 };
  for (const r of rs) {
    const tool: Tool = { name: r.tool, description: r.description, inputSchema: { type: "object", properties: {} } };
    const got = classifyUpstreamTool(tool, cfg).class;
    if (got === r.truth) c.right++;
    else if (r.truth === "write" && got === "read") c.writeAsRead++;
    else if (r.truth === "write") c.writeUnclassified++;
    else if (got === "write") c.readAsWrite++;
    else c.readUnclassified++;
  }
  return { n: rs.length, ...c };
}

describe("Tool-Einordnung nach Namen an echten Servern", () => {
  it("der Datensatz ist vollstaendig (376 Tools, 24 Server, zwei Mengen)", () => {
    expect(rows).toHaveLength(376);
    expect(new Set(rows.map((r) => r.server)).size).toBe(24);
    expect(rows.filter((r) => r.set === "A")).toHaveLength(200);
    expect(rows.filter((r) => r.set === "B")).toHaveLength(176);
  });

  it("Menge A (14 Server): festgenagelt", () => {
    expect(measure("A")).toEqual({ n: 200, right: 140, writeAsRead: 0, writeUnclassified: 25, readAsWrite: 2, readUnclassified: 33 });
  });

  it("Menge B (10 Server): festgenagelt", () => {
    expect(measure("B")).toEqual({ n: 176, right: 119, writeAsRead: 0, writeUnclassified: 9, readAsWrite: 2, readUnclassified: 46 });
  });

  it("kein Write wird stillschweigend als Read eingeordnet (in beiden Mengen)", () => {
    expect(measure("A").writeAsRead + measure("B").writeAsRead).toBe(0);
  });
});
