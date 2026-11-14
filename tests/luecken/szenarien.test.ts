// Luckensuche, Stufe 2: Szenario-Matrix gegen den echten, gebauten Proxy (dist/index.js).
//   npm run build && LUECKEN=1 npx vitest run tests/luecken/szenarien.test.ts
//   LUECKEN_STEP=7 ...   nur jede 7. Zelle (Probelauf)
// Jede Zelle = Szenario x Upstream-Dedup x Upstream-Fehlerart x Agent-Verhalten x Sonde.
// Die Wahrheit wird NICHT von Hand beschriftet, sondern aus dem Ledger des Upstreams
// (wirkliche Datensaetze) und dem Verhalten des Agenten abgeleitet:
//   FAIL  = derselbe Vorgang (gleiche Signatur: Gast/Kunde) ist mehr als einmal WIRKSAM
//           geschrieben worden (Ledger des Upstreams), ODER (F2) der Vorgang mit der 429
//           wurde vor Ablauf von retry_after erneut gesendet.
//   PASS  = sonst.
// Gemessen wird das Urteil des Harness gegen diese Wahrheit. Schreibt docs/LUECKEN-SZENARIEN.md.
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Case, Step } from "../accuracy/corpus.js";
import { runAll, type Messung } from "../accuracy/runner.js";

type Dedup = "none" | "key" | "requestid" | "natural";
type FailFirst = "none" | "text" | "iserror" | "partial";
type Szenario = "none" | "F1" | "F2" | "F3" | "F4" | "F5";

const BASE = { guest: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 };
const MAX = { guest: "Max Muster", room: 14, from: "2026-11-05", nights: 1 };
const w = (args: Record<string, unknown>, tool = "create_booking"): Step => ({ tool, args });
const lies = (guest = "Anna Keller"): Step => ({ tool: "get_booking", args: { guest } });
const k = (a: Record<string, unknown>, key: string): Record<string, unknown> => ({ ...a, idempotency_key: key });
const rid = (a: Record<string, unknown>, key: string): Record<string, unknown> => ({ ...a, request_id: key });

interface Verhalten {
  id: string;
  titel: string;
  steps: (dedup: Dedup) => Step[];
  intended: number;
  /** Der ERSTE Vorgang (derjenige, den F1..F5 trifft) wird sofort erneut gesendet: unter F2 ein Regelverstoss. */
  sofortWiederholt: boolean;
}

// Der Schluessel haengt vom Upstream ab (idempotency_key fuer "key", request_id fuer "requestid").
const mitKey = (dedup: Dedup, a: Record<string, unknown>, key: string): Record<string, unknown> =>
  dedup === "requestid" ? rid(a, key) : k(a, key);

const VERHALTEN: Verhalten[] = [
  { id: "V01", titel: "ein Aufruf, aufgegeben", steps: (d) => [w(mitKey(d, BASE, "a"))], intended: 1, sofortWiederholt: false },
  { id: "V02", titel: "blindes Retry, gleiche Args, gleicher Key", steps: (d) => [w(mitKey(d, BASE, "a")), w(mitKey(d, BASE, "a"))], intended: 1, sofortWiederholt: true },
  { id: "V03", titel: "blindes Retry unter neuem Key", steps: (d) => [w(mitKey(d, BASE, "a")), w(mitKey(d, BASE, "b"))], intended: 1, sofortWiederholt: true },
  { id: "V04", titel: "blindes Retry ohne Key", steps: () => [w(BASE), w(BASE)], intended: 1, sofortWiederholt: true },
  { id: "V05", titel: "Retry umgeschrieben (Name klein, Datum anders)", steps: () => [w(BASE), w({ ...BASE, guest: "anna keller", from: "03.11.2026" })], intended: 1, sofortWiederholt: true },
  { id: "V06", titel: "nachgesehen, nicht wiederholt", steps: (d) => [w(mitKey(d, BASE, "a")), lies()], intended: 1, sofortWiederholt: false },
  { id: "V07", titel: "nachgesehen, dann doch wiederholt", steps: (d) => [w(mitKey(d, BASE, "a")), lies(), w(mitKey(d, BASE, "a"))], intended: 1, sofortWiederholt: true },
  { id: "V08", titel: "zwei Gäste, keine Wiederholung", steps: (d) => [w(mitKey(d, BASE, "a")), w(mitKey(d, MAX, "m"))], intended: 2, sofortWiederholt: false },
  { id: "V09", titel: "zwei Gäste, der erste wird wiederholt", steps: () => [w(BASE), w(MAX), w(BASE)], intended: 2, sofortWiederholt: true },
  { id: "V10", titel: "zwei Gäste, der zweite wird wiederholt", steps: () => [w(BASE), w(MAX), w(MAX)], intended: 2, sofortWiederholt: false },
  { id: "V11", titel: "gleichzeitig, gleiche Args", steps: () => [{ parallel: [{ tool: "create_booking", args: BASE }, { tool: "create_booking", args: BASE }] }], intended: 1, sofortWiederholt: true },
  { id: "V12", titel: "Wartezeit eingehalten, dann Retry", steps: (d) => [{ ...w(mitKey(d, BASE, "a")), sleepAfterMs: 1400 }, w(mitKey(d, BASE, "a"))], intended: 1, sofortWiederholt: false },
  { id: "V13", titel: "drei Versuche", steps: () => [w(BASE), w(BASE), w(BASE)], intended: 1, sofortWiederholt: true },
  { id: "V14", titel: "Read über anderen Gast, dann Retry", steps: () => [w(BASE), lies("Max Muster"), w(BASE)], intended: 1, sofortWiederholt: true },
  { id: "V15", titel: "Write, dann update_booking (kein neuer Datensatz)", steps: () => [w(BASE), { tool: "update_booking", args: { guest: "Anna Keller", status: "paid" } }], intended: 1, sofortWiederholt: false },
  { id: "V16", titel: "anderes Write-Tool (create_order), Retry", steps: () => [w({ customer: "Anna", items: [{ sku: "coffee", qty: 1 }] }, "create_order"), w({ customer: "Anna", items: [{ sku: "coffee", qty: 1 }] }, "create_order")], intended: 1, sofortWiederholt: true },
];

const PROBE = ["--effect-probe", "list_bookings", "--effect-count", "count"];

interface Zelle {
  szenario: Szenario;
  dedup: Dedup;
  failFirst: FailFirst;
  verhalten: Verhalten;
  probe: boolean;
  case: Case;
  /** Regelverstoss (F2, sofort wiederholt): FAIL auch ohne Duplikat. */
  regel: boolean;
}

function zellen(): Zelle[] {
  const out: Zelle[] = [];
  const szenarien: Szenario[] = ["none", "F1", "F2", "F3", "F4", "F5"];
  const dedups: Dedup[] = ["none", "key", "requestid", "natural"];
  const fails: FailFirst[] = ["none", "text", "iserror", "partial"];
  for (const szenario of szenarien)
    for (const dedup of dedups)
      for (const failFirst of fails)
        for (const verhalten of VERHALTEN)
          for (const probe of [false, true]) {
            const id = `${szenario}-${dedup}-${failFirst}-${verhalten.id}-${probe ? "P" : "o"}`;
            const regel = szenario === "F2" && verhalten.sofortWiederholt;
            out.push({
              szenario, dedup, failFirst, verhalten, probe, regel,
              case: {
                id,
                gruppe: "Lückensuche",
                titel: verhalten.titel,
                steps: verhalten.steps(dedup),
                intended: verhalten.intended,
                soll: "PASS",
                art: "sauber",
                weil: "",
                ...(szenario !== "none" ? { scenario: szenario } : {}),
                proxy: [...(szenario === "F2" ? ["--retry-after", "1"] : []), ...(probe ? PROBE : [])],
                env: { ACC_DEDUP: dedup, ACC_FAIL_FIRST: failFirst },
              },
            });
          }
  return out;
}

type Befund = "richtig" | "falsch-pass" | "falsch-fail" | "unentschieden";

function urteile(z: Zelle, m: Messung): { soll: "PASS" | "FAIL"; befund: Befund } {
  const proSignatur = new Map<string, number>();
  for (const e of m.ledger) if (e.effective) proSignatur.set(`${e.tool}|${e.sig}`, (proSignatur.get(`${e.tool}|${e.sig}`) ?? 0) + 1);
  const duplikat = [...proSignatur.values()].some((n) => n > 1);
  const soll = z.regel || duplikat ? "FAIL" : "PASS";
  if (m.verdict === soll) return { soll, befund: "richtig" };
  if (m.verdict === "NOT_TESTED") return { soll, befund: "unentschieden" };
  return { soll, befund: soll === "FAIL" ? "falsch-pass" : "falsch-fail" };
}

describe.skipIf(!process.env.LUECKEN)("Lückensuche Stufe 2: Szenario-Matrix", () => {
  it("misst und schreibt den Bericht", async () => {
    const step = Number(process.env.LUECKEN_STEP ?? 1);
    const alle = zellen().filter((_, i) => i % step === 0);
    const t0 = Date.now();
    const ms = await runAll(alle.map((z) => z.case), Number(process.env.LUECKEN_PAR ?? 8));
    const sek = Math.round((Date.now() - t0) / 1000);

    const rows = alle.map((z, i) => ({ z, m: ms[i], ...urteile(z, ms[i]) }));
    const zaehl = (xs: typeof rows) => ({
      n: xs.length,
      richtig: xs.filter((r) => r.befund === "richtig").length,
      fp: xs.filter((r) => r.befund === "falsch-pass").length,
      ff: xs.filter((r) => r.befund === "falsch-fail").length,
      nt: xs.filter((r) => r.befund === "unentschieden").length,
    });
    const tab = (titel: string, key: (r: (typeof rows)[number]) => string): string => {
      const g = new Map<string, typeof rows>();
      for (const r of rows) g.set(key(r), [...(g.get(key(r)) ?? []), r]);
      const zeilen = [...g.entries()].map(([kk, xs]) => {
        const c = zaehl(xs);
        return `| ${kk} | ${c.n} | ${c.richtig} | ${c.fp ? `**${c.fp}**` : 0} | ${c.ff ? `**${c.ff}**` : 0} | ${c.nt} |`;
      });
      return `### ${titel}\n\n| | Zellen | richtig | **Falsch-PASS** | Falsch-FAIL | NOT_TESTED |\n|---|---:|---:|---:|---:|---:|\n${zeilen.join("\n")}\n`;
    };

    const gesamt = zaehl(rows);
    const teile: string[] = [
      `# Lückensuche, Stufe 2: Szenario-Matrix\n\n_Erzeugt von \`tests/luecken/szenarien.test.ts\` (\`LUECKEN=1\`). Nicht von Hand ändern._\n`,
      `${gesamt.n} Zellen (${sek} s), jede gegen den echten Proxy. Wahrheit = Ledger des Upstreams (Datensätze > gewollt) bzw. Regelverstoss bei F2. **Falsch-PASS** = der Harness sagt PASS, obwohl ein Duplikat/Regelverstoss entstand (gefährlich). **Falsch-FAIL** = FAIL ohne Duplikat. **NOT_TESTED** = keine Aussage trotz klarer Wahrheit.\n\nGesamt: richtig ${gesamt.richtig}, **Falsch-PASS ${gesamt.fp}**, Falsch-FAIL ${gesamt.ff}, NOT_TESTED ${gesamt.nt}.\n`,
      tab("Nach Szenario", (r) => r.z.szenario),
      tab("Nach Upstream-Dedup", (r) => r.z.dedup),
      tab("Nach Upstream-Fehlerart (erster Aufruf)", (r) => r.z.failFirst),
      tab("Nach Sonde", (r) => (r.z.probe ? "mit --effect-probe" : "ohne Sonde")),
      tab("Nach Agent-Verhalten", (r) => `${r.z.verhalten.id} ${r.z.verhalten.titel}`),
    ];

    const abw = rows.filter((r) => r.befund !== "richtig");
    // Zusammenfassung: gleiche (Befund, Verhalten, Szenario) bündeln, andere Achsen auflisten.
    const cluster = new Map<string, typeof rows>();
    for (const r of abw) {
      const kk = `${r.befund} | ${r.z.verhalten.id} ${r.z.verhalten.titel} | ${r.z.szenario}`;
      cluster.set(kk, [...(cluster.get(kk) ?? []), r]);
    }
    const achsen = (xs: typeof rows): string => {
      const s = (f: (r: (typeof rows)[number]) => string) => [...new Set(xs.map(f))].sort().join("/");
      return `dedup ${s((r) => r.z.dedup)}; fehler ${s((r) => r.z.failFirst)}; ${s((r) => (r.z.probe ? "Sonde" : "ohne Sonde"))}`;
    };
    for (const befund of ["falsch-pass", "falsch-fail", "unentschieden"] as Befund[]) {
      const eintraege = [...cluster.entries()].filter(([kk]) => kk.startsWith(befund)).sort((a, b) => b[1].length - a[1].length);
      teile.push(
        `### Abweichungen: ${befund} (${eintraege.reduce((n, [, x]) => n + x.length, 0)} Zellen in ${eintraege.length} Gruppen)\n\n${eintraege.length === 0 ? "Keine." : eintraege.map(([kk, xs]) => `- **${kk.split(" | ").slice(1).join(" · ")}** — ${xs.length}× (${achsen(xs)}). Beispiel \`${xs[0].z.case.id}\`: Urteil ${xs[0].m.verdict}, Wahrheit ${xs[0].soll}, Datensätze ${xs[0].m.effekte}/${xs[0].z.verhalten.intended}, Ausführungen laut Harness ${xs[0].m.ausfuehrungen}, Operationen ${xs[0].m.operationen.join(", ") || "—"}`).join("\n")}\n`,
      );
    }

    writeFileSync("docs/LUECKEN-SZENARIEN.md", teile.join("\n"));
    writeFileSync(process.env.LUECKEN_JSON ?? join(tmpdir(), "luecken-szenarien.json"), JSON.stringify(rows.map((r) => ({ id: r.z.case.id, befund: r.befund, soll: r.soll, verdict: r.m.verdict, effekte: r.m.effekte, intended: r.z.verhalten.intended, ausfuehrungen: r.m.ausfuehrungen, operationen: r.m.operationen, beobachtungen: r.m.beobachtungen })), null, 1));
    expect(rows.length).toBeGreaterThan(0);
  }, 3_600_000);
});
