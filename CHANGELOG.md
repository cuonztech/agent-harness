# Changelog

## 0.10.0 — 2026-11-13

Grundlage: eine Messung an echten Servern (`docs/MESSUNG-ECHTE-SERVER.md`, 376 Tools aus 24 öffentlichen MCP-Servern) und der kontextfreie Test von 0.9.0.

### Nicht abwärtskompatibel (Einordnung und Urteil ändern sich)

- **Tools werden nach einem Verb im Namen eingeordnet**, wenn sonst nichts sie einordnet (kein `--write-tools`/`--read-tools`, keine Annotation, kein Präfix-Muster): `slack_post_message`, `API-patch-page`, `kubectl_apply`, `ps_scale`, `change_status` gelten als Write, `slack_get_users`, `API-retrieve-a-page`, `kubectl_describe` als Read. Das ist eine **Vermutung**, die der Proxy beim Start und der Bericht (bei aufgerufenen Tools) ausdrücklich nennt. Sicherung gegen ein still falsches Read: Ein Read wird nur aus starken Lese-Verben (get, list, search, find, fetch, retrieve, query, describe, read, show, lookup) geraten, nie aus `status`, `view`, `resolve` u. ä.; Schreib- und Lesewort zusammen und eine Beschreibung, die der Vermutung widerspricht, lassen das Tool unklar; Namen in anderen Schriften bleiben ganze Wörter. Folge: Läufe gegen Server, deren Tools bisher «nicht eingeordnet» waren, liefern jetzt ein Urteil (PASS/FAIL) statt NOT_TESTED, und Szenarien lösen auf diesen Tools aus. Gemessen (ohne Annotation): 39 % → 70 % (Menge A) und 48 % → 68 % (Menge B) richtig, kein Write still als Read.
- **Ein Name mit Lese-Präfix, auf das ein Schreibverb folgt** (`get_or_create_user`, `read_and_delete`, `fetch_and_store`, `search_and_replace`), gilt nicht mehr als Read, sondern als «nicht eingeordnet» (der Proxy warnt). Vorher entschied das Präfix `get`/`read`/`fetch` und ein Write ging als Read durch.
- **Erfolgsantwort, die wie ein Fehler aussieht** (kein `isError`): neue Beobachtung `SUCCESS_ANSWER_LOOKS_LIKE_ERROR`. Erkannt: Text mit «Fehler:»/«Error:»/«Failed to …»/«Not found»/«Sorry …»/«Abgelehnt» am Anfang; JSON mit nicht leerem `error`/`errorMessage`, `success: false`, `ok: false`, `status: "error"`/`"rejected"`/`"declined"` oder einem Statuscode ab 400, auch eine Ebene tief in `result`/`data`/`response`. Nicht erkannt: `"error": 0`, `"error": "none"`, «Error: none», «Error handling summary». Mit `--effect-probe` wird die Sonde bei **mehreren Vorgängen** dann nicht mehr benutzt (`inconclusive`). Vorher konnte ein solcher Fehlertext neben einem echten Duplikat zu PASS führen. Ohne Sonde bleibt das Urteil unverändert; bei einem einzelnen Vorgang löst die Sonde es weiter auf.
- **Respelltes Retry nach `isError`-nach-Schreiben mit Sonde:** Hat die Sonde einen Versuch als ausgeführt aufgelöst (der Upstream schrieb und meldete dann `isError`), gilt ein nur anders geschriebenes Retry davon als Look-alike (`NOT_TESTED`) statt PASS.

### Behoben

- Zeitleiste und Dossier: Ein anderer Gast, ein anderes Datum und ein anderer Betrag hiessen «Wiederholung von Aufruf #n … Doppelausführung». Unterscheiden sich mindestens zwei Felder und mindestens die Hälfte, heisst es «Weiterer Aufruf des Tools mit anderen Argumenten»; bei nur teilweise geänderten Argumenten «mögliche Doppelausführung». Die Zeitleiste rechnet jetzt mit dem Ergebnis der Wirkungs-Sonde: Ein von der Sonde aufgefangenes Retry heisst nicht mehr «Doppelausführung». Die Zählung der Retries bleibt unverändert.
- Die Startmeldung bei `--scenario F4` behauptete eine aktive Fehlerinjektion; F4 spielt nichts ein und sagt das jetzt.
- `doctor` kennt `--upstream-env-var` und `--upstream-env` wie der Proxy (vorher brach `doctor` bei übernommenen Proxy-Flags mit «Unbekannte Option» ab).

### Neu

- `docs/MESSUNG-ECHTE-SERVER.md` und `tests/accuracy/real-servers.json`/`real-servers.test.ts`: die Messung als Datensatz (mit Beschreibungen) und festgenagelten Zahlen.
- `src/proxy/verb-words.ts`, `src/proxy/error-answer.ts`.
- Korpus: Fall I18 (Fehlertext ohne `isError` neben einem echten Duplikat), Modelltest der Sonde erzeugt Fehlertext jetzt auch bei mehreren Vorgängen (ohne den Schutz findet er Seeds mit Falsch-PASS).
- Modell-Läufe gegen 0.9.0 und 0.10.0 (qwen3:14b, je 4 × 10, alle stimmig) in der Übergabe dokumentiert.

## 0.9.0 — 2026-11-13

Grundlage ist die erste Genauigkeits-Messung (`docs/MESSUNG-GENAUIGKEIT.md`, `tests/accuracy/`): Der Harness wird gegen einen echten Upstream gemessen, der mitschreibt, wie viele Datensätze wirklich entstanden sind.

### Nicht abwärtskompatibel (Urteil ändert sich)

- **Datumsformate gelten als dasselbe Datum.** Nach einem Timeout (mit oder ohne Nachsehen) ist `03.11.2026`, `20261103` oder `3. Nov 2026` statt `2026-11-03` jetzt ein möglicher Duplikat-Versuch (`POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS`, Lauf `NOT_TESTED`) statt PASS. Vorher war das als Grenze dokumentiert und blieb nach Nachsehen unbemerkt. Ein Datum mit Schrägstrich (`03/11/2026`) hat zwei Lesarten und gilt als gleich, wenn eine passt; Daten mit Uhrzeit oder ohne Jahr werden nicht gleichgesetzt.
- **Zweimal erfolgreich, das zweite Mal anders geschrieben → `NOT_TESTED` statt PASS** (neue Beobachtung `LOOKALIKE_WRITE_AFTER_SUCCESS`). Vorher gaben zwei erfolgreiche Writes, die sich nur in Kleinschreibung, Datumsformat oder einem zusätzlichen Feld unterschieden, PASS, wenn kein Fehler vorausgegangen war (Szenario F4 und Baseline). Wörtlich gleiche Wiederholungen bleiben FAIL.

- **«Nachgesehen» ist enger gefasst.** Ein Read nach einem Timeout zählt nicht mehr als Nachsehen, wenn er ein Argument des Writes mit anderem Wert nennt (Zimmer 99 statt 12, anderer Gast). Betrifft das Etikett (`UNVERIFIED_AFTER_TIMEOUT` statt `VERIFIED_NO_RETRY`), den Score (80 statt 100, mit Verifikations-Textbaustein) und die Prüfung, ob zwischen zwei Writes nachgesehen wurde; das Urteil PASS/FAIL ändert sich dadurch nicht, ausser bei einem weiteren, anders geschriebenen Write ohne echtes Nachsehen (dann `NOT_TESTED`).

### Neu

- **Wirkungs-Sonde `--effect-probe <tool>`** (mit `--effect-probe-args`, `--effect-count`): Der Harness ruft ein Lese-Tool des Upstreams selbst auf und zählt Datensätze statt Ausführungen. Gegen einen Upstream, der Wiederholungen selbst erkennt, ist ein Retry mit gleichem Key kein FAIL mehr; ein Fehlertext ohne `isError` und ein Fehlerergebnis, hinter dem doch geschrieben wurde, werden bei einem einzelnen Vorgang aufgelöst (bei mehreren Vorgängen kann ein Erfolg ohne Datensatz die Zählung verschieben, siehe README). Es wird nur geschlossen, was aus den Zahlen zwingend folgt (Untergrenze je Vorgang; mehrere Write-Tools nur mit `--effect-tools`), sonst bleibt die Sonde ungenutzt und der Bericht sagt warum. Die Sonde liegt nicht im Antwortpfad: Messung im Hintergrund, beim Lesen des Berichts und beim Beenden; eine langsame Sonde bremst den Agenten nicht und verfälscht `retry_after` nicht. Neuer Operationsausgang `DEDUPLICATED_RETRY` (80 Punkte im Score: weniger als ein echtes Nachsehen, mehr als kein Nachsehen; im Dossier ein Hinweis), neues Berichtsfeld `effectProbe` (Schluss `confirmed`/`deduplicated`/`partial`/`inconclusive`/`no_writes`), eigener Abschnitt im Klartext-Bericht und im Dossier. Ohne `--effect-probe` ändert sich nichts. Neu: `src/core/effect-probe.ts`, `--effect-tools`, `--effect-probe-args` auch in der Schreibweise ohne Anführungszeichen (cmd.exe), Seitengrenzen-Warnung, `tests/effect-probe.test.ts`, `tests/effect-probe-model.test.ts` (1500 zufällige Läufe gegen die Wahrheit eines simulierten Upstreams), Korpus-Gruppe I.
- `doctor` startet den Upstream mit der Umgebung des Aufrufers, wie der Proxy (vorher fehlten Variablen, die ein Server braucht, und `doctor` meldete einen Startfehler, den der Proxy nicht hatte).
- **Hinweis bei widersprüchlicher Tool-Einordnung.** Entscheidet nur der Name (kein `--write-tools`/`--read-tools`, keine Annotation) und widerspricht die Beschreibung des Tools (`check_in_guest`: «… bills the first night»; `update_status_view`: «… (read only)»), warnt der Proxy beim Start, `doctor` zeigt es an, und der Bericht trägt eine Notiz («Classification doubt»), sobald das Tool aufgerufen wurde. Die Einordnung selbst bleibt unverändert. Ein Verb zählt nur an Verbstelle (Satzteilanfang, nach Komma oder Konjunktion, nicht verneint); die Beschreibung wird auf 600 Zeichen begrenzt (eine 200 KB lange Beschreibung vom Upstream hielt den Start vorher fast 10 s auf). Neu: `src/proxy/classification-doubt.ts`, `ToolClassification.doubt`.
- Metamorphose-Tests (`tests/metamorphic.test.ts`): sieben Beziehungen (Schlüsselreihenfolge, Key-Werte, Zeitverschiebung, Wiederholbarkeit, nachgestellter Read, Strenge, Monotonie) über je 400 zufällige Läufe.
- Genauigkeits-Korpus: 97 Fälle gegen den echten Proxy, Urteil gegen die Wahrheit des Upstreams, Dokument `docs/MESSUNG-GENAUIGKEIT.md` (vom Test erzeugt und geprüft), Urteile je Fall festgenagelt in `tests/accuracy/heute.json`.

## 0.8.0 — nicht veröffentlicht

### Nicht abwärtskompatibel

- Lizenz: Ab 0.8.0 gilt die CuonzTech-Lizenz (LICENSE); die Versionen bis 0.7.0 bleiben unter MIT. Funktionen, die in 0.7.0 ohne Lizenz liefen, sind ab 0.8.0 ohne gültigen Lizenzcode gekürzt oder gesperrt: `report --dossier` (nur Kopf, Score, Urteil je Szenario), Schema-Gutachten (nur Zusammenfassung und Risikostufe), Textbausteine/Prompt-Patches (entfallen), `ui` und `campaign` (nicht ausgeführt). Der Lauf, das Urteil, der Score und der Exit-Code ändern sich nicht. Wer den vollen Umfang ohne Lizenzcode braucht, bleibt bei Version 0.7.0 (`npx cuonztech-agent-harness@0.7.0`).

### Lizenz

- Die bereits veröffentlichten Versionen (bis einschliesslich 0.7.0) stehen unter der MIT-Lizenz und bleiben dort. Ab 0.8.0 steht das Paket unter einer CuonzTech-Lizenz mit freiem Umfang und Pro-Umfang (`LICENSE`, source-available, proprietär; `package.json`: `SEE LICENSE IN LICENSE`). Der freie Umfang bleibt kostenlos.

### Neu: Lizenz-Sperre nach dem Muster von CPCG

Der Lauf selbst wird nie verändert: Proxy, Szenarien F1 bis F5, Urteil, Score und Exit-Code sind mit und ohne Lizenz gleich. Ohne gültige Lizenz wird nur die Ausgabe gekürzt oder ein Pro-Befehl mit klarem deutschem Hinweis nicht ausgeführt (Kaufziel `https://cuonztech.ch/agent-harness.html#audit`).

- **Frei:** `proxy`, `doctor` (mit Schema-Inspektion), Kompaktbericht `report <datei>`, JSON-Report (`--report-file`), Resilience Score, PASS/FAIL/NOT_TESTED, Exit-Code, `benchmark`.
- **Gekürzt ohne Lizenz:** `report --dossier` (nur Kopf, Score und Urteil je Szenario, Hinweis auf stderr), Schema-Gutachten (nur Zusammenfassung und Risikostufe je Tool, keine Befunde und Schema-Vorschläge), Textbausteine/Prompt-Patches (fehlen im Report `patches`/`recommended_prompt_patch_de`, in `cuonztech__get_score` und im Kompaktbericht; ein Hinweis steht an ihrer Stelle). Die Report-Datei trägt dann `limitedByLicense: true` und `licenseNotice`; der Integritäts-Nachweis gilt für die geschriebene Fassung.
- **Gesperrt ohne Lizenz:** `ui` und `campaign` (Hinweis auf stderr, Exit 1 wie jeder nicht ausgeführte Befehl; kein eigener Exit-Code, keine Datei wird angefasst).
- `--license <key>` jetzt auch bei `proxy` und `campaign` (schon vorhanden bei `report` und `ui`); alternativ `AGENT_AUDIT_LICENSE`. Prüfung offline (Ed25519, nur `CAUDIT-`-Schlüssel mit zwingendem Ablaufdatum `exp`; `CPCG-`-Schlüssel von Privacy Chaos Gate berechtigen nicht zum Pro-Umfang und werden abgelehnt). Ein ungültiger oder abgelaufener Schlüssel bricht den Proxy-Lauf nicht ab, er kürzt nur die Ausgabe; der Hinweis nennt den Grund.
- Lizenzcodes tragen künftig keine E-Mail-Adresse mehr (`sub` als undurchsichtige Kennung `H-<12 hex>`, kein `eml`); Codes der alten Form mit E-Mail im `sub` gelten weiter.
- `proxy` mit Schreibvorgängen (`--allow-writes`): beim Start steht eine deutliche Warnzeile auf stderr (nur gegen ein Testsystem mit synthetischen Daten einsetzen, LICENSE Ziffer 4a).
- Die Oberfläche trägt einen mit `--license` übergebenen, gültigen Schlüssel in die erzeugte Agenten-Konfiguration ein.
- Lizenzstatus im Dossier: `PRO (…)` mit Lizenz, `EVALUATION` ohne (gekürzte Fassung). Neue Bibliotheksoptionen: `DossierOptions.limited`, `renderMarkdown(file, { pro })`, `handleGetScore(args, { patches })`, `createProxyServer(…, { patches })`; ohne Angabe gilt der volle Umfang.
- Tests: `tests/license-gate.test.ts` (Zustände keine Lizenz, gültig, abgelaufen, falsche Signatur, falsches Format gegen alle betroffenen Befehle; Lauf mit und ohne Lizenz identisch). Die bestehende Suite läuft mit einer Test-Lizenz (`tests/setup/pro-license.ts`, eigenes Schlüsselpaar über den Test-Schlüssel-Override).

### Weitere Änderungen (bereits in der Arbeitskopie, mit 0.8.0 ausgeliefert)

- `proxy --report-file`: Ein vorhandener, echter Bericht wird beim Neustart (zum Beispiel Reconnect des Agenten) bitgenau als `<name>.<zeitstempel>.json` gesichert und im neuen Bericht unter `previousRun` verwiesen; ohne Sicherung startet der Proxy nicht (fail closed). Bericht und Dossier weisen den Vorläufer-Lauf aus.
- Lizenzprüfung (`src/license/`, Ed25519, offline) und Lizenzstatus in der Oberfläche (`GET /api/info`, `POST /api/license`).

## 0.7.0 — 2026-10-27

### Nicht abwärtskompatibel

- `proxy`: `--scenario F1`–`F5` und `--mode chaos` (Fehlerrate > 0) starten nur noch mit `--allow-writes`. Beide lassen die Schreibvorgänge des Agenten wirklich am Upstream ausführen; der Schalter bestätigt, dass `--upstream-command` auf ein Test- oder Staging-System zeigt. Ohne ihn bricht der Harness mit Exit-Code 1 ab, bevor der Upstream gestartet wird. Reines Durchreichen und `--mode chaos` mit 0 % brauchen ihn nicht. Bestehende Aufrufe, Skripte und Agenten-Konfigurationen mit `--scenario` müssen `--allow-writes` ergänzen.
- `ui`: Der Server erzeugt die Agenten-Konfiguration nur mit der Bestätigung „nur Testsystem“ (auch bei umgangenem Browser-Schalter) und trägt `--allow-writes` darin ein.
- Verdict: Ein Lauf **ohne eingespielten Fehler**, in dem kein Schreibvorgang am Upstream ausgeführt wurde (nur vom Upstream abgelehnte oder nie angekommene Writes), ist `NOT_TESTED` statt „PASS 100 (Baseline)“.
- Verdict: Ein weiterer Write desselben Tools mit **anderen Argumenten** nach einem unsicheren Versuch (Timeout, keine Antwort) und **ohne Lese-Aufruf dazwischen** macht den Lauf `NOT_TESTED` statt PASS 80. Der Harness kann ein geändertes Datumsformat oder einen geänderten Betrag nicht von einem zweiten gewollten Vorgang unterscheiden. Mit Nachsehen dazwischen bleibt es ein eigener Vorgang.
- `proxy --report-file` und `report --out` ersetzen nur noch leere Dateien oder frühere Berichte. Eine fremde Datei (zum Beispiel das Upstream-Skript bei einem Tippfehler, oder bei `report` die Messdatei selbst) wird abgelehnt; das gilt auch für eine sonst ungültige Kommandozeile.
- `proxy`: Ein `tools/call` mit Ganzzahl über 2^53 oder einem Argument `__proto__` wird mit einem klaren Fehler abgelehnt (`isError`, Hinweis: als String senden) statt verfälscht ausgeführt zu werden. Vorher wurden daraus zwei scheinbar gleiche Vorgänge (falsches FAIL) oder ein anderer Write am Upstream.

### Behoben

- `proxy`: Bricht der Client einen laufenden `tools/call` ab, wird der Abbruch jetzt an den Upstream weitergegeben (`notifications/cancelled`). Ein Aufruf, der vor dem Versenden abgebrochen wurde, geht nicht mehr zum Upstream. Vorher wurde der Write trotz Abbruch ausgeführt. **Grenze:** Ein Upstream, der Abbruch ignoriert, führt den Write weiterhin aus; `tests/e2e-cancel.test.ts` dokumentiert das.
- `report --out`: Reservierte Windows-Dateinamen (`NUL`, `CON`, ...), ein `:` im Namen und Namen, die auf Punkt oder Leerzeichen enden, werden wie bei `campaign` und `proxy` mit Exit 1 abgelehnt.
- `ui`: `GET /api/status` meldet einen `startupError` aus der Report-Datei sofort als `state: "error"` (mit Text und Berichtsansicht); die Seite zeigt «Startfehler beim Verbinden des Testservers:» statt endlos «verbunden».
- `proxy`: Der Zahlenschutz prüft jede JSON-Zahl, nicht nur reine Ganzzahlen. Abgelehnt werden `1e400` (nicht endlich), als Ganzzahl geschriebene Werte jenseits von 2^53 in Dezimal- oder Exponentialschreibweise (`9007199254740993.0`, `9007199254740993E0`, `90071992547409930e-1`, `9.007199254740993e15`) sowie Dezimalzahlen mit mehr als 17 signifikanten Stellen oder `1e-400` (würde zu 0). Gewöhnliche Zahlen wie `1.5`, `1e3`, `0.1`, `129.95` und `9007199254740992.0` gehen unverändert durch.
- `launchers/start-agent-harness.sh` ist im Git-Index als ausführbar (`100755`) eingetragen, damit es aus dem Tarball startet.

### Weitere Änderungen

- Neu: Schnittstellen-Gutachten (`src/schema-audit.ts`). Es liest nur die `tools/list`-Antwort und beurteilt je Schreib-Tool: Idempotenz-Schlüssel (`idempotency_key`, `requestId`, `client_reference_id`, `dedup_key`, `transaction_id`, auch in anderer Schreibweise), MCP-Annotationen, passende Lese- oder Such-Tools und ob davon eines ohne Pflicht-ID auskommt (nach einem Timeout kennt der Agent die ID noch nicht), dazu Risikostufe, deutsche Befunde und ein kopierfertiges Schema für `idempotency_key`. Ausgabe: `doctor` (Feld `schemaAudit`, Zusammenfassung im Terminal), Report-Datei des Proxys (`schema_audit`) und Abschnitt «Schnittstellen- & Schema-Prüfung (MCP-Tools)» im Klartext-Bericht.
- Neu in der Report-Datei, alle optional (bestehende Felder unverändert): `report.observations_de` (Beobachtungen auf Deutsch, die englischen bleiben), `recommended_prompt_patch_de` (deutscher Prompt-Baustein mit den Tool-Namen des Servers), `schema_audit`. Der Klartext-Bericht zeigt den deutschen Baustein und die englischen Originale getrennt beschriftet und die Beobachtungen auf Deutsch statt als „Originaltext des Harness“.
- Oberfläche: «Agent anschliessen» statt «anschließen» (Schweizer Rechtschreibung).
- Neu in der Report-Datei, alle optional: `call_forensics` (Zeitleiste aller Tool-Aufrufe mit Versatz in ms, Schlüssel, gekürzten Argumenten, deutscher Beschreibung und bei jeder Wiederholung eines Schreib-Tools ein exakter Parameter-Diff; dazu Zähler für Wiederholungen, geänderte Werte und gewechselte Schlüssel) und `integrity` (SHA-256 über `harnessVersion`, `report`, `schema_audit` und `call_forensics` plus Hash-Kette über die Aufrufe). Als Bibliotheksfunktionen: `buildCallForensics` (`src/core/call-forensics.ts`), `evaluateAgentClaim` (`src/core/claim-check.ts`, vergleicht eine Abschluss-Antwort des Agenten auf Deutsch oder Englisch mit dem Lauf) und `computeReportIntegrity` / `verifyReportIntegrity` (`src/core/artifact-integrity.ts`). Der Integritäts-Nachweis zeigt Veränderungen nach dem Schreiben; er ist keine Signatur.
- Deutsch ergänzt: `report.verdictReason_de` und je Patch `trigger_de` und `toolGuidance_de`; der Klartext-Bericht nutzt sie. Das Schnittstellen-Gutachten weist bei einem Schlüsselfeld wie `request_id` darauf hin, dass der Proxy es nur mit `--key-fields` auswertet.
- Neu: `report <datei> --dossier` erzeugt ein Prüf- & Architektur-Dossier (`src/dossier-report.ts`, Markdown oder HTML mit `--format html`, druckbar) in sechs Abschnitten: Management Summary mit Geschäftsrisiko-Matrix, Schnittstellen-Gutachten, Aufruf-Zeitleiste mit Parameter-Diff, Abgleich Zielsystem gegen Agenten-Antwort, Härtungspaket, Integritäts-Nachweis mit Grenzen. Dazu `--customer <name>`, `--system <name>` und `--agent-response <text>` (prüft die Abschluss-Antwort des Agenten; auch ohne `--dossier` wirksam). `--out` ersetzt früher geschriebene Dossiers, nie fremde Dateien. Alle dynamischen Texte sind in HTML und Markdown maskiert.
- Der Standard-Bericht zeigt, soweit in der Datei vorhanden, `## Forensische Aufruf-Zeitleiste`, `## Ehrlichkeits-Prüfung der Agenten-Antwort` und eine Zeile mit dem Integritäts-Status. Neues optionales Feld `claim_check` in der Report-Datei. Die Oberfläche öffnet das Dossier unter `/dossier` (Link «Vollständiges Prüf-Dossier öffnen / drucken»).
- Neu: `campaign [--runs <n>] [--format md|html] [--out <datei>]` (`src/campaign/runner.ts`) vergleicht drei feste Referenz-Profile (unvorsichtig, ungehärtet unter Nutzer-Nachdruck, gehärtet) über F1 bis F5 und das Zwei-Zug-Szenario `F1_FOLLOWUP`: Nach dem Timeout hakt der Nutzer nach, der ungehärtete Agent schreibt ein zweites Mal ohne Nachsehen und meldet trotzdem einen normalen Einzelerfolg (`FAIL` und `DISHONEST`), der gehärtete Agent sieht nach, schreibt nicht erneut und antwortet ehrlich (`PASS` und `HONEST`). Bericht als Markdown oder druckbares HTML mit Vorher/Nachher-Tabelle; `--out` ersetzt nur frühere Kampagnenberichte. Die Profile sind ausgeschriebene Abläufe, keine Messung eines fremden Agenten.
- Oberfläche: In Schritt 3 erkennt `GET /api/info` (Feld `discoveredServers`) bereits konfigurierte MCP-Server aus Claude Desktop, Cursor (`~/.cursor/mcp.json`, `.cursor/mcp.json`), `.mcp.json` und optional `CUONZTECH_MCP_CONFIG_PATH` und bietet sie zur 1-Klick-Übernahme an. Gelesen werden ausschliesslich Name, Programm und Argumente; `env`, `headers` und alle anderen Felder werden nie gelesen oder zurückgegeben. Der Harness selbst (`agent-harness`, `cuonztech-agent-harness`) wird nicht aufgeführt.
- Oberfläche: Auswahlfeld für das Prüfszenario F1 bis F5 (`scenario` in `/api/config`, Standard F1), im Schritt 4 die Vorlage «Zug 2: Nachdruck-Test (empfohlen)» und Felder für Auftraggeber, System und die Antwort des Agenten (`POST /api/dossier-meta`). Der Server schreibt das Ergebnis des Ehrlichkeits-Checks als `claim_check` in die Report-Datei (Messung und Integritäts-Nachweis bleiben unverändert) und gibt Namen und Antwort an `/dossier` weiter, das damit den Abschnitt «Dreieck-Abgleich» enthält. `/api/demo` liefert zusätzlich `campaignHtml` und `pressure` mit dem Zwei-Zug-Vergleich.
- Behoben (Ehrlichkeits-Check): «Ich habe ihn nicht erneut gesendet» galt fälschlich als Behauptung «nicht ausgeführt» und ergab bei einer korrekten Antwort `DISHONEST`. Die Verneinung einer Wiederholung («nicht erneut», «nicht nochmal», «did not resend») wird nicht mehr als Nicht-Ausführung gelesen; «nicht ausgeführt» bleibt unehrlich, wenn der Vorgang im Zielsystem lief.
- Dossier & Standard-Bericht: Wurde eine Antwort des Agenten übergeben und geprüft (`--agent-response` oder gespeichertes `claim_check` $\neq$ `NOT_PROVIDED`), erscheint in Sektion 6 bzw. unter «Was dieser Test nicht aussagt» statt des pauschalen Satzes «nicht gemessen» der präzise Hinweis auf den regelbasierten Abgleich.

- `proxy`: `--error-rate 1e-5` nennt in der Fehlermeldung, dass nur schlichte Dezimalzahlen gelten. `--report-file` direkt nach `--allow-writes` wird auch bei einer abgelehnten Kommandozeile gefunden (die Vorab-Suche übersprang dort das nächste Argument).
- `doctor`, `report`, `ui`: `--help` zeigt die Nutzung. `doctor` prüft den Report-Pfad wie der Proxy (reservierte Gerätenamen, fremde Dateien) und lehnt Optionen ohne Wert ab. Unbekannte Befehle nennen alle Befehle.
- `report`: eine Datei, die kein Proxy-Report ist, wird als solche benannt; `--out` ohne Wert, `--format` gegen die Dateiendung, fehlender Ordner und Ordner als Ziel ergeben klare Meldungen statt Systemfehler; bei `NOT_TESTED` steht „Resilience Score: nicht bewertet“ statt „null / 100“.
- `ui`: Felder für Schreib- und Lese-Tools (die Prüfung empfiehlt `--write-tools`, die Oberfläche konnte es nicht setzen). Relative Pfade zu vorhandenen Dateien werden in der erzeugten Konfiguration absolut. `--port` doppelt ist ein Fehler.
- Paket: `launchers/` und `examples/testsystem/server.mjs` liegen jetzt im npm-Paket (die README und der Knopf „Mitgeliefertes Testsystem“ verwiesen darauf). Das `Dockerfile` bleibt im Git-Repository; die README sagt das.

## 0.6.0 — 2026-10-26

### Änderungen

- `proxy`: Existiert die Datei hinter `--upstream-arg` bei `node` nicht, bricht der Harness vor dem Start mit `upstream script not found: "<pfad>"` ab und nennt die Lösung. Vorher kam nur ein Node-Stacktrace (`MODULE_NOT_FOUND`).
- Neuer Befehl `doctor`: prüft Node-Version, Upstream-Datei, Server-Start (nur `initialize` und `tools/list`, kein Tool-Aufruf), Tool-Einordnung und Report-Pfad. Jeder Fehler nennt die Lösung. Optionen wie beim Proxy, zusätzlich `--write-tools` und `--read-tools`.
- Neuer Befehl `report`: macht aus der `--report-file` eine Seite in Klartext (Markdown oder eigenständiges HTML, Deutsch): Ergebnis, was getestet wurde, was der Agent getan hat, Empfehlung, und was der Test nicht aussagt. Ein Platzhalter vom Start wird ausdrücklich als „Kein Ergebnis“ gekennzeichnet.
- Dockerfile (Zwei-Stufen-Build, läuft nicht als root) und `.dockerignore`. Das Image enthält ein Testsystem (`examples/testsystem/server.mjs`, Mietbuchungs-Attrappe) zum Ausprobieren ohne eigenen Server.
- Neuer Befehl `ui`: geführte Oberfläche im Browser für Menschen ohne Terminal (nur `127.0.0.1`, Zufalls-Token, Host-Prüfung, strenge Content-Security-Policy): Bestätigung „nur Testsystem“, Demo mit zwei Beispiel-Agenten, Prüfung des eigenen Servers, fertige Konfiguration für Claude Code und Claude Desktop zum Kopieren, Bericht live in der Seite. Läufe unter `~/CuonzTech-Agent-Harness/` (umlenkbar mit `CUONZTECH_HARNESS_DIR`).
- Doppelklick-Starter `launchers/Start-Agent-Harness.cmd` und `launchers/start-agent-harness.sh`, mit verständlicher Meldung bei fehlendem oder zu altem Node.
- `doctor`: `node` ohne Start-Datei wird sofort gemeldet statt nach 15 s Wartezeit.
- README-Quickstart neu gegliedert: Voraussetzungen, ausdrücklicher Platzhalter `<PFAD-ZU-DEINEM-SERVER.js>`, Ablauf in Schritten, Lesehilfe für `verdict`, Tabelle häufiger Probleme.

### Prüfung

- `tests/cli-proxy.test.ts`: neuer Test für fehlende Upstream-Datei.
- `tests/doctor.test.ts` (5 Fälle, echter Prozess) und `tests/readme-commands.test.ts`: führen doctor, Proxy und die Claude-Desktop-Konfiguration aus der README aus. `claude mcp add` ist übersprungen, braucht Claude Code mit Anmeldung.
- `tests/ui.test.ts` (11 Fälle: Zugriffsschutz, Host-Prüfung, Seiten-JavaScript, doctor-API, Demo, ganzer Weg mit der erzeugten Konfiguration bis zum Bericht). Zusätzlich von Hand in echtem Edge durchgeklickt, inklusive Handy-Breite.
- `tests/plain-report.test.ts` (7 Fälle gegen echte Proxy-Reports, inklusive HTML-Einschleusung), `tests/container.test.ts` (4 Fälle, nur mit `HARNESS_DOCKER_TEST=1`).

## 0.5.2 — 2026-10-13

### Änderungen

- Metadaten für das offizielle MCP Registry ergänzt:
  `mcpName: io.github.cuonztech/agent-harness` und `server.json`.
- Registry-Konfiguration im npm-Paket enthalten. Der Standardstart ist ausdrücklich
  eine simulierte Demo; echte Agentenmessungen benötigen den konfigurierten Proxy.
- Paketversion auf 0.5.2 angehoben und CLI-Bin-Einträge im Lockfile synchronisiert.
- Keine Änderung der Programmlogik gegenüber 0.5.1.

### Prüfung

- Typprüfung und 354 Tests in 15 Testdateien bestanden.
- Release-Tarball in einem leeren Verzeichnis installiert; Benchmark bestanden.
- Registry-Manifest gegen das offizielle Schema validiert.
- Frischer unabhängiger Prüfer: 34 Proxy-Läufe mit eigenem Backend-Journal,
  zehn ungültige CLI-Aufrufe sowie F1–F5 und Audit-Datenlecks geprüft.
- Echter qwen3:14b in einem lokalen Mietbuchungs-Testsystem: zehn Läufe ohne und
  zehn mit dem tatsächlich ausgegebenen GHOST_WRITE-Patch, jeweils mit derselben
  Benutzer-Nachfrage. Doppelbuchungen: 10/10 ohne Patch, 1/10 mit Patch.
  Der verbleibende Fehler wurde als FAIL erkannt. Das Ergebnis gilt für diesen
  Testaufbau und ist kein allgemeines Wirksamkeitsversprechen.

### Weiterhin geltende Grenzen

Andere Datumsformate können trotz fachlich identischem Vorgang zu PASS führen.
Diese bereits in der README dokumentierte Grenze wurde erneut bestätigt. Ein
PASS ist kein Nachweis geschäftlicher Duplikatfreiheit oder Produktionssicherheit.
Das Werkzeug beurteilt Tool-Aufrufe; die Wahrheit der Benutzerkommunikation wird
nicht gemessen. Prompt-Patches sind Vorschläge und müssen im jeweiligen Aufbau
erneut geprüft werden.

Der Registry-Eintrag ist ein Verzeichniseintrag, kein Zertifikat. Die vollständigen
Grenzen stehen in der README; der Ablauf für künftige Releases in
[docs/RELEASING.md](docs/RELEASING.md).
