# Messung Genauigkeit: wie oft stimmt das Urteil des Harness?

Gemessen an Version 0.10.0, 98 Fälle, jeder gegen den echten, gebauten Proxy (`dist/index.js proxy`) und einen echten Upstream, der mitschreibt, wie viele Datensätze wirklich entstanden sind (`tests/accuracy/corpus-upstream.mjs`). Der Harness sieht dieses Protokoll nie.

Erzeugt von `tests/accuracy/accuracy.test.ts` (`ACC_WRITE=1 npx vitest run tests/accuracy`), nicht von Hand ändern: Ein Test prüft, dass dieses Dokument der Messung entspricht.

**Wie gelesen wird.** `Soll` steht je Fall vor der Messung fest und hängt nur an der Wirklichkeit (gab es mehr Datensätze als gewollt?), nicht am Urteil des Harness. Skript-Agenten: sie zeigen, was der Harness bei einem bestimmten Verhalten urteilt, nicht, wie ein echtes Modell sich verhält (siehe Grenzen unten).

| Kategorie | Bedeutung | Schwere |
|---|---|---|
| richtig | Urteil = Soll | |
| NOT_TESTED (offen) | der Harness legt sich nicht fest | ehrlich, aber ohne Aussage |
| FALSCH-PASS | es gab ein Duplikat (oder einen Regelverstoss), der Harness sagt PASS | **am schwersten**: ein Fehler bleibt unbemerkt |
| FALSCH-FAIL | es gab kein Duplikat, der Harness sagt FAIL | schwer: ein korrektes System wird beanstandet |

## Ergebnis

| | Fälle | richtig | NOT_TESTED | FALSCH-PASS | FALSCH-FAIL |
|---|---:|---:|---:|---:|---:|
| alle Fälle | 98 | 51 (52 %) | 39 | 0 | 8 |
| Soll FAIL (es gab ein Duplikat oder einen Regelverstoss) | 57 | 23 (40 %) | 34 | 0 | 0 |
| Soll PASS (nichts Falsches passiert) | 41 | 28 (68 %) | 5 | 0 | 8 |

- **Falsch-PASS-Quote** (Anteil der Soll-FAIL-Fälle mit PASS): 0 von 57 (0 %).
- **Falsch-FAIL-Quote** (Anteil der Soll-PASS-Fälle mit FAIL): 8 von 41 (20 %).
- **Ohne Aussage** (NOT_TESTED): 39 von 98 (40 %).
- **Beschriftung der Operation** (z. B. `VERIFIED_NO_RETRY` nur bei richtigem Nachsehen): 6 von 6 Fällen richtig.

## Nach Gruppe

| Gruppe | Fälle | richtig | NOT_TESTED | FALSCH-PASS | FALSCH-FAIL |
|---|---:|---:|---:|---:|---:|
| A. Wiederholung nach Timeout (F1) | 11 | 7 | 2 | 0 | 2 |
| B. Umformung beim Wiederholen | 16 | 0 | 16 | 0 | 0 |
| B2. Umformung nach Nachsehen | 11 | 2 | 9 | 0 | 0 |
| B3. Doppelt gebucht ohne vorherigen Fehler | 4 | 0 | 4 | 0 | 0 |
| C. Key-Felder | 5 | 1 | 2 | 0 | 2 |
| D. Verifikation (Beschriftung) | 4 | 4 | 0 | 0 | 0 |
| E. Tool-Einordnung | 9 | 4 | 4 | 0 | 1 |
| F. Fehlerdarstellung des Upstreams | 4 | 1 | 2 | 0 | 1 |
| G. Weitere Szenarien | 13 | 12 | 0 | 0 | 1 |
| H. Mehrere Vorgaenge | 3 | 3 | 0 | 0 | 0 |
| I. Wirkungs-Sonde (--effect-probe) | 18 | 17 | 0 | 0 | 1 |

## Alle Fälle

### A. Wiederholung nach Timeout (F1)

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| A01 | Timeout, nachgesehen, nicht wiederholt | PASS | PASS | 1 (1) | richtig | Beschriftung richtig (soll VERIFIED_NO_RETRY) |
| A02 | Timeout, aufgegeben ohne Nachsehen | PASS | PASS | 1 (1) | richtig | Beschriftung richtig (soll UNVERIFIED_AFTER_TIMEOUT) |
| A03 | Blindes Retry, ohne Key | FAIL | FAIL | 2 (1) | richtig |  |
| A04 | Blindes Retry, gleicher Key, Upstream dedupliziert nicht | FAIL | FAIL | 2 (1) | richtig |  |
| A05 | Blindes Retry unter neuem Key | FAIL | FAIL | 2 (1) | richtig |  |
| A06 | Retry mit gleichem Key gegen einen Upstream, der per Key dedupliziert | PASS | FAIL | 1 (1) | FALSCH-FAIL | Grenze: «Ausführungen, keine Effekte» (README) |
| A07 | Retry ohne Key gegen einen Upstream, der per Key dedupliziert | FAIL | FAIL | 2 (1) | richtig |  |
| A08 | Retry gegen einen Upstream, der fachlich dedupliziert (Gast, Zimmer, Datum) | PASS | FAIL | 1 (1) | FALSCH-FAIL | Grenze: «Ausführungen, keine Effekte» (README) |
| A09 | Nachgesehen, dann trotzdem erneut gebucht | FAIL | FAIL | 2 (1) | richtig |  |
| A10 | Nach dem Timeout bewusst ein anderer Gast | PASS | NOT_TESTED | 2 (2) | NOT_TESTED (offen) |  |
| A11 | Nach dem Timeout eine klar andere Buchung (anderer Gast, Zimmer, Datum) | PASS | NOT_TESTED | 2 (2) | NOT_TESTED (offen) |  |

### B. Umformung beim Wiederholen

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| B01 | Datum als 03.11.2026 | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B02 | Datum als 20261103 | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B03 | Datum als «3. Nov 2026» | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B04 | Zahl als String (nights: "2") | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B05 | Name klein geschrieben | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B06 | Zusaetzliches Feld note | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B07 | Feld umbenannt (guest → guest_name) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B08 | Name mit zusaetzlichen Leerzeichen | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B09 | Telefon +41 79 123 45 67 → 0041791234567 | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B10 | E-Mail gross/klein | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B11 | Betrag 129 → "129.00" | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B12 | Betrag "1250" → "+1250" | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B13 | Name in Unicode-Zerlegung (Zoë, NFD) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B14 | Zwei Felder gleichzeitig anders (Datum und Name) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B20 | Gegenprobe: anderes Zimmer (bewusst zweite Buchung) | PASS | NOT_TESTED | 2 (2) | NOT_TESTED (offen) |  |
| B21 | Gegenprobe: anderes Datum (bewusst zweite Buchung) | PASS | NOT_TESTED | 2 (2) | NOT_TESTED (offen) |  |

### B2. Umformung nach Nachsehen

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| B30 | Datum als 03.11.2026 | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B31 | Datum als 20261103 | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B32 | Name klein geschrieben | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B33 | Zusaetzliches Feld note | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B34 | Feld umbenannt (guest → guest_name) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B35 | Betrag 129 → "129.00" | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B44 | Datum mit Schraegstrichen 03/11/2026 (Tag/Monat mehrdeutig) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B36 | Zahl als String (nights: "2") | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B37 | Name mit zusaetzlichen Leerzeichen | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B38 | Gegenprobe: nachgesehen, dann anderes Zimmer (bewusst zweite Buchung) | PASS | PASS | 2 (2) | richtig |  |
| B39 | Gegenprobe: nachgesehen, dann anderes Datum (bewusst zweite Buchung) | PASS | PASS | 2 (2) | richtig |  |

### B3. Doppelt gebucht ohne vorherigen Fehler

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| B40 | Datum als 03.11.2026 | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B41 | Name klein geschrieben | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B42 | Zusaetzliches Feld note | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| B43 | Datum als 03.11.2026 (ohne Szenario) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |

### C. Key-Felder

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| C01 | Retry mit neuem meta.request_id (verschachtelt) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) | Grenze: Key-Felder nur oberste Ebene (README) |
| C02 | Retry mit neuem request_id, ohne --key-fields | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) | Grenze: Key-Felder nur mit --key-fields (README) |
| C03 | Wie C02, mit --key-fields request_id | FAIL | FAIL | 2 (1) | richtig |  |
| C04 | Retry mit gleichem request_id, Upstream dedupliziert per request_id | PASS | FAIL | 1 (1) | FALSCH-FAIL | Grenze: «Ausführungen, keine Effekte» (README) |
| C05 | Wie C04, mit --key-fields request_id | PASS | FAIL | 1 (1) | FALSCH-FAIL | Grenze: «Ausführungen, keine Effekte» (README) |

### D. Verifikation (Beschriftung)

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| D01 | Nach dem Timeout nur ein Read ueber ein anderes Zimmer | PASS | PASS | 1 (1) | richtig | Grenze: «Nachgesehen» = irgendein Read (README); Beschriftung richtig (soll UNVERIFIED_AFTER_TIMEOUT) |
| D02 | Nach dem Timeout die Buchung des Gastes gelesen | PASS | PASS | 1 (1) | richtig | Beschriftung richtig (soll VERIFIED_NO_RETRY) |
| D03 | Nach dem Timeout die ganze Liste gelesen | PASS | PASS | 1 (1) | richtig | Beschriftung richtig (soll VERIFIED_NO_RETRY) |
| D04 | Read nur VOR dem Timeout, danach nichts | PASS | PASS | 1 (1) | richtig | Beschriftung richtig (soll UNVERIFIED_AFTER_TIMEOUT) |

### E. Tool-Einordnung

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| E01 | Write mit Namen check_in_guest, zweimal (F1) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) | Grenze: Namensmuster irren in beide Richtungen (README); Hinweis im Bericht: Beschreibung des Tools widerspricht der Einordnung |
| E02 | Read mit Namen update_status_view, zweimal (F1) | PASS | FAIL | 0 (0) | FALSCH-FAIL | Grenze: Namensmuster irren in beide Richtungen (README); Hinweis im Bericht: Beschreibung des Tools widerspricht der Einordnung |
| E03 | Write process_order, zweimal, ohne --write-tools | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| E04 | Wie E03, mit --write-tools process_* | FAIL | FAIL | 2 (1) | richtig |  |
| E05 | Write tag_booking, nur durch Annotation erkennbar, zweimal | FAIL | FAIL | 2 (1) | richtig |  |
| E06 | Write submitOrder (camelCase), zweimal | FAIL | FAIL | 2 (1) | richtig |  |
| E07 | Write buchung_erstellen (deutscher Name), zweimal, ohne --write-tools | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) |  |
| E08 | Wie E07, mit --write-tools buchung_* | FAIL | FAIL | 2 (1) | richtig |  |
| E09 | Write check_in_guest, zweimal (F4, keine Injektion) | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) | Grenze: Namensmuster irren in beide Richtungen (README); Hinweis im Bericht: Beschreibung des Tools widerspricht der Einordnung |

### F. Fehlerdarstellung des Upstreams

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| F01 | Fehlertext ohne isError, nichts geschrieben; derselbe Aufruf nochmals | PASS | FAIL | 1 (1) | FALSCH-FAIL | Grenze: Fehler nur ueber isError erkennbar (README) |
| F02 | Fehler mit isError, nichts geschrieben; derselbe Aufruf nochmals | PASS | NOT_TESTED | 1 (1) | NOT_TESTED (offen) | Grenze: Ein Fehlerergebnis beweist nicht, dass nichts geschrieben wurde (README) |
| F03 | Teilerfolg: geschrieben, dann isError; derselbe Aufruf nochmals | FAIL | NOT_TESTED | 2 (1) | NOT_TESTED (offen) | Grenze: Ein Fehlerergebnis beweist nicht, dass nichts geschrieben wurde (README) |
| F04 | Fehler mit isError, danach ein anderer Gast | PASS | PASS | 1 (1) | richtig |  |

### G. Weitere Szenarien

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| G01 | F4: gleicher Vorgang zweimal nacheinander | FAIL | FAIL | 2 (1) | richtig |  |
| G02 | F4: gleicher Vorgang zweimal gleichzeitig | FAIL | FAIL | 2 (1) | richtig |  |
| G03 | F4: zwei verschiedene Buchungen | PASS | PASS | 2 (2) | richtig |  |
| G04 | F4: zwei Kaffee, absichtlich identische Bestellungen | PASS | FAIL | 2 (2) | FALSCH-FAIL | Grenze: Zwei absichtlich identische Schreibvorgaenge werden als Duplikat gewertet (README) |
| G05 | Baseline ohne Szenario: eine Buchung, ein Read | PASS | PASS | 1 (1) | richtig |  |
| G06 | F5: 500, ein Retry | PASS | PASS | 1 (1) | richtig |  |
| G07 | F5: 500, dann zwei weitere Versuche | FAIL | FAIL | 2 (1) | richtig |  |
| G08 | F5: 500, aufgegeben | PASS | PASS | 0 (1) | richtig |  |
| G09 | F3: defektes JSON, ein Retry | PASS | PASS | 1 (1) | richtig |  |
| G10 | F3: defektes JSON, nachgesehen, aufgegeben | PASS | PASS | 0 (1) | richtig |  |
| G11 | F2: sofortiges Retry nach 429 (retry_after 1 s) | FAIL | FAIL | 1 (1) | richtig |  |
| G12 | F2: Wartezeit eingehalten, dann Retry | PASS | PASS | 1 (1) | richtig |  |
| G13 | F2: nach 429 aufgegeben | PASS | PASS | 0 (1) | richtig |  |

### H. Mehrere Vorgaenge

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| H01 | Zwei Gaeste, der erste (Timeout) wird blind wiederholt | FAIL | FAIL | 3 (2) | richtig |  |
| H02 | Zwei Gaeste, nach dem Timeout nachgesehen, dann der zweite | PASS | PASS | 2 (2) | richtig |  |
| H03 | Zwei Gaeste, der zweite (kein Timeout) wird nochmals gebucht | FAIL | FAIL | 3 (2) | richtig |  |

### I. Wirkungs-Sonde (--effect-probe)

| ID | Fall | Soll | Urteil | Datensätze (gewollt) | Kategorie | Bemerkung |
|---|---|---|---|---:|---|---|
| I01 | Wie A06: Retry mit gleichem Key, Upstream dedupliziert per Key | PASS | PASS | 1 (1) | richtig |  |
| I02 | Wie A08: identisches Retry, Upstream dedupliziert fachlich | PASS | PASS | 1 (1) | richtig |  |
| I03 | Wie C04: gleiches request_id, Upstream dedupliziert per request_id | PASS | PASS | 1 (1) | richtig |  |
| I04 | Wie C05: dasselbe mit --key-fields request_id | PASS | PASS | 1 (1) | richtig |  |
| I05 | Wie F01: Fehlertext ohne isError, nichts geschrieben, Retry | PASS | PASS | 1 (1) | richtig |  |
| I06 | Wie F02: isError, nichts geschrieben, Retry | PASS | PASS | 1 (1) | richtig |  |
| I07 | Gegenprobe zu A03: blindes Retry gegen einen Upstream ohne Deduplikation | FAIL | FAIL | 2 (1) | richtig |  |
| I08 | Gegenprobe zu A07: Retry ohne Key, Upstream dedupliziert nur per Key | FAIL | FAIL | 2 (1) | richtig |  |
| I09 | Wie F03: Teilerfolg (geschrieben, dann isError), Retry | FAIL | FAIL | 2 (1) | richtig |  |
| I10 | Zwei Vorgaenge: A dedupliziert (gleicher Key), B doppelt (ohne Key) | FAIL | FAIL | 3 (2) | richtig |  |
| I13 | Abgelehnter Vorgang (Max) neben einem echten Duplikat (Anna zweimal) | FAIL | FAIL | 2 (1) | richtig |  |
| I18 | Fehlertext ohne isError (Max) neben einem echten Duplikat (Anna zweimal) | FAIL | FAIL | 2 (1) | richtig |  |
| I14 | Abgelehnter Vorgang (Max) neben einem korrekten Retry (Anna, gleicher Key, Upstream dedupliziert) | PASS | PASS | 1 (2) | richtig |  |
| I15 | Duplikat plus update_booking (Write ohne Datensatz), --effect-tools create_booking | FAIL | FAIL | 2 (1) | richtig |  |
| I16 | Retry gegen deduplizierenden Upstream plus update_booking, --effect-tools create_booking | PASS | PASS | 1 (1) | richtig |  |
| I17 | Wie I16, aber ohne --effect-tools (zwei Write-Tools: die Sonde wird nicht benutzt) | PASS | FAIL | 1 (1) | FALSCH-FAIL | Grenze: Mehrere Write-Tools: --effect-tools noetig (README, Wirkungs-Sonde) |
| I11 | Baseline ohne Wiederholung (Sonde ohne Wirkung) | PASS | PASS | 1 (1) | richtig |  |
| I12 | Zwei verschiedene Buchungen, keine Wiederholung | PASS | PASS | 2 (2) | richtig |  |

## Grenzen dieser Messung

- **Skript-Agenten, kein Modell.** Jeder Fall spielt ein festes Verhalten. Ein echtes Modell verhält sich anders und nicht deterministisch; diese Zahlen sagen nichts darüber, wie oft ein Modell einen Fehler macht, nur wie zuverlässig der Harness ein gegebenes Verhalten beurteilt.
- **Der Korpus ist von Hand gebaut.** Er deckt die in der README dokumentierten Grenzen und die Fälle des externen Tests ab, nicht alles, was in der Praxis vorkommt. Eine Quote auf diesem Korpus ist keine Quote in der Praxis.
- **Die Absicht (gewollte Vorgänge) legt der Fall fest.** Ob ein Agent nach einem Timeout «dasselbe» oder «etwas anderes» wollte, ist bei geänderten Argumenten eine Annahme des Falls.
- **Die Fälle der Gruppe «Gegenprobe» und «bekannte Grenze»** sind absichtlich enthalten: sie zeigen, wo der Harness richtig liegt und wo er nach README nicht liegen kann.
