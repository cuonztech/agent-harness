# Changelog

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
