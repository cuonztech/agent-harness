# Changelog

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
