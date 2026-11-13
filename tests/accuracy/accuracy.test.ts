// Genauigkeits-Messung (docs/MESSUNG-GENAUIGKEIT.md). Fuehrt den Korpus gegen
// den gebauten Proxy aus und prueft zwei Dinge:
//   1. Der Korpus selbst stimmt: Beschriftung (art/intended) passt zur Wahrheit
//      des Upstreams.
//   2. Das Urteil des Harness ist pro Fall auf dem gemessenen Stand festgenagelt
//      (heute.json). Aendert ein Eingriff ein Urteil, schlaegt der Test an und
//      der Unterschied steht im Diff von heute.json: so zeigt sich jede
//      Verbesserung und jede Verschlechterung.
// Neu festnageln: ACC_WRITE=1 npx vitest run tests/accuracy (schreibt heute.json
// und docs/MESSUNG-GENAUIGKEIT.md; das Ergebnis vor dem Commit lesen).
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { CORPUS } from "./corpus.js";
import { runAll, type Messung } from "./runner.js";
import { render } from "./render.js";

const HEUTE = "tests/accuracy/heute.json";
const DOC = "docs/MESSUNG-GENAUIGKEIT.md";

interface Pin {
  verdict: string;
  kategorie: string;
}

describe("Genauigkeits-Korpus gegen den echten Proxy", () => {
  let messungen: Messung[] = [];

  beforeAll(async () => {
    messungen = await runAll(CORPUS);
    if (process.env.ACC_WRITE === "1") {
      const pins: Record<string, Pin> = {};
      for (const m of messungen) pins[m.id] = { verdict: m.verdict, kategorie: m.kategorie };
      writeFileSync(HEUTE, JSON.stringify(pins, null, 2) + "\n");
      writeFileSync(DOC, render(CORPUS, messungen));
    }
    if (process.env.ACC_OUT) writeFileSync(process.env.ACC_OUT, JSON.stringify(messungen, null, 2));
  }, 600_000);

  it("der Korpus hat eindeutige Kennungen", () => {
    const ids = CORPUS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("die Beschriftung des Korpus stimmt mit der Wahrheit des Upstreams ueberein", () => {
    expect(messungen.filter((m) => m.korpusFehler).map((m) => `${m.id}: ${m.korpusFehler}`)).toEqual([]);
  });

  it("jedes Urteil entspricht dem festgenagelten Stand (heute.json)", () => {
    if (process.env.ACC_WRITE === "1") return;
    expect(existsSync(HEUTE), "heute.json fehlt: ACC_WRITE=1 npx vitest run tests/accuracy").toBe(true);
    const pins = JSON.parse(readFileSync(HEUTE, "utf8")) as Record<string, Pin>;
    const abweichungen = messungen
      .filter((m) => pins[m.id]?.verdict !== m.verdict)
      .map((m) => `${m.id}: festgenagelt ${pins[m.id]?.verdict ?? "—"}, gemessen ${m.verdict}`);
    expect(abweichungen).toEqual([]);
  });

  it("das Messdokument entspricht der Messung", () => {
    if (process.env.ACC_WRITE === "1") return;
    expect(readFileSync(DOC, "utf8")).toBe(render(CORPUS, messungen));
  });
});
