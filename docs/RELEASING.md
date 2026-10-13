# Releases und MCP Registry

Das npm-Paket heisst `cuonztech-agent-harness`. Der vorgesehene Registry-Name ist
`io.github.cuonztech/agent-harness`. Eine npm-Veröffentlichung allein erzeugt keinen
Registry-Eintrag.

## Release vorbereiten

1. `package.json`, `package-lock.json` sowie `server.json` auf dieselbe neue Version
   setzen. `package.json.mcpName` muss `server.json.name` entsprechen.
2. `npm run lint` und `npm test` ausführen. `npm test` baut das Paket vor den Tests.
3. Mit `npm pack` den tatsächlichen Release-Tarball erstellen. Dateiliste und
   Integrität festhalten; interne Dokumente und Zugangsdaten dürfen nicht enthalten sein.
4. Diesen Tarball in einem leeren Verzeichnis installieren und prüfen. Das
   unabhängige Release-Gate umfasst einen selbst geschriebenen Test-Upstream mit
   Ausführungsjournal, F1–F5, CLI-Grenzen, Audit-Datenlecks und echte LLM-Läufe mit
   und ohne den tatsächlich ausgegebenen Patch. Mindestens zehn Läufe je Bedingung.
   Ergebnisse und offene Befunde vor dem Publish dokumentieren.
5. `server.json` gegen das referenzierte offizielle JSON-Schema validieren. Diese
   Prüfung ersetzt nicht die Eigentums- und Paketprüfung durch das Registry.

Nach Änderungen am getesteten Paket einen neuen Tarball erzeugen und die
betroffenen Prüfungen erneut durchführen. Veröffentlicht wird der geprüfte Tarball.

## Veröffentlichen

1. npm-Anmeldung mit `npm whoami` prüfen; gegebenenfalls `npm login --browser=false` ausführen.
   Browser-Anmeldung allein ist keine Freigabe der CLI.
2. Nach bestandenem Gate `npm publish <geprüfter-tarball.tgz> --access public --browser=false`
   ausführen. Eine gegebenenfalls verlangte zweite Authentifizierung über den
   ausgegebenen Link abschliessen. `--browser=false` vermeidet einen Abbruch,
   wenn die Umgebung keinen automatischen Browserstart erlaubt.
3. Mit `npm view cuonztech-agent-harness@<version> version mcpName dist.integrity --json`
   Version, Registry-Namen und Übereinstimmung mit der geprüften Integrität bestätigen.
   npm kann den Publish zunächst mit HTTP 202 annehmen, während die Version noch
   nicht abrufbar ist. Die automatische Prüfung dauert typischerweise einige Minuten.
   In diesem Fall nicht erneut veröffentlichen, sondern die Verfügbarkeit abwarten.
4. Mit dem offiziellen `mcp-publisher login github` beim Registry anmelden und
   `mcp-publisher publish server.json` ausführen. Das GitHub-Konto muss den
   Namespace kontrollieren. Zugangsdaten niemals in Git oder Release-Logs ablegen.
5. Den Eintrag über die Registry-API suchen und Name, Version und Paket prüfen.
6. Die veröffentlichte npm-Version erneut in einem leeren Verzeichnis installieren;
   CLI-Version, Benchmark sowie MCP-Initialisierung und Tool-Liste prüfen.

Publisher v1.8.1 speichert seine Anmeldung unter `~/.config/mcp-publisher/token.json`.
Ist dieser Pfad nicht beschreibbar, kann die Browser-Freigabe erfolgreich sein,
während der CLI-Login dennoch scheitert. Erst die erfolgreiche Speicherung
schliesst die Anmeldung ab. Der lokale Release-Nachweis muss einen gegebenenfalls
verwendeten alternativen API-Ablauf dokumentieren.

## Bedeutung des Registry-Starts

Die Paketkonfiguration startet den Demo-MCP über stdio. Sie misst damit noch keinen
Kundenagenten. Eine echte Messung benötigt den in der README beschriebenen
Proxy-Modus mit einem ausdrücklich konfigurierten Test-Upstream. Der Registry-Eintrag
ist ein Verzeichniseintrag und kein Prüfzertifikat.

## Nachweis und Pflege

Im internen Projektstand Datum, Version, Tarball-Hash, Testbericht, öffentliche
Links, Resultate der Live-Prüfungen und verbleibende Einschränkungen festhalten.
Öffentliche Release-Notizen enthalten die Änderungen und relevanten Grenzen,
keine Kunden-, Geschäfts- oder Zugangsdaten.

Quellen:

- [Offizieller Registry-Quickstart](https://modelcontextprotocol.io/registry/quickstart)
- [Publisher v1.8.1: Anmeldung und Konfigurationspfad](https://github.com/modelcontextprotocol/registry/blob/v1.8.1/cmd/publisher/commands/login.go)
- [npm: Verzögerung durch Publish-Prüfung](https://github.blog/changelog/2026-07-28-npm-publish-time-malware-scanning-and-dual-use-metadata/)
