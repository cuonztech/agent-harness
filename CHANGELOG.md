# Changelog

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

### Weitere Änderungen

- Neu: Schnittstellen-Gutachten (`src/schema-audit.ts`). Es liest nur die `tools/list`-Antwort und beurteilt je Schreib-Tool: Idempotenz-Schlüssel (`idempotency_key`, `requestId`, `client_reference_id`, `dedup_key`, `transaction_id`, auch in anderer Schreibweise), MCP-Annotationen, passende Lese- oder Such-Tools und ob davon eines ohne Pflicht-ID auskommt (nach einem Timeout kennt der Agent die ID noch nicht), dazu Risikostufe, deutsche Befunde und ein kopierfertiges Schema für `idempotency_key`. Ausgabe: `doctor` (Feld `schemaAudit`, Zusammenfassung im Terminal), Report-Datei des Proxys (`schema_audit`) und Abschnitt «Schnittstellen- & Schema-Prüfung (MCP-Tools)» im Klartext-Bericht.
- Neu in der Report-Datei, alle optional (bestehende Felder unverändert): `report.observations_de` (Beobachtungen auf Deutsch, die englischen bleiben), `recommended_prompt_patch_de` (deutscher Prompt-Baustein mit den Tool-Namen des Servers), `schema_audit`. Der Klartext-Bericht zeigt den deutschen Baustein und die englischen Originale getrennt beschriftet und die Beobachtungen auf Deutsch statt als „Originaltext des Harness“.
- Oberfläche: «Agent anschliessen» statt «anschließen» (Schweizer Rechtschreibung).

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
