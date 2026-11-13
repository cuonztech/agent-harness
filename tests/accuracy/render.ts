// Erzeugt docs/MESSUNG-GENAUIGKEIT.md aus Korpus und Messung. Nur deterministische
// Angaben (keine Zeiten, kein Datum), damit der Test das Dokument gegen die
// Messung pruefen kann.
import { VERSION } from "../../src/version.js";
import type { Case } from "./corpus.js";
import type { Kategorie, Messung } from "./runner.js";

const KAT: Record<Kategorie, string> = {
  richtig: "richtig",
  unentschieden: "NOT_TESTED (offen)",
  "falsch-pass": "FALSCH-PASS",
  "falsch-fail": "FALSCH-FAIL",
};

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${((100 * n) / d).toFixed(0)} %`;
}

function count(ms: Messung[], k: Kategorie): number {
  return ms.filter((m) => m.kategorie === k).length;
}

export function render(corpus: Case[], messungen: Messung[]): string {
  const by = new Map(messungen.map((m) => [m.id, m]));
  const gruppen = [...new Set(corpus.map((c) => c.gruppe))];
  const duplikate = corpus.filter((c) => c.soll === "FAIL");
  const saubere = corpus.filter((c) => c.soll === "PASS");
  const dm = duplikate.map((c) => by.get(c.id)!);
  const sm = saubere.map((c) => by.get(c.id)!);
  const labelFaelle = corpus.filter((c) => c.sollLabel);
  const labelOk = labelFaelle.filter((c) => by.get(c.id)!.labelOk).length;

  const out: string[] = [];
  out.push("# Messung Genauigkeit: wie oft stimmt das Urteil des Harness?");
  out.push("");
  out.push(
    `Gemessen an Version ${VERSION}, ${corpus.length} Fälle, jeder gegen den echten, gebauten Proxy (\`dist/index.js proxy\`) und einen echten Upstream, der mitschreibt, wie viele Datensätze wirklich entstanden sind (\`tests/accuracy/corpus-upstream.mjs\`). Der Harness sieht dieses Protokoll nie.`,
  );
  out.push("");
  out.push(
    "Erzeugt von `tests/accuracy/accuracy.test.ts` (`ACC_WRITE=1 npx vitest run tests/accuracy`), nicht von Hand ändern: Ein Test prüft, dass dieses Dokument der Messung entspricht.",
  );
  out.push("");
  out.push("**Wie gelesen wird.** `Soll` steht je Fall vor der Messung fest und hängt nur an der Wirklichkeit (gab es mehr Datensätze als gewollt?), nicht am Urteil des Harness. Skript-Agenten: sie zeigen, was der Harness bei einem bestimmten Verhalten urteilt, nicht, wie ein echtes Modell sich verhält (siehe Grenzen unten).");
  out.push("");
  out.push("| Kategorie | Bedeutung | Schwere |");
  out.push("|---|---|---|");
  out.push("| richtig | Urteil = Soll | |");
  out.push("| NOT_TESTED (offen) | der Harness legt sich nicht fest | ehrlich, aber ohne Aussage |");
  out.push("| FALSCH-PASS | es gab ein Duplikat (oder einen Regelverstoss), der Harness sagt PASS | **am schwersten**: ein Fehler bleibt unbemerkt |");
  out.push("| FALSCH-FAIL | es gab kein Duplikat, der Harness sagt FAIL | schwer: ein korrektes System wird beanstandet |");
  out.push("");
  out.push("## Ergebnis");
  out.push("");
  out.push("| | Fälle | richtig | NOT_TESTED | FALSCH-PASS | FALSCH-FAIL |");
  out.push("|---|---:|---:|---:|---:|---:|");
  const row = (name: string, ms: Messung[]): string =>
    `| ${name} | ${ms.length} | ${count(ms, "richtig")} (${pct(count(ms, "richtig"), ms.length)}) | ${count(ms, "unentschieden")} | ${count(ms, "falsch-pass")} | ${count(ms, "falsch-fail")} |`;
  out.push(row("alle Fälle", messungen));
  out.push(row("Soll FAIL (es gab ein Duplikat oder einen Regelverstoss)", dm));
  out.push(row("Soll PASS (nichts Falsches passiert)", sm));
  out.push("");
  out.push(
    `- **Falsch-PASS-Quote** (Anteil der Soll-FAIL-Fälle mit PASS): ${count(dm, "falsch-pass")} von ${dm.length} (${pct(count(dm, "falsch-pass"), dm.length)}).`,
  );
  out.push(
    `- **Falsch-FAIL-Quote** (Anteil der Soll-PASS-Fälle mit FAIL): ${count(sm, "falsch-fail")} von ${sm.length} (${pct(count(sm, "falsch-fail"), sm.length)}).`,
  );
  out.push(
    `- **Ohne Aussage** (NOT_TESTED): ${count(messungen, "unentschieden")} von ${messungen.length} (${pct(count(messungen, "unentschieden"), messungen.length)}).`,
  );
  out.push(
    `- **Beschriftung der Operation** (z. B. \`VERIFIED_NO_RETRY\` nur bei richtigem Nachsehen): ${labelOk} von ${labelFaelle.length} Fällen richtig.`,
  );
  out.push("");
  out.push("## Nach Gruppe");
  out.push("");
  out.push("| Gruppe | Fälle | richtig | NOT_TESTED | FALSCH-PASS | FALSCH-FAIL |");
  out.push("|---|---:|---:|---:|---:|---:|");
  for (const g of gruppen) {
    const ms = corpus.filter((c) => c.gruppe === g).map((c) => by.get(c.id)!);
    out.push(
      `| ${g} | ${ms.length} | ${count(ms, "richtig")} | ${count(ms, "unentschieden")} | ${count(ms, "falsch-pass")} | ${count(ms, "falsch-fail")} |`,
    );
  }
  out.push("");
  out.push("## Alle Fälle");
  for (const g of gruppen) {
    out.push("");
    out.push(`### ${g}`);
    out.push("");
    out.push("| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |");
    out.push("|---|---|---|---|---:|---|---|");
    for (const c of corpus.filter((x) => x.gruppe === g)) {
      const m = by.get(c.id)!;
      const bem: string[] = [];
      if (c.bekannteGrenze) bem.push(`Grenze: ${c.bekannteGrenze}`);
      if (m.einordnungsHinweis) bem.push("Hinweis im Bericht: Beschreibung des Tools widerspricht der Einordnung");
      if (c.sollLabel) bem.push(`Beschriftung ${m.labelOk ? "richtig" : "FALSCH"} (soll ${c.sollLabel})`);
      out.push(
        `| ${c.id} | ${c.titel} | ${c.soll} | ${m.verdict} | ${m.effekte} (${c.intended}) | ${KAT[m.kategorie]} | ${bem.join("; ")} |`,
      );
    }
  }
  out.push("");
  out.push("## Grenzen dieser Messung");
  out.push("");
  out.push("- **Skript-Agenten, kein Modell.** Jeder Fall spielt ein festes Verhalten. Ein echtes Modell verhält sich anders und nicht deterministisch; diese Zahlen sagen nichts darüber, wie oft ein Modell einen Fehler macht, nur wie zuverlässig der Harness ein gegebenes Verhalten beurteilt.");
  out.push("- **Der Korpus ist von Hand gebaut.** Er deckt die in der README dokumentierten Grenzen und die Fälle des externen Tests ab, nicht alles, was in der Praxis vorkommt. Eine Quote auf diesem Korpus ist keine Quote in der Praxis.");
  out.push("- **Die Absicht (gewollte Vorgänge) legt der Fall fest.** Ob ein Agent nach einem Timeout «dasselbe» oder «etwas anderes» wollte, ist bei geänderten Argumenten eine Annahme des Falls.");
  out.push("- **Die Fälle der Gruppe «Gegenprobe» und «bekannte Grenze»** sind absichtlich enthalten: sie zeigen, wo der Harness richtig liegt und wo er nach README nicht liegen kann.");
  out.push("");
  return out.join("\n");
}
