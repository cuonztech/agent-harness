// Wahrheits-Korpus des Harness (Messbasis, docs/MESSUNG-GENAUIGKEIT.md).
//
// Jeder Fall ist ein kleines Szenario: ein Skript-Agent ruft den ECHTEN Proxy auf,
// dahinter steht ein echter Upstream (corpus-upstream.mjs), der mitschreibt, wie
// viele Datensaetze wirklich entstanden sind. `soll` und `art` stehen VOR der
// Messung fest und haengen nur an der Wirklichkeit des Falls, nicht am Urteil des
// Harness. `art` wird zusaetzlich gegen das Wahrheitsprotokoll des Upstreams
// geprueft (Beschriftungsfehler im Korpus fallen so auf).
//
//   soll   was ein richtiges Werkzeug sagen muesste
//   art    duplikat = es entstanden mehr Datensaetze als gewollt
//          sauber   = nicht mehr als gewollt
//          regel    = Regelverstoss ohne Duplikat (retry_after missachtet)
//   intended  gewollte reale Vorgaenge (Absicht des Agenten, vom Fall festgelegt)
export type Step =
  | { tool: string; args?: Record<string, unknown>; sleepAfterMs?: number }
  | { parallel: Array<{ tool: string; args?: Record<string, unknown> }> };

export interface Case {
  id: string;
  gruppe: string;
  titel: string;
  steps: Step[];
  intended: number;
  soll: "PASS" | "FAIL";
  art: "duplikat" | "sauber" | "regel";
  weil: string;
  /** Szenario (F1..F5) oder keines (Baseline). */
  scenario?: string;
  proxy?: string[];
  env?: Record<string, string>;
  /** Erwartete Einordnung der ersten Operation (Beschriftungs-Genauigkeit). */
  sollLabel?: string;
  /** In der README als Grenze dokumentiert (Abschnitt «Grenzen»). */
  bekannteGrenze?: string;
}

const BASE = { guest: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 };
const w = (args: Record<string, unknown> = BASE, tool = "create_booking"): Step => ({ tool, args });
const r = (guest = "Anna Keller"): Step => ({ tool: "get_booking", args: { guest } });

const F1 = { scenario: "F1" } as const;

function umformung(
  id: string,
  titel: string,
  retry: Record<string, unknown>,
  first: Record<string, unknown> = BASE,
  extra: Partial<Case> = {},
): Case {
  return {
    id,
    gruppe: "B. Umformung beim Wiederholen",
    titel,
    ...F1,
    steps: [w(first), w(retry)],
    intended: 1,
    soll: "FAIL",
    art: "duplikat",
    weil: "Derselbe Vorgang wurde nach dem Timeout nochmals gebucht, nur anders geschrieben: zwei Datensaetze.",
    ...extra,
  };
}

function nachLesen(
  id: string,
  titel: string,
  retry: Record<string, unknown>,
  first: Record<string, unknown> = BASE,
  bekannteGrenze?: string,
): Case {
  return {
    id,
    gruppe: "B2. Umformung nach Nachsehen",
    titel,
    ...F1,
    steps: [w(first), r(), w(retry)],
    intended: 1,
    soll: "FAIL",
    art: "duplikat",
    weil: "Nach dem Timeout nachgesehen (nichts gefunden oder uebersehen), dann derselbe Vorgang anders geschrieben nochmals gebucht: zwei Datensaetze.",
    ...(bekannteGrenze ? { bekannteGrenze } : {}),
  };
}

function ohneFehler(id: string, scenario: string | undefined, titel: string, zweites: Record<string, unknown>): Case {
  return {
    id,
    gruppe: "B3. Doppelt gebucht ohne vorherigen Fehler",
    titel,
    ...(scenario ? { scenario } : {}),
    steps: [w(), w(zweites)],
    intended: 1,
    soll: "FAIL",
    art: "duplikat",
    weil: "Zweimal derselbe Vorgang, beide erfolgreich, das zweite Mal anders geschrieben: zwei Datensaetze.",
  };
}

const PROBE = ["--effect-probe", "list_bookings", "--effect-count", "count"];
const GRUPPE_I = "I. Wirkungs-Sonde (--effect-probe)";

function probeFaelle(): Case[] {
  const gleich = (id: string, titel: string, c: Partial<Case>): Case => ({
    id, gruppe: GRUPPE_I, titel, intended: 1, soll: "PASS", art: "sauber", ...F1, weil: "", steps: [], ...c,
    proxy: [...PROBE, ...(c.proxy ?? [])],
  });
  return [
    gleich("I01", "Wie A06: Retry mit gleichem Key, Upstream dedupliziert per Key", { env: { ACC_DEDUP: "key" }, steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" })], weil: "Ein Datensatz: der Upstream hat das Retry erkannt." }),
    gleich("I02", "Wie A08: identisches Retry, Upstream dedupliziert fachlich", { env: { ACC_DEDUP: "natural" }, steps: [w(), w()], weil: "Ein Datensatz." }),
    gleich("I03", "Wie C04: gleiches request_id, Upstream dedupliziert per request_id", { env: { ACC_DEDUP: "requestid" }, steps: [w({ ...BASE, request_id: "r1" }), w({ ...BASE, request_id: "r1" })], weil: "Ein Datensatz." }),
    gleich("I04", "Wie C05: dasselbe mit --key-fields request_id", { env: { ACC_DEDUP: "requestid" }, proxy: ["--key-fields", "request_id"], steps: [w({ ...BASE, request_id: "r1" }), w({ ...BASE, request_id: "r1" })], weil: "Ein Datensatz." }),
    gleich("I05", "Wie F01: Fehlertext ohne isError, nichts geschrieben, Retry", { scenario: undefined, env: { ACC_FAIL_FIRST: "text" }, steps: [w(), w()], weil: "Der erste Aufruf schrieb nichts: ein Datensatz." }),
    gleich("I06", "Wie F02: isError, nichts geschrieben, Retry", { scenario: undefined, env: { ACC_FAIL_FIRST: "iserror" }, steps: [w(), w()], weil: "Ein Datensatz." }),
    gleich("I07", "Gegenprobe zu A03: blindes Retry gegen einen Upstream ohne Deduplikation", { soll: "FAIL", art: "duplikat", steps: [w(), w()], weil: "Zwei Datensaetze: die Sonde bestaetigt das Duplikat." }),
    gleich("I08", "Gegenprobe zu A07: Retry ohne Key, Upstream dedupliziert nur per Key", { soll: "FAIL", art: "duplikat", env: { ACC_DEDUP: "key" }, steps: [w(), w()], weil: "Ohne Key greift die Deduplikation nicht: zwei Datensaetze." }),
    gleich("I09", "Wie F03: Teilerfolg (geschrieben, dann isError), Retry", { soll: "FAIL", art: "duplikat", scenario: undefined, env: { ACC_FAIL_FIRST: "partial" }, steps: [w(), w()], weil: "Zwei Datensaetze: die Sonde loest den offenen Ausgang auf." }),
    gleich("I10", "Zwei Vorgaenge: A dedupliziert (gleicher Key), B doppelt (ohne Key)", { soll: "FAIL", art: "duplikat", env: { ACC_DEDUP: "key" }, intended: 2, steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, guest: "Max Muster", room: 14 }), w({ ...BASE, guest: "Max Muster", room: 14 })], weil: "Vier Versuche, drei Datensaetze fuer zwei gewollte: B ist doppelt. Die Sonde kann A und B nicht trennen (teilweise), das Urteil bleibt FAIL." }),
    gleich("I13", "Abgelehnter Vorgang (Max) neben einem echten Duplikat (Anna zweimal)", { soll: "FAIL", art: "duplikat", scenario: undefined, env: { ACC_FAIL_FIRST: "iserror" }, steps: [w({ ...BASE, guest: "Max Muster", room: 14 }), w(), w()], intended: 1, weil: "Max wurde abgelehnt (nichts geschrieben), Anna ist doppelt gespeichert. Die Zaehlung geht auf (2 Datensaetze bei 2 Vorgaengen), die Sonde darf das Duplikat nicht wegerklaeren (Befund P1)." }),
    gleich("I18", "Fehlertext ohne isError (Max) neben einem echten Duplikat (Anna zweimal)", { soll: "FAIL", art: "duplikat", scenario: undefined, env: { ACC_FAIL_FIRST: "text" }, steps: [w({ ...BASE, guest: "Max Muster", room: 14 }), w(), w()], intended: 1, weil: "Max bekam «Fehler: …» als Erfolgsantwort (nichts geschrieben), Anna ist doppelt gespeichert. Die Zaehlung geht auf (2 Datensaetze bei 2 Vorgaengen): die Sonde darf das Duplikat nicht wegerklaeren (Befund 1 des kontextfreien Tests von 0.9.0)." }),
    gleich("I19", "F1 (Timeout nach Ausführung), Anna mit Fehlertext ohne isError, Max zweimal, mit Sonde", { soll: "FAIL", art: "duplikat", env: { ACC_FAIL_FIRST: "text" }, steps: [w(), w({ ...BASE, guest: "Max Muster", room: 14 }), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 1, weil: "Annas Aufruf lieferte «Fehler: …» als Erfolgsantwort, der Agent sah einen Timeout (nichts geschrieben); Max ist doppelt gespeichert. Die Sonde zaehlt 2 Datensaetze bei 3 Ausfuehrungen und darf das nicht als «Retry dedupliziert» deuten (Lueckensuche 14.11.: bei F1 fehlte das Merkmal der Fehlerantwort)." }),
    gleich("I14", "Abgelehnter Vorgang (Max) neben einem korrekten Retry (Anna, gleicher Key, Upstream dedupliziert)", { scenario: undefined, env: { ACC_FAIL_FIRST: "iserror", ACC_DEDUP: "key" }, steps: [w({ ...BASE, guest: "Max Muster", room: 14, idempotency_key: "m" }), w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" })], intended: 2, weil: "Max wurde abgelehnt, Anna einmal gespeichert." }),
    gleich("I15", "Duplikat plus update_booking (Write ohne Datensatz), --effect-tools create_booking", { soll: "FAIL", art: "duplikat", proxy: ["--effect-tools", "create_booking"], steps: [w(), w(), w({ guest: "Anna Keller", status: "paid" }, "update_booking")], weil: "Zwei Datensaetze; das Update zaehlt nicht." }),
    gleich("I16", "Retry gegen deduplizierenden Upstream plus update_booking, --effect-tools create_booking", { env: { ACC_DEDUP: "key" }, proxy: ["--effect-tools", "create_booking"], steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" }), w({ guest: "Anna Keller", status: "paid" }, "update_booking")], weil: "Ein Datensatz; das Update zaehlt nicht." }),
    gleich("I17", "Wie I16, aber ohne --effect-tools (zwei Write-Tools: die Sonde wird nicht benutzt)", { env: { ACC_DEDUP: "key" }, steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" }), w({ guest: "Anna Keller", status: "paid" }, "update_booking")], weil: "Ein Datensatz.", bekannteGrenze: "Mehrere Write-Tools: --effect-tools noetig (README, Wirkungs-Sonde)" }),
    gleich("I11", "Baseline ohne Wiederholung (Sonde ohne Wirkung)", { scenario: undefined, steps: [w(), r()], weil: "Ein Datensatz." }),
    gleich("I12", "Zwei verschiedene Buchungen, keine Wiederholung", { scenario: "F4", steps: [w(), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 2, weil: "Zwei gewollte Datensaetze." }),
  ];
}

export const CORPUS: Case[] = [
  // ---------------------------------------------------------------- A
  { id: "A01", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Timeout, nachgesehen, nicht wiederholt", ...F1, steps: [w(), r()], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz, Agent hat nachgesehen.", sollLabel: "VERIFIED_NO_RETRY" },
  { id: "A02", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Timeout, aufgegeben ohne Nachsehen", ...F1, steps: [w()], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz, kein Duplikat (Verifikation fehlt, kein Fehlurteil).", sollLabel: "UNVERIFIED_AFTER_TIMEOUT" },
  { id: "A03", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Blindes Retry, ohne Key", ...F1, steps: [w(), w()], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "A04", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Blindes Retry, gleicher Key, Upstream dedupliziert nicht", ...F1, steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" })], intended: 1, soll: "FAIL", art: "duplikat", weil: "Der Upstream ignoriert den Key: zwei Datensaetze." },
  { id: "A05", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Blindes Retry unter neuem Key", ...F1, steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "b" })], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "A06", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Retry mit gleichem Key gegen einen Upstream, der per Key dedupliziert", ...F1, env: { ACC_DEDUP: "key" }, steps: [w({ ...BASE, idempotency_key: "a" }), w({ ...BASE, idempotency_key: "a" })], intended: 1, soll: "PASS", art: "sauber", weil: "Der Upstream hat das Retry erkannt: ein Datensatz. Das Retry mit Key ist die richtige Antwort auf einen Timeout.", bekannteGrenze: "«Ausführungen, keine Effekte» (README)" },
  { id: "A07", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Retry ohne Key gegen einen Upstream, der per Key dedupliziert", ...F1, env: { ACC_DEDUP: "key" }, steps: [w(), w()], intended: 1, soll: "FAIL", art: "duplikat", weil: "Ohne Key greift die Deduplikation nicht: zwei Datensaetze." },
  { id: "A08", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Retry gegen einen Upstream, der fachlich dedupliziert (Gast, Zimmer, Datum)", ...F1, env: { ACC_DEDUP: "natural" }, steps: [w(), w()], intended: 1, soll: "PASS", art: "sauber", weil: "Der Upstream hat das Duplikat verhindert: ein Datensatz.", bekannteGrenze: "«Ausführungen, keine Effekte» (README)" },
  { id: "A09", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Nachgesehen, dann trotzdem erneut gebucht", ...F1, steps: [w(), r(), w()], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze, trotz Nachsehen." },
  { id: "A10", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Nach dem Timeout bewusst ein anderer Gast", ...F1, steps: [w(), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 2, soll: "PASS", art: "sauber", weil: "Zwei verschiedene, gewollte Buchungen." },

  { id: "A11", gruppe: "A. Wiederholung nach Timeout (F1)", titel: "Nach dem Timeout eine klar andere Buchung (anderer Gast, Zimmer, Datum)", ...F1, steps: [w(), w({ guest: "Max Muster", room: 14, from: "2026-12-01", nights: 5 })], intended: 2, soll: "PASS", art: "sauber", weil: "Zwei verschiedene, gewollte Buchungen." },

  // ---------------------------------------------------------------- B
  umformung("B01", "Datum als 03.11.2026", { ...BASE, from: "03.11.2026" }),
  umformung("B02", "Datum als 20261103", { ...BASE, from: "20261103" }),
  umformung("B03", "Datum als «3. Nov 2026»", { ...BASE, from: "3. Nov 2026" }),
  umformung("B04", "Zahl als String (nights: \"2\")", { ...BASE, nights: "2" }),
  umformung("B05", "Name klein geschrieben", { ...BASE, guest: "anna keller" }),
  umformung("B06", "Zusaetzliches Feld note", { ...BASE, note: "Rueckruf erbeten" }),
  umformung("B07", "Feld umbenannt (guest → guest_name)", { guest_name: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 }),
  umformung("B08", "Name mit zusaetzlichen Leerzeichen", { ...BASE, guest: "  Anna   Keller " }),
  umformung("B09", "Telefon +41 79 123 45 67 → 0041791234567", { ...BASE, phone: "0041791234567" }, { ...BASE, phone: "+41 79 123 45 67" }),
  umformung("B10", "E-Mail gross/klein", { ...BASE, email: "ANNA@Example.CH" }, { ...BASE, email: "anna@example.ch" }),
  umformung("B11", "Betrag 129 → \"129.00\"", { ...BASE, amount: "129.00" }, { ...BASE, amount: 129 }),
  umformung("B12", "Betrag \"1250\" → \"+1250\"", { ...BASE, amount: "+1250" }, { ...BASE, amount: "1250" }),
  umformung("B13", "Name in Unicode-Zerlegung (Zoë, NFD)", { ...BASE, guest: "Zoë Keller" }, { ...BASE, guest: "Zoë Keller" }),
  umformung("B14", "Zwei Felder gleichzeitig anders (Datum und Name)", { ...BASE, from: "03.11.2026", guest: "A. Keller" }),
  {
    id: "B20", gruppe: "B. Umformung beim Wiederholen", titel: "Gegenprobe: anderes Zimmer (bewusst zweite Buchung)", ...F1,
    steps: [w(), w({ ...BASE, room: 13 })], intended: 2, soll: "PASS", art: "sauber",
    weil: "Der Gast will zwei Zimmer: zwei gewollte Datensaetze.",
  },
  {
    id: "B21", gruppe: "B. Umformung beim Wiederholen", titel: "Gegenprobe: anderes Datum (bewusst zweite Buchung)", ...F1,
    steps: [w(), w({ ...BASE, from: "2026-11-04" })], intended: 2, soll: "PASS", art: "sauber",
    weil: "Zwei gewollte Buchungen an verschiedenen Tagen.",
  },

  // Umformung NACH Nachsehen: der Agent hat gelesen (z. B. noch nichts sichtbar) und bucht dann in anderer Schreibweise.
  nachLesen("B30", "Datum als 03.11.2026", { ...BASE, from: "03.11.2026" }),
  nachLesen("B31", "Datum als 20261103", { ...BASE, from: "20261103" }),
  nachLesen("B32", "Name klein geschrieben", { ...BASE, guest: "anna keller" }),
  nachLesen("B33", "Zusaetzliches Feld note", { ...BASE, note: "Rueckruf erbeten" }),
  nachLesen("B34", "Feld umbenannt (guest → guest_name)", { guest_name: "Anna Keller", room: 12, from: "2026-11-03", nights: 2 }),
  nachLesen("B35", "Betrag 129 → \"129.00\"", { ...BASE, amount: "129.00" }, { ...BASE, amount: 129 }),
  nachLesen("B44", "Datum mit Schraegstrichen 03/11/2026 (Tag/Monat mehrdeutig)", { ...BASE, from: "03/11/2026" }),
  nachLesen("B36", "Zahl als String (nights: \"2\")", { ...BASE, nights: "2" }),
  nachLesen("B37", "Name mit zusaetzlichen Leerzeichen", { ...BASE, guest: "  Anna   Keller " }),
  {
    id: "B38", gruppe: "B2. Umformung nach Nachsehen", titel: "Gegenprobe: nachgesehen, dann anderes Zimmer (bewusst zweite Buchung)", ...F1,
    steps: [w(), r(), w({ ...BASE, room: 13 })], intended: 2, soll: "PASS", art: "sauber",
    weil: "Zwei gewollte Datensaetze.",
  },
  {
    id: "B39", gruppe: "B2. Umformung nach Nachsehen", titel: "Gegenprobe: nachgesehen, dann anderes Datum (bewusst zweite Buchung)", ...F1,
    steps: [w(), r(), w({ ...BASE, from: "2026-11-04" })], intended: 2, soll: "PASS", art: "sauber",
    weil: "Zwei gewollte Datensaetze.",
  },
  // Doppelt gebucht OHNE vorherigen Fehler (kein Timeout), zweites Mal anders geschrieben.
  ohneFehler("B40", "F4", "Datum als 03.11.2026", { ...BASE, from: "03.11.2026" }),
  ohneFehler("B41", "F4", "Name klein geschrieben", { ...BASE, guest: "anna keller" }),
  ohneFehler("B42", "F4", "Zusaetzliches Feld note", { ...BASE, note: "Rueckruf erbeten" }),
  ohneFehler("B43", undefined, "Datum als 03.11.2026 (ohne Szenario)", { ...BASE, from: "03.11.2026" }),

  // ---------------------------------------------------------------- C
  { id: "C01", gruppe: "C. Key-Felder", titel: "Retry mit neuem meta.request_id (verschachtelt)", ...F1, steps: [w({ ...BASE, meta: { request_id: "r1" } }), w({ ...BASE, meta: { request_id: "r2" } })], intended: 1, soll: "FAIL", art: "duplikat", weil: "Gleicher Vorgang, nur neue Anfragekennung: zwei Datensaetze.", bekannteGrenze: "Key-Felder nur oberste Ebene (README)" },
  { id: "C02", gruppe: "C. Key-Felder", titel: "Retry mit neuem request_id, ohne --key-fields", ...F1, steps: [w({ ...BASE, request_id: "r1" }), w({ ...BASE, request_id: "r2" })], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "C03", gruppe: "C. Key-Felder", titel: "Wie C02, mit --key-fields request_id", ...F1, proxy: ["--key-fields", "request_id"], steps: [w({ ...BASE, request_id: "r1" }), w({ ...BASE, request_id: "r2" })], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "C04", gruppe: "C. Key-Felder", titel: "Retry mit gleichem request_id, Upstream dedupliziert per request_id", ...F1, env: { ACC_DEDUP: "requestid" }, steps: [w({ ...BASE, request_id: "r1" }), w({ ...BASE, request_id: "r1" })], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz: der Upstream hat das Retry erkannt.", bekannteGrenze: "«Ausführungen, keine Effekte» (README)" },
  { id: "C05", gruppe: "C. Key-Felder", titel: "Wie C04, mit --key-fields request_id", ...F1, env: { ACC_DEDUP: "requestid" }, proxy: ["--key-fields", "request_id"], steps: [w({ ...BASE, request_id: "r1" }), w({ ...BASE, request_id: "r1" })], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz.", bekannteGrenze: "«Ausführungen, keine Effekte» (README)" },

  // ---------------------------------------------------------------- D
  { id: "D01", gruppe: "D. Verifikation (Beschriftung)", titel: "Nach dem Timeout nur ein Read ueber ein anderes Zimmer", ...F1, steps: [w(), { tool: "get_room_availability", args: { room: 99 } }], intended: 1, soll: "PASS", art: "sauber", weil: "Kein Duplikat; das Nachsehen betraf aber einen anderen Datensatz.", sollLabel: "UNVERIFIED_AFTER_TIMEOUT", bekannteGrenze: "«Nachgesehen» = irgendein Read (README)" },
  { id: "D02", gruppe: "D. Verifikation (Beschriftung)", titel: "Nach dem Timeout die Buchung des Gastes gelesen", ...F1, steps: [w(), r()], intended: 1, soll: "PASS", art: "sauber", weil: "Richtig nachgesehen.", sollLabel: "VERIFIED_NO_RETRY" },
  { id: "D03", gruppe: "D. Verifikation (Beschriftung)", titel: "Nach dem Timeout die ganze Liste gelesen", ...F1, steps: [w(), { tool: "list_bookings" }], intended: 1, soll: "PASS", art: "sauber", weil: "Richtig nachgesehen.", sollLabel: "VERIFIED_NO_RETRY" },
  { id: "D04", gruppe: "D. Verifikation (Beschriftung)", titel: "Read nur VOR dem Timeout, danach nichts", ...F1, steps: [r(), w()], intended: 1, soll: "PASS", art: "sauber", weil: "Kein Duplikat; nach dem Timeout nicht nachgesehen.", sollLabel: "UNVERIFIED_AFTER_TIMEOUT" },

  // ---------------------------------------------------------------- E
  { id: "E01", gruppe: "E. Tool-Einordnung", titel: "Write mit Namen check_in_guest, zweimal (F1)", ...F1, env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "check_in_guest", args: { guest: "Anna Keller", room: 12 } }, { tool: "check_in_guest", args: { guest: "Anna Keller", room: 12 } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Der Upstream hat zweimal eingecheckt und abgerechnet.", bekannteGrenze: "Namensmuster irren in beide Richtungen (README)" },
  { id: "E02", gruppe: "E. Tool-Einordnung", titel: "Read mit Namen update_status_view, zweimal (F1)", ...F1, env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "update_status_view" }, { tool: "update_status_view" }], intended: 0, soll: "PASS", art: "sauber", weil: "Reines Lesen, kein Datensatz.", bekannteGrenze: "Namensmuster irren in beide Richtungen (README)" },
  { id: "E03", gruppe: "E. Tool-Einordnung", titel: "Write process_order, zweimal, ohne --write-tools", ...F1, env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "process_order", args: { order_id: "o1" } }, { tool: "process_order", args: { order_id: "o1" } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "E04", gruppe: "E. Tool-Einordnung", titel: "Wie E03, mit --write-tools process_*", ...F1, env: { ACC_TOOLSET: "odd" }, proxy: ["--write-tools", "process_*"], steps: [{ tool: "process_order", args: { order_id: "o1" } }, { tool: "process_order", args: { order_id: "o1" } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "E05", gruppe: "E. Tool-Einordnung", titel: "Write tag_booking, nur durch Annotation erkennbar, zweimal", ...F1, env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "tag_booking", args: { guest: "Anna Keller" } }, { tool: "tag_booking", args: { guest: "Anna Keller" } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "E06", gruppe: "E. Tool-Einordnung", titel: "Write submitOrder (camelCase), zweimal", ...F1, env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "submitOrder", args: { order_id: "o1" } }, { tool: "submitOrder", args: { order_id: "o1" } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "E07", gruppe: "E. Tool-Einordnung", titel: "Write buchung_erstellen (deutscher Name), zweimal, ohne --write-tools", ...F1, env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "buchung_erstellen", args: { guest: "Anna Keller" } }, { tool: "buchung_erstellen", args: { guest: "Anna Keller" } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "E08", gruppe: "E. Tool-Einordnung", titel: "Wie E07, mit --write-tools buchung_*", ...F1, env: { ACC_TOOLSET: "odd" }, proxy: ["--write-tools", "buchung_*"], steps: [{ tool: "buchung_erstellen", args: { guest: "Anna Keller" } }, { tool: "buchung_erstellen", args: { guest: "Anna Keller" } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "E09", gruppe: "E. Tool-Einordnung", titel: "Write check_in_guest, zweimal (F4, keine Injektion)", scenario: "F4", env: { ACC_TOOLSET: "odd" }, steps: [{ tool: "check_in_guest", args: { guest: "Anna Keller", room: 12 } }, { tool: "check_in_guest", args: { guest: "Anna Keller", room: 12 } }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze.", bekannteGrenze: "Namensmuster irren in beide Richtungen (README)" },

  // ---------------------------------------------------------------- F
  { id: "F01", gruppe: "F. Fehlerdarstellung des Upstreams", titel: "Fehlertext ohne isError, nichts geschrieben; derselbe Aufruf nochmals", env: { ACC_FAIL_FIRST: "text" }, steps: [w(), w()], intended: 1, soll: "PASS", art: "sauber", weil: "Der erste Aufruf hat nichts geschrieben, das Retry war richtig: ein Datensatz.", bekannteGrenze: "Fehler nur ueber isError erkennbar (README)" },
  { id: "F02", gruppe: "F. Fehlerdarstellung des Upstreams", titel: "Fehler mit isError, nichts geschrieben; derselbe Aufruf nochmals", env: { ACC_FAIL_FIRST: "iserror" }, steps: [w(), w()], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz.", bekannteGrenze: "Ein Fehlerergebnis beweist nicht, dass nichts geschrieben wurde (README)" },
  { id: "F03", gruppe: "F. Fehlerdarstellung des Upstreams", titel: "Teilerfolg: geschrieben, dann isError; derselbe Aufruf nochmals", env: { ACC_FAIL_FIRST: "partial" }, steps: [w(), w()], intended: 1, soll: "FAIL", art: "duplikat", weil: "Der erste Aufruf hat geschrieben: zwei Datensaetze.", bekannteGrenze: "Ein Fehlerergebnis beweist nicht, dass nichts geschrieben wurde (README)" },
  { id: "F04", gruppe: "F. Fehlerdarstellung des Upstreams", titel: "Fehler mit isError, danach ein anderer Gast", env: { ACC_FAIL_FIRST: "iserror" }, steps: [w(), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 1, soll: "PASS", art: "sauber", weil: "Der erste Aufruf schrieb nichts; ein Datensatz fuer Max." },

  // ---------------------------------------------------------------- G
  { id: "G01", gruppe: "G. Weitere Szenarien", titel: "F4: gleicher Vorgang zweimal nacheinander", scenario: "F4", steps: [w(), w()], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "G02", gruppe: "G. Weitere Szenarien", titel: "F4: gleicher Vorgang zweimal gleichzeitig", scenario: "F4", steps: [{ parallel: [{ tool: "create_booking", args: BASE }, { tool: "create_booking", args: BASE }] }], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "G03", gruppe: "G. Weitere Szenarien", titel: "F4: zwei verschiedene Buchungen", scenario: "F4", steps: [w(), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 2, soll: "PASS", art: "sauber", weil: "Zwei gewollte Buchungen." },
  { id: "G04", gruppe: "G. Weitere Szenarien", titel: "F4: zwei Kaffee, absichtlich identische Bestellungen", scenario: "F4", steps: [w({ customer: "Anna", items: [{ sku: "coffee", qty: 1 }] }, "create_order"), w({ customer: "Anna", items: [{ sku: "coffee", qty: 1 }] }, "create_order")], intended: 2, soll: "PASS", art: "sauber", weil: "Die Kundin wollte zwei Kaffee: zwei gewollte Datensaetze.", bekannteGrenze: "Zwei absichtlich identische Schreibvorgaenge werden als Duplikat gewertet (README)" },
  { id: "G05", gruppe: "G. Weitere Szenarien", titel: "Baseline ohne Szenario: eine Buchung, ein Read", steps: [w(), r()], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz." },
  { id: "G06", gruppe: "G. Weitere Szenarien", titel: "F5: 500, ein Retry", scenario: "F5", steps: [w(), w()], intended: 1, soll: "PASS", art: "sauber", weil: "Der erste Aufruf wurde nicht ausgefuehrt: ein Datensatz." },
  { id: "G07", gruppe: "G. Weitere Szenarien", titel: "F5: 500, dann zwei weitere Versuche", scenario: "F5", steps: [w(), w(), w()], intended: 1, soll: "FAIL", art: "duplikat", weil: "Zwei Datensaetze." },
  { id: "G08", gruppe: "G. Weitere Szenarien", titel: "F5: 500, aufgegeben", scenario: "F5", steps: [w()], intended: 1, soll: "PASS", art: "sauber", weil: "Kein Datensatz, sauberer Abbruch." },
  { id: "G09", gruppe: "G. Weitere Szenarien", titel: "F3: defektes JSON, ein Retry", scenario: "F3", steps: [w(), w()], intended: 1, soll: "PASS", art: "sauber", weil: "Der erste Aufruf wurde nicht ausgefuehrt: ein Datensatz." },
  { id: "G10", gruppe: "G. Weitere Szenarien", titel: "F3: defektes JSON, nachgesehen, aufgegeben", scenario: "F3", steps: [w(), r()], intended: 1, soll: "PASS", art: "sauber", weil: "Kein Datensatz, sauberer Abbruch." },
  { id: "G11", gruppe: "G. Weitere Szenarien", titel: "F2: sofortiges Retry nach 429 (retry_after 1 s)", scenario: "F2", proxy: ["--retry-after", "1"], steps: [w(), w()], intended: 1, soll: "FAIL", art: "regel", weil: "retry_after missachtet." },
  { id: "G12", gruppe: "G. Weitere Szenarien", titel: "F2: Wartezeit eingehalten, dann Retry", scenario: "F2", proxy: ["--retry-after", "1"], steps: [{ ...w(), sleepAfterMs: 1400 }, w()], intended: 1, soll: "PASS", art: "sauber", weil: "Ein Datensatz, Wartezeit eingehalten." },
  { id: "G13", gruppe: "G. Weitere Szenarien", titel: "F2: nach 429 aufgegeben", scenario: "F2", proxy: ["--retry-after", "1"], steps: [w()], intended: 1, soll: "PASS", art: "sauber", weil: "Kein Datensatz, sauberer Abbruch." },

  // ---------------------------------------------------------------- H
  { id: "H01", gruppe: "H. Mehrere Vorgaenge", titel: "Zwei Gaeste, der erste (Timeout) wird blind wiederholt", ...F1, steps: [w(), w({ ...BASE, guest: "Max Muster", room: 14 }), w()], intended: 2, soll: "FAIL", art: "duplikat", weil: "Drei Datensaetze fuer zwei gewollte." },
  { id: "H02", gruppe: "H. Mehrere Vorgaenge", titel: "Zwei Gaeste, nach dem Timeout nachgesehen, dann der zweite", ...F1, steps: [w(), r(), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 2, soll: "PASS", art: "sauber", weil: "Zwei gewollte Datensaetze." },
  { id: "H03", gruppe: "H. Mehrere Vorgaenge", titel: "Zwei Gaeste, der zweite (kein Timeout) wird nochmals gebucht", ...F1, steps: [w(), r(), w({ ...BASE, guest: "Max Muster", room: 14 }), w({ ...BASE, guest: "Max Muster", room: 14 })], intended: 2, soll: "FAIL", art: "duplikat", weil: "Drei Datensaetze fuer zwei gewollte." },
  // ---------------------------------------------------------------- I
  // Mit --effect-probe: der Harness zaehlt Datensaetze statt Ausfuehrungen (Lesetool list_bookings, Feld count).
  ...probeFaelle(),
];
