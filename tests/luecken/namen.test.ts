// Luckensuche, Stufe 1: Namensmatrix. Nur mit LUECKEN=1 (sonst uebersprungen: Messung, kein Test).
//   LUECKEN=1 npx vitest run tests/luecken/namen.test.ts
// Schreibt docs/LUECKEN-NAMEN.md. Die Zahlen sind NICHT festgenagelt: die Reihe soll Luecken
// zeigen, nicht das Bestehende bestaetigen. Ausnahme: ein stilles Write-als-Read in der Matrix
// ist ein Befund und macht den Lauf rot, sobald es nicht in LUECKEN-BEKANNT steht.
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "../../src/proxy/interceptor.js";
import { matrix, FALLEN, type NameFall, type Wahrheit } from "./namen-gen.js";

const cfg = { writeToolPatterns: [] as string[], readToolPatterns: [] as string[] };
type Ergebnis = "richtig" | "write-als-read" | "write-offen" | "read-als-write" | "read-offen";

interface Messung extends NameFall {
  ergebnis: Ergebnis;
  quelle: string;
  hinweis: boolean;
}

function messe(f: NameFall): Messung {
  const tool: Tool = { name: f.name, description: f.beschreibung, inputSchema: { type: "object", properties: {} } };
  const r = classifyUpstreamTool(tool, cfg);
  const got = r.class;
  let ergebnis: Ergebnis;
  if (got === f.wahrheit) ergebnis = "richtig";
  else if (f.wahrheit === "write") ergebnis = got === "read" ? "write-als-read" : "write-offen";
  else ergebnis = got === "write" ? "read-als-write" : "read-offen";
  return { ...f, ergebnis, quelle: r.source, hinweis: Boolean(r.doubt) };
}

const pct = (n: number, d: number): string => (d === 0 ? "—" : `${((100 * n) / d).toFixed(0)} %`);

function zaehle(ms: Messung[]) {
  const c: Record<Ergebnis, number> = { richtig: 0, "write-als-read": 0, "write-offen": 0, "read-als-write": 0, "read-offen": 0 };
  for (const m of ms) c[m.ergebnis]++;
  return { n: ms.length, ...c };
}

function tabelle(titel: string, gruppen: Map<string, Messung[]>): string {
  const zeilen = [...gruppen.entries()].map(([k, ms]) => {
    const c = zaehle(ms);
    const offen = c["write-offen"] + c["read-offen"];
    const falsch = c["write-als-read"] + c["read-als-write"];
    return `| ${k} | ${c.n} | ${pct(c.richtig, c.n)} | ${pct(offen, c.n)} | ${falsch === 0 ? "0" : `**${falsch}**`} | ${c["write-als-read"] === 0 ? "0" : `**${c["write-als-read"]}**`} |`;
  });
  return `### ${titel}\n\n| | Fälle | richtig | nicht eingeordnet | falsch eingeordnet | davon Write als Read |\n|---|---:|---:|---:|---:|---:|\n${zeilen.join("\n")}\n`;
}

function gruppiere<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) m.set(key(x), [...(m.get(key(x)) ?? []), x]);
  return m;
}

const beschrArt = (f: NameFall): string => {
  if (f.beschreibung === undefined) return "ohne Beschreibung";
  return /^Tool fuer/.test(f.beschreibung) ? "neutrale Beschreibung" : "passende Beschreibung";
};

describe.skipIf(!process.env.LUECKEN)("Lückensuche Stufe 1: Namensmatrix", () => {
  const faelle = matrix();
  const ms = faelle.map(messe);

  // Fallen mit und ohne Beschreibung
  const fallen = FALLEN.flatMap((f) => [
    messe({ name: f.name, wahrheit: f.wahrheit, sprache: "en", verb: "", objekt: "", stil: "falle", gruppe: "falle", beschreibung: f.beschreibung }),
    messe({ name: f.name, wahrheit: f.wahrheit, sprache: "en", verb: "", objekt: "", stil: "falle (nur Name)", gruppe: "falle" }),
  ]);

  it("misst und schreibt den Bericht", () => {
    const nurName = ms.filter((m) => m.beschreibung === undefined);
    const stillW = ms.filter((m) => m.ergebnis === "write-als-read");
    const stillFallen = fallen.filter((m) => m.ergebnis === "write-als-read");

    const teile: string[] = [];
    teile.push(`# Lückensuche, Stufe 1: Namensmatrix\n\n_Erzeugt von \`tests/luecken/namen.test.ts\` (\`LUECKEN=1\`). Nicht von Hand ändern._\n`);
    teile.push(
      `${ms.length} Namen aus Verb × Objekt × Schreibweise × Beschreibung (EN/DE/FR/ES, ${new Set(ms.map((m) => m.stil)).size} Stile) und ${FALLEN.length} handbeschriftete Fallen (je mit und ohne Beschreibung). Die Wahrheit steht durch die Konstruktion fest, nicht durch die Wortliste des Harness. **Gefährlich ist nur «Write als Read»** (ein Schreib-Tool gilt still als Lese-Tool: Duplikate bleiben unsichtbar). «Nicht eingeordnet» ist sicher (der Harness warnt), aber ohne Wirkung.\n`,
    );
    teile.push(tabelle("Gesamt nach Beschreibung", gruppiere(ms, (m) => `${m.wahrheit === "write" ? "Write" : "Read"}, ${beschrArt(m)}`)));
    teile.push(tabelle("Nur Name, nach Sprache", gruppiere(nurName, (m) => `${m.wahrheit === "write" ? "Write" : "Read"}, ${m.sprache}`)));
    teile.push(tabelle("Nur Name, nach Schreibweise (Write)", gruppiere(nurName.filter((m) => m.wahrheit === "write"), (m) => m.stil)));
    teile.push(tabelle("Nur Name, nach Schreibweise (Read)", gruppiere(nurName.filter((m) => m.wahrheit === "read"), (m) => m.stil)));
    teile.push(tabelle("Fallen (Wort und Wirkung laufen auseinander)", gruppiere(fallen, (m) => `${m.wahrheit === "write" ? "Write" : "Read"} · ${m.stil}`)));

    teile.push(`### Stilles «Write als Read»: Matrix\n\n${stillW.length === 0 ? "Keines." : `${stillW.length} Fälle. Nach Quelle:\n\n${[...gruppiere(stillW, (m) => m.quelle).entries()].map(([q, x]) => `- \`${q}\`: ${x.length} (z. B. ${[...new Set(x.map((m) => m.name))].slice(0, 6).map((n) => `\`${n}\``).join(", ")})`).join("\n")}\n`}`);
    teile.push(`### Stilles «Write als Read»: Fallen\n\n${stillFallen.length === 0 ? "Keines." : stillFallen.map((m) => `- \`${m.name}\` (${m.stil}), Quelle \`${m.quelle}\``).join("\n")}\n`);

    // Welche Verben bleiben ohne Einordnung (Write, nur Name): die Wortlisten-Lücken.
    const offeneVerben = gruppiere(nurName.filter((m) => m.wahrheit === "write" && m.ergebnis === "write-offen"), (m) => `${m.sprache}:${m.verb}`);
    const haeufig = [...offeneVerben.entries()].sort((a, b) => b[1].length - a[1].length);
    const ganzOffen = haeufig.filter(([, x]) => x.length >= STILE_MIN);
    teile.push(
      `### Schreib-Verben, die in mindestens ${STILE_MIN} Schreibweisen ohne Einordnung bleiben (Wortlisten-Lücken)\n\n${ganzOffen.length === 0 ? "Keine." : ganzOffen.map(([v, x]) => `\`${v}\` (${x.length})`).join(", ")}\n`,
    );
    const offeneReads = gruppiere(nurName.filter((m) => m.wahrheit === "read" && m.ergebnis === "read-offen"), (m) => `${m.sprache}:${m.verb}`);
    const ganzOffenR = [...offeneReads.entries()].sort((a, b) => b[1].length - a[1].length).filter(([, x]) => x.length >= STILE_MIN);
    teile.push(`### Lese-Verben ohne Einordnung (nur Lärm: das Tool löst nichts aus, wird aber nicht bewertet)\n\n${ganzOffenR.map(([v, x]) => `\`${v}\` (${x.length})`).join(", ") || "Keine."}\n`);

    const roh = (w: Wahrheit, e: Ergebnis) => fallen.filter((m) => m.wahrheit === w && m.ergebnis === e && m.stil === "falle");
    teile.push(
      `### Fallen einzeln (mit Beschreibung → nur Name)\n\n| Name | Wahrheit | mit Beschreibung | nur Name |\n|---|---|---|---|\n${FALLEN.map((f) => {
        const a = fallen.find((m) => m.name === f.name && m.stil === "falle")!;
        const b = fallen.find((m) => m.name === f.name && m.stil === "falle (nur Name)")!;
        return `| \`${f.name}\` | ${f.wahrheit} | ${a.ergebnis}${a.hinweis ? " (+Hinweis)" : ""} | ${b.ergebnis}${b.hinweis ? " (+Hinweis)" : ""} |`;
      }).join("\n")}\n`,
    );
    void roh;
    writeFileSync("docs/LUECKEN-NAMEN.md", teile.join("\n"));
    expect(ms.length).toBeGreaterThan(1000);
  });

  it("kein stilles Write-als-Read in der Matrix, das nicht als bekannt geführt ist", () => {
    const unbekannt = ms.filter((m) => m.ergebnis === "write-als-read").map((m) => `${m.name} [${m.quelle}]`);
    expect([...new Set(unbekannt)]).toEqual([]);
  });
});

const STILE_MIN = 8;
