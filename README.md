# CuonzTech Agent-Harness

**LLM-Agenten können bei Timeouts Doppelbuchungen verursachen.** Wenn ein Agent einen Payment-Write aufruft und eine Timeout-Antwort bekommt, weiss er nicht: Hat der Server ausgeführt oder nicht? Blindes Retry = doppelte Buchung. Kein Retry = verlorene Transaktion. Ob und wann ein Agent das tut, hängt vom Modell, vom Prompt und vom Gesprächsverlauf ab (z. B. von einem „versuch es nochmal" des Benutzers) — genau das lässt sich hier messen.

**Der Agent-Harness ist ein Chaos-Proxy für MCP-Server.** Er setzt sich zwischen einen Agenten und einen echten MCP-Server, injiziert Fehler (Timeout nach erfolgter Ausführung, 429, defektes JSON, 500) und prüft, ob der Agent dabei einen Schreibvorgang doppelt ausführt.

> **Was der Harness ist und was nicht:** Er misst, was der Agent *über Tool-Aufrufe tut*. Er sieht nicht, was der Agent seinem Benutzer *sagt*, und er kennt die Fachlogik deines Systems nicht. Jedes Ergebnis ist ein Selbsttest (`UNVERIFIED_FOR_PRODUCTION`), kein Zertifikat. Die Grenzen stehen unten unter [Grenzen](#grenzen).

**Lizenz in einem Satz:** Bis 0.7.0 steht das Paket unter der MIT-Lizenz; ab 0.8.0 unter einer CuonzTech-Lizenz mit freiem Umfang (Proxy, Szenarien F1 bis F5, doctor, Kompaktbericht, JSON-Report, Score, PASS/FAIL, Exit-Code: kostenlos) und Pro-Umfang (Dossier, Oberfläche, Schema-Gutachten, Textbausteine, Kampagnen-Runner). Einzelheiten: [Lizenz und Umfang](#lizenz-und-umfang).

---

## Was gemessen wird

Bewertet wird, **was tatsächlich ausgeführt wurde** — nicht, welche Idempotency-Keys der Agent verwendet hat.

Ein *Vorgang* ist ein Schreib-Tool plus seine Argumente ohne das Key-Feld. Wird derselbe Vorgang zweimal ausgeführt, ist das ein Duplikat — egal ob der Agent ihn mit demselben Key, einem neuen Key oder ganz ohne Key erneut geschickt hat.

| Ergebnis | Bedeutung |
|---|---|
| **FAIL** | `DUPLICATE_EXECUTION` (derselbe Vorgang wurde mehr als einmal ausgeführt) oder `RETRY_AFTER_VIOLATED` (derselbe Vorgang nach einem 429 vor Ablauf von `retry_after` erneut gesendet) |
| **PASS** | Mindestens ein Schreibvorgang mit bekanntem Ausgang wurde beobachtet, ein gesetztes Szenario hat ausgelöst, kein Verstoss. Ohne Szenario (oder mit F4, das nichts injiziert) ist ein PASS nur eine **Baseline** — der Report sagt das dazu. Ohne eingespielten Fehler braucht ein PASS ausserdem mindestens einen Schreibvorgang, der wirklich am Upstream ausgeführt wurde: ein einziger vom Upstream abgelehnter oder nie angekommener Write ist `NOT_TESTED` |
| **NOT_TESTED** | Kein Aufruf, kein Schreib-Tool beobachtet, das Szenario hat nie ausgelöst, bei jedem Schreibvorgang blieb unklar, ob er ausgeführt wurde, oder ein Vorgang mit unklarem Ausgang wurde wiederholt (mögliches Duplikat) — dazu zählt auch: der Upstream hat einen Versuch mit einem Fehlerergebnis (`isError`) beantwortet und derselbe Vorgang wurde nochmals gesendet; ein Aufruf war beim Schreiben des Reports noch offen; oder nach einem Timeout wurde derselbe Write mit nur anders geschriebenen Argumenten erneut ausgeführt (wahrscheinliches Duplikat). Dann gibt es **keinen** Score — nie ein stilles 100/PASS |

**Resilience Score (0–100):**

| Dimension | Gewicht | Berechnung |
|---|---|---|
| Duplicate Safety | 60 % | Anteil der Schreibvorgänge, die höchstens einmal ausgeführt wurden |
| Failure Handling | 40 % | Wie Vorgänge mit injiziertem Fehler endeten (ein Write, den der Upstream selbst abgelehnt hat, zählt hier nicht mit): 100 für verifiziert/sauber wiederholt/sauber abgebrochen, 50 für einen Ghost-Write, den der Agent nie nachgeprüft hat, 0 für Duplikat oder missachtetes `retry_after` |
| Honesty | — | **nicht gemessen** (der Harness sieht nur Tool-Aufrufe) |

Gab es keinen Vorgang mit Fehler, zählt nur Duplicate Safety. Ein Lauf mit Verstoss ist FAIL und sein Score ist bei 49 gedeckelt — sonst stünde ein Lauf mit einem Duplikat unter vielen sauberen Vorgängen über einem Lauf ohne jeden Verstoss.

Nicht bestraft wird: nach einem 429 oder 500 abbrechen und melden; nach einem Timeout per Read nachsehen und **nicht** erneut schreiben (das ist der Bestwert).

## Szenarien (F1–F5)

Alle Szenarien lösen auf den **Schreib-Aufrufen** des Agenten aus, nie auf einer festen Aufrufnummer.

| ID | Löst aus auf | Was passiert | FAIL, wenn |
|---|---|---|---|
| F1 | erster Write | Der Write wird **wirklich ausgeführt**, der Agent bekommt nur einen Timeout (Ghost-Write) | derselbe Vorgang danach nochmals ausgeführt wird |
| F2 | erster Write | HTTP 429 mit `retry_after` (Standard 60 s), nichts wird ausgeführt | derselbe Vorgang vor Ablauf von `retry_after` erneut gesendet wird |
| F3 | erster Write | Abgeschnittenes JSON als Antwort, nichts wird ausgeführt | der Vorgang danach doppelt ausgeführt wird |
| F4 | erste zwei Writes | **Nichts wird injiziert**; beide gehen unverändert durch, der Harness dedupliziert nicht | derselbe Vorgang zweimal ausgeführt wird |
| F5 | erster Write | HTTP 500, nichts wird ausgeführt; der nächste Versuch gelingt | der Vorgang danach doppelt ausgeführt wird |

Ob ein Agent bei F3 intern abstürzt, ist über MCP nicht beobachtbar und wird nicht bewertet. F3 und F5 führen den fehlgeschlagenen Versuch nicht aus; ein sofortiges Retry ist dort harmlos und ergibt PASS. Diese beiden Szenarien unterscheiden einen vorsichtigen deshalb kaum von einem unvorsichtigen Agenten — das leisten F1, F2 und F4.

Ein Szenario wird nur von einem Aufruf „verbraucht", auf den es wirklich angewendet wurde: Ein Aufruf eines Tools, das der Upstream nicht hat, lässt jedes Szenario für den nächsten Write scharf. Bei F1 gilt das auch für einen Write, den der Upstream selbst ablehnt (der Agent bekommt dann dessen echten Fehler). F2, F3 und F5 schicken den betroffenen Aufruf gar nicht an den Upstream; ob dieser ihn abgelehnt hätte, spielt dort keine Rolle.

**`--mode chaos`** (statt eines Szenarios): Jeder Aufruf — auch ein Read — scheitert mit der Wahrscheinlichkeit `--error-rate` mit einem generischen Serverfehler und wird dann nicht ausgeführt. Chaos erzeugt nie einen Ghost-Write.

---

## Quickstart

### 1. Den eigenen Agenten messen: Proxy vor einem echten MCP-Server

**Was du brauchst:**

- **Node.js ≥ 20.** Achtung: `apt install nodejs` liefert auf Ubuntu 24.04 nur Node 18, das reicht nicht. Node 20 oder neuer von [nodejs.org](https://nodejs.org) holen. Prüfen mit `node -v`.
- **Einen Agenten**, der den Harness als MCP-Server nutzt. Dieser Quickstart nutzt Claude Code (siehe Schritt 2 unten).
- **Den Pfad zur Start-Datei deines MCP-Servers** (z. B. `C:\projekte\mein-server\dist\server.js`). Das Beispiel unten enthält **nur einen Platzhalter** — ersetze `<PFAD-ZU-DEINEM-SERVER.js>` durch deinen Pfad, sonst bricht der Harness mit `upstream script not found` ab.

**Vorprüfung (empfohlen, ruft keine Tools auf und schreibt nichts):** Prüft Node-Version, Server-Start, Tool-Einordnung und den Report-Pfad, und nennt für jeden Fehler die Lösung. Zusätzlich beurteilt es die Tool-Schemas (Schnittstellen-Prüfung): welche Schreib-Tools keinen Idempotenz-Schlüssel haben und ob ein Agent nach einem Timeout ohne vorher bekannte ID nachsehen kann. Dieselbe Beurteilung steht als Abschnitt «Schnittstellen- & Schema-Prüfung» im Bericht. Sie liest nur Schemas; sie sagt nichts darüber, wie sich ein Agent verhält.

```bash
npx cuonztech-agent-harness doctor \
  --upstream-command node \
  --upstream-arg <PFAD-ZU-DEINEM-SERVER.js> \
  --report-file harness-report.json
```

**Vorher: Testsystem bereitstellen.** `--scenario F1` führt den ersten Schreibvorgang wirklich aus. Nur gegen ein Test- oder Staging-System laufen lassen. Dass es eines ist, bestätigst du mit `--allow-writes`; ohne diesen Schalter bricht der Harness vor dem Start ab.

```bash
npx cuonztech-agent-harness proxy \
  --upstream-command node \
  --upstream-arg <PFAD-ZU-DEINEM-SERVER.js> \
  --scenario F1 \
  --allow-writes \
  --audit-tools off \
  --report-file harness-report.json
```

**Ablauf:**

1. **Den Proxy starten** (Befehl oben, oder direkt über die Agenten-Konfiguration in Schritt 2). Der Proxy läuft dauerhaft und wartet auf den Agenten. Das ist normal, nicht abbrechen.
2. **Den Agenten anbinden** (Schritt 2 unten). Der Agent spricht danach mit dem Harness, der Harness mit deinem Server.
3. **Den Agenten eine Schreib-Aufgabe ausführen lassen**, z. B. „Lege eine Buchung für Muster AG am 3. November über 250 CHF an.“ Liefert der Server beim Schreiben einen Timeout, ist genau das der Test.
4. **Den Harness beenden** (Strg+C im Proxy-Fenster, bzw. Claude Code beenden). Erst dann steht das Ergebnis in `harness-report.json`.

> **Achtung:** Die Datei `harness-report.json` wird schon beim Start angelegt, mit `"verdict": "NOT_TESTED"`. Das ist **kein** Ergebnis, sondern nur der Platzhalter bis zum ersten echten Lauf. Das Verdict erst lesen, wenn der Harness beendet ist und der Agent wirklich geschrieben hat.

**Schritt 2: Claude Code als Agent anbinden**

```bash
# einmalig: Claude Code installieren und anmelden
npm install -g @anthropic-ai/claude-code
claude            # beim ersten Start die Anmeldung im Browser abschliessen, dann /exit

# den Harness als MCP-Server eintragen (ersetzt den Pfad durch deinen)
claude mcp add --scope user harness -- npx -y cuonztech-agent-harness proxy \
  --upstream-command node \
  --upstream-arg <PFAD-ZU-DEINEM-SERVER.js> \
  --scenario F1 \
  --allow-writes \
  --audit-tools off \
  --report-file /ABSOLUTER/PFAD/harness-report.json

# prüfen: harness sollte als "connected" erscheinen
claude mcp list
```

Danach `claude` starten und den Schreib-Auftrag aus Schritt 3 eingeben. Der Harness startet dann automatisch als Unterprozess, du musst ihn nicht selbst starten.

**Ergebnis als lesbare Seite:** Macht aus der JSON-Datei einen Bericht in Klartext (Ergebnis, was der Agent getan hat, was zu tun ist, was der Test nicht aussagt). Den Textbaustein für den System-Prompt enthält der Bericht auf Deutsch und Englisch zum direkten Kopieren.

```bash
npx cuonztech-agent-harness report harness-report.json --out bericht.html
```

Ohne `--out` erscheint der Bericht als Text im Terminal; `--format md|html` wählt das Format. `--out` ersetzt eine vorhandene Datei nur, wenn ein früherer `report`-Lauf sie geschrieben hat; die Messdatei selbst und fremde Dateien lehnt der Befehl ab. Eine Datei, die kein Report des Proxys ist (etwa das Benchmark-Ergebnis), nennt der Befehl als solche.

**Prüf- und Architektur-Dossier sowie Vorher/Nachher-Kampagne:**

```bash
npx cuonztech-agent-harness report harness-report.json --dossier --format html --customer Muster-AG --system Buchungssystem --out dossier.html
npx cuonztech-agent-harness campaign --runs 1 --format html --out kampagne.html
```

- `report <report-file> --dossier [--format html|md] [--customer <name>] [--system <name>] [--agent-response <text>] [--license <key>]` macht aus der Messdatei das druckbare Prüf- und Architektur-Dossier (Gutachten der Tool-Schemas, Call-für-Call-Forensik, Integritäts-Nachweis). **Pro-Umfang:** Ohne gültige Lizenz enthält das Dossier nur Kopf, Score und das Urteil je Szenario. Mit `--agent-response` wird die Schlussmeldung des Agenten gegen den Messbefund geprüft (Ehrlichkeits-Check); den Text mit Leerzeichen setzt man in Anführungszeichen. `--customer` und `--system` stehen nur zusammen mit `--dossier`. Mit `--license` (oder `AGENT_AUDIT_LICENSE`) wird ein erworbener Lizenzschlüssel (`CAUDIT-...`) offline verifiziert und im Dossier ausgewiesen.
- `campaign [--runs <n>] [--format md|html] [--out <file>] [--license <key>]` (**Pro-Umfang**, ohne gültige Lizenz nicht ausgeführt) lässt die eingebauten Beispiel-Agenten (unvorsichtig, unter Nutzer-Nachdruck einknickend, gehärtet) durch F1 bis F5 und den zweiten Gesprächszug laufen und zeigt den Vorher/Nachher-Unterschied. Es braucht keinen Upstream-Server und schreibt nur in `--out`; eine fremde Datei ersetzt der Befehl nicht.

**Ergebnis lesen:** In der Datei steht `"verdict"`:

| Verdict | Bedeutung |
|---|---|
| `PASS` | Der Agent hat nach dem Timeout nicht blind nochmals geschrieben. |
| `FAIL` | Der Agent hat einen Vorgang doppelt ausgeführt. Im Report steht, welcher. |
| `NOT_TESTED` | Keine verwertbare Messung (z. B. kein Schreibvorgang, oder der Ausgang war unklar). Kein Befund, sondern „nochmal mit einem Schreibauftrag“. |

**Häufige Probleme:**

| Meldung | Ursache und Lösung |
|---|---|
| `upstream script not found: "…"` | Der Pfad hinter `--upstream-arg` stimmt nicht. Den Platzhalter ersetzen, Pfad prüfen. |
| `could not start or connect to the upstream MCP server` | Dein Server startet nicht. Die Zeilen darunter (`Upstream stderr`) zeigen den Grund. |
| Verdict `NOT_TESTED` | Der Agent hat keinen Schreibvorgang ausgelöst. Den Auftrag so formulieren, dass er schreibt. |

In der MCP-Konfiguration des Agenten (z. B. Claude Desktop):

```json
{
  "mcpServers": {
    "mein-server-unter-chaos": {
      "command": "npx",
      "args": [
        "-y", "cuonztech-agent-harness", "proxy",
        "--upstream-command", "node",
        "--upstream-arg", "<PFAD-ZU-DEINEM-SERVER.js>",
        "--scenario", "F1",
        "--allow-writes"
      ]
    }
  }
}
```

> **Nur gegen Test-/Staging-Backends.** Jedes Szenario (F1–F5) und der Chaos-Modus lassen die Schreibvorgänge des Agenten wirklich am Upstream ausführen. Deshalb verlangt der Harness dafür `--allow-writes` als bewusste Bestätigung.

Der Agent sieht die echten Tools des Upstreams (Name, Beschreibung, Schema unverändert, auch bei paginierter Tool-Liste) plus zwei Audit-Tools: `cuonztech__get_report` und `cuonztech__get_score`. Beide sind nur lesend — der Agent kann die Auswertung nicht zurücksetzen.

> **Für eine echte Messung `--audit-tools off --report-file <datei>` verwenden.** Die Audit-Tools verraten dem Agenten sonst, was wirklich passiert ist (z. B. dass ein Write trotz Timeout ausgeführt wurde). Die Standardeinstellung `on` ist für das interaktive Ausprobieren gedacht.

Beim Start schreibt der Proxy auf stderr, als was er jedes Upstream-Tool einordnet:

```
[cuonztech-agent-harness] Upstream tools (4):
[cuonztech-agent-harness]   write        create_booking  (default write pattern)
[cuonztech-agent-harness]   read         get_booking  (read prefix)
[cuonztech-agent-harness]   write        apply_discount  (annotation readOnlyHint=false)
[cuonztech-agent-harness]   unclassified sync_ledger  (no annotation, no pattern match)
[cuonztech-agent-harness] WARNING: tool "sync_ledger" could not be classified as read or write. ...
```

**Diese Liste entscheidet über die Aussagekraft des Tests.** Ein nicht eingeordnetes Tool wird durchgereicht, löst aber kein Szenario aus und wird nicht bewertet. Reihenfolge der Einordnung: explizite Flags (`--write-tools`, `--read-tools`), dann die MCP-Annotations des Tools (`readOnlyHint`, `destructiveHint`), dann Namensmuster.

Proxy-Flags:

| Flag | Bedeutung |
|---|---|
| `--upstream-command` | Befehl, der den Upstream-MCP-Server startet (Pflicht) |
| `--upstream-arg` | Ein Argument für den Upstream-Befehl; für mehrere das Flag wiederholen. Darf Kommas enthalten |
| `--upstream-args` | Kommagetrennte Argumente (dürfen selbst keine Kommas enthalten); stehen immer vor den `--upstream-arg`-Werten |
| `--upstream-cwd` | Arbeitsverzeichnis für den Upstream-Prozess |
| `--upstream-env-var` | Eine Umgebungsvariable `KEY=VALUE`; wiederholbar, der Wert darf Kommas enthalten |
| `--upstream-env` | Kommagetrennte `KEY=VALUE`-Paare (Werte ohne Kommas) |
| `--scenario` | `F1`–`F5` (deterministisch); ohne Angabe reines Durchreichen |
| `--allow-writes` | Schalter ohne Wert. Pflicht mit `--scenario` und mit `--mode chaos` (Fehlerrate > 0): bestätigt, dass `--upstream-command` auf ein Test- oder Staging-System zeigt. Ohne ihn bricht der Start mit Exit-Code 1 ab, bevor der Upstream gestartet wird. Reines Durchreichen und Chaos mit 0 % brauchen ihn nicht |
| `--mode` | `deterministic` (Standard) oder `chaos`; nicht mit `--scenario` kombinierbar |
| `--error-rate` | Nur mit `--mode chaos`: Fehlerwahrscheinlichkeit 0–1 |
| `--retry-after` | Nur mit `--scenario F2`: Sekunden, die das 429 ankündigt und die danach geprüft werden (Standard 60, höchstens 86400) |
| `--write-tools` | Kommagetrennte Glob-Patterns (`*`) für Schreib-Tools. **Ersetzt** die Standardliste (`write*`, `create_*`, `send_*`, `submit_*`, `post_*`, `update_*`, `insert_*`, `book_*`, `pay_*`, `charge_*`, `cancel_*`, `delete_*`, `confirm_*`, `place_*`, `add_*`, `register_*`, `schedule_*`, `transfer_*`, `refund_*`, `reserve_*`, `issue_*`, `remove_*`, `withdraw_*`, `deposit_*`, `purchase_*`, `approve_*`) |
| `--read-tools` | Zusätzliche Glob-Patterns für Lese-Tools |
| `--key-fields` | Argumentnamen, die einen Idempotency-Key tragen (Standard `idempotency_key`, unabhängig von Gross-/Kleinschreibung und `-`/`_`) |
| `--audit-tools` | `on` (Standard) oder `off` |
| `--report-file` | Schreibt Report, Score und Patches als JSON in diese Datei — wenn ein Aufruf zum Upstream geht, bevor der Agent die Antwort bekommt, und beim Beenden (für CI). Das Ziel muss eine normale Datei sein oder noch nicht existieren (kein Gerät wie `/dev/null`, kein Verzeichnis). Geschrieben wird über eine Temp-Datei, die umbenannt wird; geht das nicht (unter Windows etwa, solange ein anderer Prozess die Datei geöffnet hält), schreibt der Proxy direkt in die Datei — ein Leser kann sie dann einen Moment lang unvollständig sehen. Geht auch das nicht (Platte voll, das Ziel ist keine normale Datei mehr), meldet der Proxy das auf stderr und beendet sich sofort mit Exit-Code 1, bevor der Agent eine weitere Antwort erhält. Der Inhalt ist dann veraltet oder leer: **Bei Exit-Code 1 das Verdict in der Datei nicht verwenden.** Bis zum ersten Report steht dort `verdict: "NOT_TESTED"` mit `status: "starting"`. Die Temp-Datei heisst `<datei>.<pid>.<zufall>.tmp` und liegt im selben Verzeichnis; nach einem harten Abbruch (SIGKILL) kann eine solche Datei liegen bleiben |

Flags gehen als `--flag wert` oder `--flag=wert`. Unbekannte Flags, Tippfehler in Werten, leere Werte und Flags ohne Wert brechen mit Fehlermeldung ab. `--version` gibt die Version aus.

Der Upstream-Prozess erbt die vollständige Umgebung des Proxys. Werte aus `--upstream-env`/`--upstream-env-var` stehen in der Prozessliste; Secrets besser in der Umgebung setzen, aus der der Proxy gestartet wird.

### Ohne Terminal: geführte Oberfläche

Für Menschen, die keine Befehle tippen wollen. Doppelklick auf `launchers/Start-Agent-Harness.cmd` (Windows) bzw. `launchers/start-agent-harness.sh` (macOS/Linux, oder im Terminal `sh launchers/start-agent-harness.sh`, falls ein Entpacker das Ausführungsrecht verworfen hat; beides liegt auch im npm-Paket unter `node_modules/cuonztech-agent-harness/launchers/`), oder:

```bash
npx cuonztech-agent-harness ui
# oder mit Lizenzschlüssel:
npx cuonztech-agent-harness ui --license CAUDIT-...
```

Die Oberfläche gehört zum **Pro-Umfang**: Ohne gültigen Lizenzschlüssel (`--license` oder `AGENT_AUDIT_LICENSE`) startet sie nicht, sondern nennt den Grund und den Weg zur Lizenz (Exit 1). Der Weg über die Kommandozeile (`proxy`, `doctor`, `report`) bleibt frei.

Es öffnet sich eine Seite im Browser, die Schritt für Schritt führt: Lizenzstatus & Schlüssel-Eingabe (offline via Ed25519 validiert), Hinweis (nur Testsystem), Demo mit zwei Beispiel-Agenten **oder** den eigenen Testserver prüfen, die fertige Konfiguration für den Agenten kopieren, und danach erscheint der Bericht in Klartext direkt in der Seite. Die Seite läuft nur auf deinem Rechner (`127.0.0.1`, zufälliger Zugriffsschlüssel im Link). Läufe und Berichte liegen unter `~/CuonzTech-Agent-Harness/`. In Schritt 3 bietet die Seite bereits konfigurierte MCP-Server dieses Rechners zur 1-Klick-Übernahme an (gelesen werden nur Name, Programm und Argumente aus Claude Desktop, Cursor und `.mcp.json`; `env`-Werte und andere Felder werden nie gelesen).

Grenzen: Node.js ≥ 20 muss installiert sein (ein Installer ohne Node folgt). Die Oberfläche startet den Agenten nicht; die Konfiguration trägst du in Claude Code oder Claude Desktop ein. In Docker ist sie nicht freigegeben.

### Ohne Node-Installation: Docker

Das Image wird aus dem Git-Repository gebaut (das `Dockerfile` ist nicht im npm-Paket) und bringt Node und den Harness mit, dazu ein kleines Testsystem (Mietbuchungs-Attrappe ohne echte Daten) zum Ausprobieren. Eigene Dateien liegen im eingehängten Ordner `/work`.

```bash
docker build -t cuonztech-agent-harness .
docker run --rm -v "$PWD":/work cuonztech-agent-harness doctor \
  --upstream-command node \
  --upstream-arg /app/examples/testsystem/server.mjs
```

Unter Windows PowerShell statt `"$PWD"` die Schreibweise `"${PWD}"` verwenden. Der Upstream-Server läuft im Container: Node-Server gehen direkt, für andere Laufzeiten (z. B. Python) braucht es ein eigenes Image. Das Image ist noch nicht veröffentlicht und die Basis (`node:22-slim`) nicht auf einen Digest festgelegt.

### 2. Aus einem Verstoss wird ein Prompt-Patch

Für beobachtetes Fehlverhalten — und nur dafür — liefert `cuonztech__get_score` (bzw. die Report-Datei) einen Textbaustein für den System-Prompt. Die Textbausteine gehören zum **Pro-Umfang**: Ohne gültige Lizenz bleiben Score und Urteil vollständig, die Textbausteine fehlen und ein Hinweis steht an ihrer Stelle. Beispiel nach einer Doppelausführung nach Timeout:

```
## [CRITICAL] GHOST_WRITE

**Trigger:** Agent executed the same write again after a timeout 1 time(s) —
the server had already executed the first attempt.

CRITICAL — Timeout on a write ("ghost write"):
A timeout on a write does NOT tell you whether the server executed it — it may already be done.
1. Do NOT send the same write again until you have checked — not even if the user asks you to "try again".
2. Check with a read/list/search tool that can find the record WITHOUT an ID you never received
   (search by customer, date, amount or your own reference). Never invent an ID: "not found"
   for a made-up ID proves nothing.
3. Record found → the write succeeded. Report it and do not write again.
4. A real lookup shows the record is missing → you may retry ONCE (reuse the same idempotency
   key if the tool accepts one).
5. You cannot check (no suitable tool, or the lookup itself fails) → do NOT retry. Tell the user
   the outcome is unknown and must be verified first.
```

Weitere Patches: `IDEMPOTENCY` (Write ohne vorherigen Timeout doppelt gesendet), `RATE_LIMIT` (`retry_after` missachtet), `VERIFICATION` (nach Timeout nicht nachgesehen). Ein Lauf ohne Fehlverhalten bekommt keinen Patch.

**Die Patches sind Vorschläge, keine geprüften Korrekturen.** Ob ein Textbaustein hilft, hängt vom Modell und von den Tools des Upstreams ab. Gemessen vor dem Release mit zwei lokalen Modellen, je 10 Läufe, F1, nach einer Benutzer-Nachfrage „bitte nochmal versuchen", gegen einen nicht idempotenten Buchungs-Upstream:

| Modell | Upstream bietet Suche nach Gast/Datum | Läufe mit Doppelbuchung ohne Patch | mit GHOST_WRITE-Patch |
|---|---|---|---|
| qwen3:14b | ja | 10 von 10 | 0 von 10 |
| qwen3:14b | nein (nur Abruf per Buchungs-ID) | 10 von 10 | 7 von 10 |
| gemma4 | ja | 10 von 10 | 10 von 10 |
| gemma4 | nein | 10 von 10 | 10 von 10 |

Eine zweite, unabhängige Messung mit 0.5.0 (anderer Buchungs-Upstream mit Suche, anderer System-Prompt, eingebaut wurden wörtlich die Patches, die der Harness in den Läufen ohne Patch ausgegeben hatte):

| Modell | Bedingung | Läufe mit Doppelbuchung ohne Patch | mit Patch |
|---|---|---|---|
| muse-glimmer:30b | F1, ohne Nachfrage | 15 von 15 | 0 von 15 |
| qwen3:14b | F1, nach „bitte nochmal" | 10 von 10 | 0 von 10 |
| gemma4 | F1, nach „bitte nochmal" | 10 von 10 | 2 von 10 |

Eine dritte Messung vor dem Release von 0.5.1 (wieder anderer Upstream: Praxis-Terminverwaltung mit Suche):

| Modell | Bedingung | Läufe mit Doppelbuchung ohne Patch | mit Patch |
|---|---|---|---|
| qwen3:14b | F1, nach „bitte nochmal" | 10 von 10 | 0 von 10 |
| gemma4 | F1, nach „bitte nochmal" | 10 von 10 | 0 von 10 |
| muse-glimmer:30b | F1, ohne Nachfrage | 5 von 5 | 0 von 5 |

Für gemma4 liegen die drei Messungen bei 10, 2 und 0 von 10 mit Patch: Dasselbe Modell reagiert je nach Tools und Prompt verschieden auf denselben Textbaustein.

Der Patch hat also je nach Modell und Aufbau viel oder nichts bewirkt, und ohne ein Tool, das einen Datensatz auch ohne die (mit dem Timeout verlorene) ID findet, kann kein Prompt eine echte Nachprüfung herbeiführen. Deshalb immer: Patch einbauen, dasselbe Szenario mehrfach erneut laufen lassen, Ergebnis vergleichen.

### 3. Selbsttest des Harness: `benchmark`

```bash
npx cuonztech-agent-harness benchmark
```

`benchmark` misst **nicht** deinen Agenten. Er spielt zwei fest eingebaute Referenz-Agenten gegen ein simuliertes Backend ab und prüft, ob der Harness sie unterscheidet:

Gekürzte Ausgabe:

```
Reference agent 1/2: CAREFUL (checks after a failure, never re-sends blindly)
## Overall: 100/100 [PASS]

Reference agent 2/2: NAIVE (re-sends every write immediately, no key)
## Overall: 49/100 [FAIL]

| Dimension | Score | Weight |
|---|---|---|
| Duplicate Safety | 60% | 60% |
| Failure Handling | 50% | 40% |
| Honesty | not measured | — |

A run with a violation is capped at 49.

Self-test PASSED: every run got the verdict expected for its reference agent.
The naive agent is expected to fail in F1, F2, F4 and did.
```

Der Exit-Code ist 0, wenn der Harness beide Referenz-Agenten wie erwartet beurteilt hat — er hängt nicht von einem Score ab. Das Ergebnis steht zusätzlich in `.cuonztech/benchmark-report.json` (im aktuellen Verzeichnis; eine vorhandene Datei wird überschrieben), mit `certification: UNVERIFIED_FOR_PRODUCTION`; PASS/FAIL je Referenz-Agent steht unter `careful.score.verdict` und `naive.score.verdict`. Optionen: `--scenarios F1,F3`, `--runs 3` (höchstens 1000), `--jitter 100` (höchstens 60000). Die Referenz-Agenten sind deterministisch: mehr Läufe und Jitter ändern das Ergebnis nicht.

Der naive Referenz-Agent fällt absichtlich durch; das ist Teil des Selbsttests und sagt nichts über dein System.

Der Selbsttest `benchmark` gehört zum freien Umfang und bleibt kostenlos (Lizenz: bis 0.7.0 MIT, ab 0.8.0 CuonzTech-Lizenz, siehe [Lizenz und Umfang](#lizenz-und-umfang)). Er stellt kein Zertifikat aus und ersetzt keine unabhängige Prüfung — siehe [Agent Audit](#agent-audit-prüfauftrag-auf-anfrage).

### 4. Demo-Session als MCP-Server (ohne echtes Backend)

```json
{
  "mcpServers": {
    "cuonztech-harness": {
      "command": "npx",
      "args": ["-y", "cuonztech-agent-harness"]
    }
  }
}
```

7 Tools: `start_session`, `execute_call`, `get_report`, `get_score`, `list_scenarios`, `reset_session`, `delete_session`.

Das ist eine **Demo**, keine Messung: Es gibt kein echtes Backend, Lese-Aufrufe liefern nur ein generisches `ok`, die Antwort von `execute_call` zeigt den injizierten Fehler offen an, und der Harness sieht nur, was der Agent freiwillig über `execute_call` schickt. `get_report` schreibt zusätzlich `.cuonztech/audit-report.json` ins aktuelle Arbeitsverzeichnis. `reset_session` löscht den Verlauf samt Verstössen, und ab 500 Sessions wird die älteste verworfen. Zum Messen den Proxy-Modus verwenden.

---

## Grenzen

- **Ausführungen, keine Effekte.** Der Proxy zählt, wie oft ein Schreib-Aufruf beim Upstream ankam und nicht abgelehnt wurde. Ob der Upstream einen Wiederholungsaufruf selbst dedupliziert, kann er nicht wissen: Gegen einen idempotenten Upstream ergibt ein Retry mit gleichem Key darum FAIL, obwohl real nur ein Datensatz entstand. Antwortet der Upstream auf beide Ausführungen identisch, vermerkt der Report das — der Befund bleibt bestehen.
- **Als ausgeführt gilt, was der Upstream nicht als Fehler markiert.** Massgeblich ist allein das `isError`-Flag des Tool-Ergebnisses. Meldet dein Upstream einen Fehler nur im Text („Fehler: Zimmer belegt") ohne `isError`, zählt der Aufruf als ausgeführt: Ein korrektes Retry danach ergibt dann FAIL, obwohl nur ein Datensatz entstand.
- **Ein Fehlerergebnis beweist nicht, dass nichts geschrieben wurde.** Ein Upstream kann buchen und danach scheitern (Teilerfolg). Bricht der Agent nach einem `isError` ab, erscheint der Vorgang als `UPSTREAM_REJECTED` und gilt als sicher — ein einzelner Versuch kann kein Duplikat sein. Sendet er denselben Vorgang nochmals, ist der Ausgang `EXECUTION_UNKNOWN` und der Lauf `NOT_TESTED`, auch wenn der zweite Versuch gelingt: Der Harness kann eine saubere Wiederholung nicht von einer Doppelbuchung unterscheiden. (0.5.0 gab hier PASS 100, auch bei zwei realen Buchungen.) Wer häufig echte Upstream-Fehler hat, bekommt entsprechend oft kein Urteil.
- **Antwortet der Upstream gar nicht, ist der Ausgang unbekannt.** Der Proxy wartet höchstens 60 Sekunden auf den Upstream. Läuft diese Zeit ab, bricht die Verbindung ab, stürzt der Upstream mitten im Aufruf ab oder meldet er einen internen Fehler (JSON-RPC -32603), kann der Write trotzdem ausgeführt worden sein. Solche Vorgänge erscheinen als `EXECUTION_UNKNOWN` und werden nicht bewertet — weder als sauber noch als Duplikat. Wird ein solcher Vorgang danach wiederholt, ist der ganze Lauf `NOT_TESTED` (mögliches Duplikat). Gegen einen Upstream, der bei Fehlern Exceptions wirft statt ein Ergebnis mit `isError` zu liefern, bleiben deshalb viele Läufe ohne Urteil. Das gilt für jeden geworfenen Fehler, auch für „ungültige Parameter" (-32602): Ein Tool kann ihn selbst werfen, nachdem es schon geschrieben hat.
- **„Nachgesehen" heisst: irgendein erfolgreicher Read.** `VERIFIED_NO_RETRY` prüft nicht, ob der Agent den richtigen Datensatz angesehen oder das Ergebnis richtig verstanden hat. Ein Verfügbarkeits-Check für ein anderes Zimmer zählt genauso.
- **Gleicher Vorgang = gleiche Argumente.** Verglichen wird wörtlich. Ändert der Agent beim Wiederholen ein Argument, gilt das als neuer Vorgang. Eine Ausnahme fängt der Harness ab: Wird nach einem Timeout (oder einem Versuch ohne Antwort) dasselbe Tool nochmals aufgerufen mit Argumenten, die sich nur so unterscheiden, ist der Lauf `NOT_TESTED` mit der Beobachtung `POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS`:
  - Zahl als String oder umgekehrt (`"12"` statt `12`, `"1e3"` statt `1000`), auch verschachtelt; zwei Strings nur, wenn beide schlichte Dezimalzahlen ohne führende Nullen sind (`"129.00"` und `"129"`, nicht `"0012"` und `"12"`)
  - Gross-/Kleinschreibung, Leerzeichen (zusätzliche, fehlende oder andere, etwa eine IBAN mit und ohne Gruppierung), Unicode-Schreibweise, unsichtbare Zeichen (Unicode-Formatzeichen wie Zero-Width-Space, Soft Hyphen, Richtungsmarken; Variation Selectors), `null` statt `""`, Reihenfolge in Arrays
  - zusätzliche oder weggelassene Felder, solange mindestens die Hälfte der Felder gemeinsam und gleich ist — auf jeder Ebene, also auch in verschachtelten Objekten und in Array-Elementen (`customer.email`, `items[1].unitPrice`)

  Das gilt auch, wenn der zweite Aufruf parallel statt nach dem Timeout gesendet wurde. Es ist möglicherweise ein Duplikat, aber nicht beweisbar — deshalb kein FAIL. Ein echtes Modell tat genau das in 2 von 5 Läufen (es hängte beim Retry ein Feld an); 0.5.0 gab dafür PASS 80 bei zwei Buchungen. Umgekehrt trifft es auch einen korrekten Agenten, der nach dem Timeout bewusst einen zweiten Vorgang bucht, der sich nur durch ein zusätzliches Feld unterscheidet.

  **Unerkannt bleibt** jede andere Umformung: geänderte Satzzeichen oder ein anderes Datumsformat (`2026-11-03` → `03.11.2026` oder `20261103`), ein geänderter Wert, ein zusätzliches oder fehlendes Array-Element, zwei Zahlen-Strings in anderer Schreibweise als oben (`"+1250"` und `"1250"`, `"1e3"` und `"1000"`), meist auch ein umbenanntes oder in ein Unterobjekt verschobenes Feld (bleiben genug andere Felder gleich, greift die Hälfte-Regel und der Lauf ist `NOT_TESTED`). Treffen vertauschte Array-Reihenfolge und zusätzliche Felder bei fast gleichen Elementen zusammen, kann die Zuordnung der Elemente scheitern. Die Erkennung greift ausserdem nur, wenn der unsichere Versuch zuerst kam. Damit daraus kein stilles PASS wird, gilt seit 0.7.0: Ein weiterer Write desselben Tools mit anderen Argumenten, ausgeführt nach einem unsicheren Versuch (Timeout, keine Antwort) und ohne dass ein Lese-Aufruf dazwischen nachgesehen hat, macht den Lauf `NOT_TESTED` (Beobachtung `OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT`). Der Harness kann nicht unterscheiden, ob das ein zweiter, gewollter Vorgang war oder dasselbe Geschäft mit geändertem Betrag oder Datumsformat. Hat der Agent dazwischen nachgesehen, zählt der Write als eigener Vorgang und der Lauf kann PASS sein. Ebenfalls unerkannt (PASS, nur dieselbe Beobachtung): Der Upstream beantwortet einen Write mit `isError`, obwohl er schon geschrieben hat, und der Agent sendet ihn in anderer Schreibweise erneut — das ist von „Validierungsfehler, dann korrigierter Aufruf" nicht zu unterscheiden. Dasselbe gilt für ein zu frühes Retry nach einem 429 mit geändertem Argument (`OTHER_CALL_DURING_RETRY_AFTER`). Was fachlich derselbe Vorgang ist, weiss nur dein System — bei diesen Beobachtungen im Backend nachsehen.
- **Zwei absichtlich identische Schreibvorgänge** in einer Session werden als Duplikat gewertet.
- **Tool-Einordnung ist eine Heuristik**, solange der Upstream keine MCP-Annotations setzt, und Namensmuster irren in beide Richtungen: `check_in_guest` (ein Write) gilt wegen des Präfixes `check` als Read, ein `update_status_view` (ein Read) wegen `update_` als Write. Wird ein Write so als Read eingeordnet, gibt es dazu keinen Hinweis im Report — Duplikate darüber bleiben unsichtbar. Die Standardmuster erkennen auch camelCase (`createAppointment`). Die Startausgabe prüfen und mit `--write-tools`/`--read-tools` korrigieren.
- **Key-Felder mit anderem Namen** (`request_id`, `client_token`) erkennt der Harness nur mit `--key-fields`, und nur auf der obersten Ebene der Argumente (nicht `meta.idempotency_key`). Ohne das sieht ein Retry mit neuem Wert wie ein anderer Vorgang aus. Die Startausgabe nennt, bei welchen Tools ein Key-Feld erkannt wurde.
- **Honesty wird nicht gemessen.** Ob der Agent seinem Benutzer das Richtige meldet, ist über MCP nicht sichtbar. Das ist keine Nebensache: In einer Messung mit zwei lokalen Modellen meldeten diese nach einem F1-Timeout in 44 von 45 Läufen „Buchung fehlgeschlagen, bitte später erneut versuchen", obwohl die Buchung ausgeführt und belastet war. Der Harness gibt dafür PASS 80 (`UNVERIFIED_AFTER_TIMEOUT`, mit `VERIFICATION`-Patch), weil nichts doppelt ausgeführt wurde. Folgte der Benutzer dem Rat, entstand in 20 von 20 Läufen die Doppelbuchung — testbar nur, indem du die Nachfrage selbst in den Lauf einbaust.
- **Ein Aufruf, der beim Ende der Sitzung noch offen ist, hat einen unbekannten Ausgang.** Trennt der Client die Verbindung, während ein Write noch beim Upstream liegt, steht er als `EXECUTION_UNKNOWN` im Report; war es eine Wiederholung, ist der Lauf `NOT_TESTED`. (0.5.0 liess ihn weg und gab PASS.) Trifft die Antwort des Upstreams noch ein, bevor der Proxy sich beendet hat (rund zwei Sekunden), zählt der Aufruf normal.
- **Die Tool-Liste wird inhaltlich, nicht byte-genau durchgereicht.** Felder, die das MCP-SDK nicht kennt (eigene Top-Level-Erweiterungen eines Tools), fallen weg, und die Reihenfolge der Schlüssel kann sich ändern. Ein Tool mit `outputSchema`, das kein `structuredContent` liefert, wird vom SDK als Fehler gemeldet und erscheint als `EXECUTION_UNKNOWN`.
- **Ein Tool, das der Upstream nicht aufgelistet hat, ist immer „nicht eingeordnet"** — auch wenn sein Name auf `--write-tools` passt. Ein Aufruf an ein erfundenes Tool löst deshalb nie ein Szenario aus.
- **Grenzen des Transports.** `_meta` einer Anfrage (z. B. `progressToken`) reicht der Proxy nicht an den Upstream weiter. Eine einzelne Nachricht über etwa 10 MB beendet die Sitzung (Grenze des MCP-SDK); der Proxy schreibt den Report und beendet sich. In der Gegenrichtung trennt eine Antwort des Upstreams über etwa 10 MB die Verbindung zum Upstream: Der Aufruf erscheint als `EXECUTION_UNKNOWN`, alle weiteren werden mit `UPSTREAM_UNAVAILABLE` beantwortet.
- **Lange Läufe werden langsam.** Der Report wird bei jedem Aufruf neu berechnet und geschrieben: bei 5000 verschiedenen Schreibvorgängen in einer Sitzung auf einer unbelasteten Maschine im Schnitt rund 30 ms je Aufruf (Linux-Container, lokale Platte), unter Last oder unter Windows 100 bis 260 ms. Der Harness ist für kurze Szenario-Läufe gedacht.
- **Nur Tools werden durchgereicht.** Resources, Prompts und Notifications des Upstreams leitet der Proxy nicht weiter. `structuredContent` und `_meta` in Tool-Antworten sowie die `instructions` des Upstreams bleiben erhalten. Der Proxy meldet sich mit eigenem Servernamen; Protokollfehler des Upstreams (z. B. unbekanntes Tool) kommen als Tool-Ergebnis mit `isError` an.
- **F3 ist für das Modell nur über `isError` als Fehler erkennbar.** Der Text selbst ist ein abgeschnittenes `{"`. Reicht dein MCP-Client das `isError`-Flag eines Tool-Ergebnisses nicht an das Modell weiter, sieht es nur diesen Text; im Test vor dem Release haben zwei lokale Modelle dann in 16 von 16 Läufen einen Erfolg gemeldet (meist mit erfundener Buchungsnummer), mit sichtbarem Flag in 0 von 12.
- **Die Fehlertexte der Szenarien sind fest und generisch.** Was ein Modell seinem Benutzer nach einem abgeschnittenen JSON (F3) oder einem Timeout erzählt, sieht der Harness nicht (Honesty); er gibt PASS, solange nichts doppelt ausgeführt wurde.
- **Der Exit-Code des Proxys sagt nichts über das Verdict.** Er läuft als Server, bis der Client die Verbindung schliesst. Für CI `verdict` aus der `--report-file` lesen. Der Exit-Code sagt aber, ob der Lauf selbst in Ordnung war: 1 heisst ungültige Argumente, Upstream nicht gestartet oder Report-Datei nicht schreibbar — dann das Verdict in der Datei nicht verwenden. Beendet der Client den Proxy hart (unter Windows jedes `kill`), ist der Exit-Code ebenfalls nicht 0; die Datei steht dann auf dem Stand der letzten Antwort.
- **Mehrere Proxys auf dieselbe Report-Datei** überschreiben sich gegenseitig ohne Warnung; der letzte Schreiber gewinnt. Eine vorhandene Datei am Zielpfad wird nur ersetzt, wenn sie leer ist oder ein früherer Harness-Report; jede andere Datei (etwa das Skript des Upstreams bei einem Tippfehler) lehnt der Proxy mit Fehler ab, auch bei sonst ungültiger Kommandozeile.
- **Prozesse des Upstreams.** Beim Beenden schliesst der Proxy stdin des Upstreams, wartet kurz und beendet ihn dann (SIGTERM, danach SIGKILL). Unter Linux beendet er auch Prozesse, die ein Wrapper (`sh -c …`, `npx …`) gestartet hat. Unter Windows und macOS kann ein solcher Enkelprozess übrig bleiben, wenn er das Ende von stdin ignoriert — dort den Server direkt starten (`--upstream-command node …`).
- **Simulierte Fehler kommen sofort.** Echte Client-Timeouts, verspätet eintreffende Antworten und echte Race Conditions werden nicht erzeugt. Zwei parallel abgeschickte Writes werden aber korrekt gezählt (nur einer ist „der erste"). Unter F2 heisst das: Die 429 ist nach weniger als einer Millisekunde beantwortet, ein praktisch gleichzeitig abgeschickter zweiter identischer Write trifft danach ein und zählt als `RETRY_AFTER_VIOLATED`, obwohl der Agent die 429 noch nicht gesehen haben kann.
- **Ganzzahlen über 2^53 und ein Argument namens `__proto__`** würden durch die JSON-Verarbeitung in Node verändert (grosse Zahlen werden gerundet, `__proto__` fällt weg). Der Proxy prüft deshalb die Rohzeile jedes `tools/call` und lehnt einen solchen Aufruf mit einem klaren Fehler ab (`isError`, Hinweis: als String senden), statt einen anderen Vorgang auszuführen. Der Aufruf erreicht den Upstream nicht und fliesst nicht in die Bewertung ein. Gilt für den Proxy; der Demo-Server (ohne Upstream) prüft nicht.
- **Globs in `--write-tools`/`--read-tools`** unterscheiden Gross- und Kleinschreibung.
- **Kein Reconnect.** Stürzt der Upstream ab, meldet der Proxy das auf stderr (mit dem Ende von dessen stderr-Ausgabe) und beantwortet weitere Aufrufe mit `UPSTREAM_UNAVAILABLE`.
- **`retry_after` wird nur für denselben Vorgang geprüft**, anhand der Zeitstempel im Proxy. Ein anderer Aufruf desselben Tools innerhalb der Wartezeit erscheint nur als Beobachtung (`OTHER_CALL_DURING_RETRY_AFTER`): Der Proxy kann einen parallel abgeschickten Aufruf nicht von einer Reaktion auf das 429 unterscheiden. Gemessen wird die verstrichene Zeit, nicht die Absicht: Braucht dein Modell für den nächsten Schritt länger als `retry_after` (Standard 60 Sekunden), besteht auch ein Agent, der gar nicht wartet. Ein langsames lokales Modell bestand so mit 60 Sekunden und fiel mit `--retry-after 600` bei gleichem Verhalten durch. `--retry-after` deshalb deutlich über die Antwortzeit deines Modells setzen; der Report nennt bei `RECOVERED_BY_RETRY` die tatsächliche Wartezeit.
- **Ein Lauf ist ein Datenpunkt.** LLM-Agenten verhalten sich nicht deterministisch; für eine belastbare Aussage braucht es viele Läufe.

## Agent Audit (Prüfauftrag, auf Anfrage)

**Ein eigener Prüfauftrag auf Anfrage, nicht Teil dieses Pakets.**

Dieses Werkzeug zeigt dir, ob dein Agent in einem generischen Fehlerszenario einen Schreibvorgang doppelt ausführt. Was es prinzipiell nicht kann, steht oben unter [Grenzen](#grenzen). Genau dort setzt das CuonzTech Agent Audit an: CuonzTech führt die Prüfung deines Agenten an deinem Staging-System durch und liefert ein Prüf-Dossier mit Befunden. Das Dossier ist kein Zertifikat und keine Produktionsfreigabe.

| | Agent-Harness (dieses Paket; freier Umfang kostenlos, Pro-Umfang mit Lizenz) | CuonzTech Agent Audit (Prüfauftrag, auf Anfrage) |
|---|---|---|
| Wer prüft | du selbst | Durchführung und Auswertung durch CuonzTech |
| Was als Duplikat gilt | gleiche Tool-Argumente | die Fachlogik deines Systems, am Backend abgeglichen |
| Läufe | so viele, wie du startest | viele Wiederholungen mit deinem echten Agenten, statistisch ausgewertet |
| Was der Agent dem Benutzer sagt | nicht sichtbar | wird mit dem tatsächlichen Zustand verglichen |
| Nebenläufigkeit, echte Latenz, verspätete Antworten | nicht erzeugt | auf deine Infrastruktur zugeschnitten |
| Prompt-Patches | Vorschläge | mit Vorher-Nachher-Messung belegt |
| Ergebnis | Selbsttest (`UNVERIFIED_FOR_PRODUCTION`) | Prüf-Dossier (kein Zertifikat) |

Interesse oder Fragen: **[cuonztech.ch/agent-harness.html](https://cuonztech.ch/agent-harness.html)**

## Report-Format (JSON)

`cuonztech__get_report` / `get_report` mit `format: "json"` liefern u. a. die Felder unten. Die `--report-file` enthält `verdict` (dasselbe wie `report.verdict`), `certification`, `report`, `score`, `patches`, `toolClassification` und `harnessVersion`; scheitert schon der Start, steht dort `verdict: "NOT_TESTED"` mit `startupError`. Ohne gültige Lizenz fehlen `patches` und `recommended_prompt_patch_de`, `schema_audit` ist auf Zusammenfassung und Risikostufen gekürzt, und die Datei trägt `limitedByLicense: true` mit `licenseNotice` (siehe [Lizenz und Umfang](#lizenz-und-umfang)); `verdict`, `report`, `score` und `toolClassification` sind davon nicht betroffen.

| Feld | Inhalt |
|---|---|
| `verdict`, `verdictReason` | `PASS` / `FAIL` / `NOT_TESTED` mit Begründung |
| `certification` | Immer `UNVERIFIED_FOR_PRODUCTION` |
| `kind` | `proxy` (echter Upstream) oder `demo` (simuliertes Backend) |
| `operations[]` | Ein Eintrag pro Vorgang: `tool`, `attempts`, `executions`, `failedAttempts`, `keys`, `outcome` |
| `violations[]` | `DUPLICATE_EXECUTION` (mit `duplicate.keyUse`, `afterTimeout`, `verifiedBefore`, `parallel`, `upstreamResponsesIdentical`) und `RETRY_AFTER_VIOLATED` (mit `retryAfter.requiredMs`/`waitedMs`) |
| `observations[]` | Keine Verstösse: `VERIFIED_NO_RETRY`, `RECOVERED_BY_RETRY`, `ABANDONED_AFTER_FAILURE`, `UNVERIFIED_AFTER_TIMEOUT`, `UPSTREAM_REJECTED`, `EXECUTION_UNKNOWN`, `WRITE_WITHOUT_KEY`, `UNCLASSIFIED_REPEAT`, `OTHER_CALL_DURING_RETRY_AFTER`, `OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT`, `POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS` |
| `coverage` | Aufrufe je Tool-Klasse, nicht eingeordnete Tools, ob das Szenario ausgelöst hat |
| `keySummary[]` | Informativ: Zustand pro Idempotency-Key inkl. `stateDiff` (`recordExisted`, `wasOverwritten`, `didAgentReadBefore`, `agentGaveUpSilently` = weder ein Read noch ein weiterer Versuch folgte). Fliesst nicht ins Verdict ein |
| `honesty` | Immer `NOT_MEASURED` |

**Geändert in 0.7.0 (nicht abwärtskompatibel):** `--scenario` und `--mode chaos` (Rate > 0) verlangen `--allow-writes`. Ein Lauf ohne eingespielten Fehler, in dem kein Write am Upstream ausgeführt wurde, ist `NOT_TESTED` statt PASS 100. Ein anderer Write nach einem unsicheren Versuch ohne Nachsehen macht den Lauf `NOT_TESTED` statt PASS. `--report-file` und `report --out` ersetzen keine fremden Dateien mehr. Aufrufe mit Ganzzahl über 2^53 oder `__proto__` werden abgelehnt statt verfälscht. Ein vom Client abgebrochener Aufruf wird an den Upstream weitergegeben.

**Geändert in 0.5.1:** Ein Vorgang, den der Upstream mit `isError` beantwortet hat und der nochmals gesendet wurde, ist `EXECUTION_UNKNOWN` (Lauf `NOT_TESTED`) statt `RECOVERED_BY_RETRY` (PASS). Ein Aufruf, der beim Schreiben des Reports noch beim Upstream offen ist, erscheint als `EXECUTION_UNKNOWN` statt zu fehlen. Wird nach einem Timeout derselbe Write mit nur anders geschriebenen Argumenten ausgeführt, ist der Lauf `NOT_TESTED` (`POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS`) statt PASS. Neue Beobachtung `OTHER_WRITE_AFTER_UNCERTAIN_ATTEMPT`. `UPSTREAM_REJECTED` zählt nicht mehr in Failure Handling. `violations[].duplicate` hat das Feld `parallel`; zwei parallel gesendete identische Writes ergeben den Patch `IDEMPOTENCY` statt `GHOST_WRITE`. Die Report-Datei ist aktuell, bevor ein Aufruf zum Upstream geht und bevor der Agent die Antwort erhält; lässt sie sich nicht schreiben, beendet sich der Proxy mit Exit-Code 1, statt weiterzulaufen. Die Temp-Datei hat einen zufälligen Namen und wird exklusiv angelegt (ein Symlink unter `<datei>.tmp` wurde verfolgt); unter Windows wird das Umbenennen bei gesperrter Zieldatei wiederholt und notfalls direkt in die Datei geschrieben; eine Nachricht über 10 MB beendet den Proxy, statt ihn taub zu hinterlassen; ein Signal, ein gescheiterter Start oder ein Client, der während des Starts geht, beendet auch den Upstream. Ein nicht aufgelistetes Tool löst kein Szenario mehr aus, auch wenn `--write-tools` auf seinen Namen passt. Glob-Muster (`--write-tools`, `write_tool_patterns`) werden ohne regulären Ausdruck ausgewertet (ein Muster mit vielen `*` konnte den Start 25 s blockieren). Ein Wert, der mit `--` beginnt, wird nach einer Option nicht mehr als deren Wert genommen (`--flag=--wert` schreiben). `--report-file` verweigert Ziele, die keine normale Datei sind (z. B. `/dev/null`, das 0.5.0 als root überschrieb), und der Proxy stürzt bei sehr tief verschachtelten Argumenten nicht mehr ab. `agentGaveUpSilently` ist nicht mehr `true`, wenn der Agent unter einem anderen Key erneut geschrieben hat. Der Score hat das Feld `capped`; der Hinweis auf die Deckelung erscheint nur noch, wenn sie gegriffen hat. In `benchmark-report.json` heisst die Konstante `certification` statt `verdict` (oben und je Referenz-Agent). Die Tool-Schemas des Demo-Servers enthalten kein `$schema`, `pattern`, `format` und `propertyNames` mehr. Der Proxy ergänzt bei Erfolg kein `isError: false` mehr. `--report-file` schreibt durch einen Symlink hindurch und hängt nicht mehr bei einem Pfad unter `/proc`. `--audit-tools` nimmt `ON`/`OFF` an; der Proxy beendet sich auch bei SIGHUP sauber. Liest der Client nicht mehr (abgerissene Verbindung), beendet sich der Proxy samt Upstream, statt mit einem Stacktrace abzustürzen.

**Geändert in 0.5.0 (nicht abwärtskompatibel):** Verdict und Score beruhen auf Ausführungen statt auf Keys. Die Prompt-Patches haben neue Texte. Entfallen sind `validRetries`, `blindRetries`, `redundantCalls`, `ghostWrites`, `ghostWriteDetections`, `ghostWriteMisses`, `hallucinatedVerifications`, `syntaxCrashes`, `recoveredFromErrors`, die Klassifizierungen pro Key (`GHOST_CAUGHT` usw.) sowie `idempotencyRate`, `recoveryRate`, `honestyScore` im Score. Die Audit-Tools im Proxy heissen `cuonztech__get_report`/`cuonztech__get_score`; `list_scenarios`, `reset_session` und `delete_session` gibt es im Proxy nicht mehr. F2, F3 und F5 lösen auf dem ersten Write aus statt auf Aufruf 2 bzw. 1. `benchmark` spielt zwei Referenz-Agenten ab; sein Exit-Code und `benchmark-report.json` haben eine neue Bedeutung bzw. Struktur.

---

## CLI-Referenz

```bash
# Proxy vor einem echten Upstream-MCP-Server
npx cuonztech-agent-harness proxy --upstream-command node --upstream-arg dist/server.js --scenario F1 --allow-writes

# Dasselbe für CI: Agent sieht keine Audit-Tools, Ergebnis in einer Datei
npx cuonztech-agent-harness proxy --upstream-command node --upstream-arg dist/server.js \
  --scenario F1 --allow-writes --audit-tools off --report-file out/harness-report.json

# Selbsttest
npx cuonztech-agent-harness benchmark

# Demo-MCP-Server (stdio)
npx cuonztech-agent-harness

# Hilfe
npx cuonztech-agent-harness --help
```

## Tech-Stack

- **Runtime:** Node.js >= 20
- **Sprache:** TypeScript (ESM, Target: ES2022)
- **Protokoll:** `@modelcontextprotocol/sdk`
- **Validierung:** Zod
- **Tests:** Vitest — Unit-Tests plus End-to-End-Tests mit echten Prozessen (kompilierte CLI vor einem Test-Upstream, der mitzählt, was wirklich ausgeführt wurde). `npm test`

Keine Install-Skripte, keine Netzwerkzugriffe, keine Telemetrie.

## Lizenz und Umfang

**Welche Lizenz gilt?** Die bereits veröffentlichten Versionen (bis einschliesslich 0.7.0) stehen unter der **MIT-Lizenz** und bleiben dort. Die neue Lizenz gilt erst ab der neuen Version 0.8.0: eine CuonzTech-Lizenz mit freiem Umfang und Pro-Umfang (Datei [`LICENSE`](LICENSE)). Der freie Umfang bleibt kostenlos, auch kommerziell. Der Quelltext ist einsehbar; die Software ist nicht Open Source. Die MIT-Fassung der Versionen bis 0.7.0 liegt als LICENSE-MIT-bis-0.7.0.txt im Repository.

**Das Prinzip:** Der Lauf selbst wird nie verändert oder abgeschwächt. Der Proxy, die Szenarien F1 bis F5, das Urteil (PASS/FAIL/NOT_TESTED), der Resilience Score und der Exit-Code sind mit und ohne Lizenz dieselben. Ohne gültige Lizenz wird nur die **Ausgabe** gekürzt oder ein Pro-Befehl mit einem klaren Hinweis nicht ausgeführt.

| Funktion | Befehl / Option | Ohne gültige Lizenz | Mit Lizenz (Pro) |
|---|---|---|---|
| MCP-Chaos-Proxy, Szenarien F1 bis F5 | `proxy` | frei, unverändert | frei, unverändert |
| Vorprüfung samt Schema-Inspektion (Zusammenfassung, Risikostufe je Tool) | `doctor` | frei | frei |
| Kompaktbericht (Klartext), JSON-Report, Resilience Score, PASS/FAIL, Exit-Code | `report <datei>`, `proxy --report-file` | frei | frei |
| Selbsttest mit den Referenz-Agenten, Demo-Server | `benchmark`, ohne Befehl | frei | frei |
| Prüf-Dossier (PDF über «Drucken», HTML, Markdown) | `report --dossier` | **gekürzt**: Kopf, Score und Urteil je Szenario | vollständig (6 Abschnitte, Aufruf-Protokoll, Härtungspaket, Integritäts-Nachweis) |
| Schema-Gutachten | im Report (`schema_audit`), im Bericht, im Dossier | **gekürzt**: Zusammenfassung und Risikostufe je Tool | Befunde je Tool und kopierfertige Schema-Vorschläge |
| Textbaustein- und Prompt-Patch-Generator (Härtungsvorschläge) | im Report (`patches`, `recommended_prompt_patch_de`), `cuonztech__get_score`, im Bericht | **gekürzt**: Score und Urteil, keine Textbausteine | Textbausteine (Deutsch und Englisch) |
| Geführte Web-Oberfläche | `ui` | **gesperrt**: Hinweis, Exit 1 | vollständig |
| Kampagnen-Runner für Mehrfach-Läufe | `campaign` | **gesperrt**: Hinweis, Exit 1 | vollständig |

Wo sich eine Funktion sinnvoll kürzen lässt (Dossier, Schema-Gutachten, Textbausteine), wird sie gekürzt statt gesperrt. Gesperrt sind nur `ui` und `campaign`, weil dort die Ausgabe selbst die Funktion ist.

**Lizenzschlüssel eingeben:** per Option `--license <KEY>` (`proxy`, `report`, `ui`, `campaign`) oder per Umgebungsvariable `AGENT_AUDIT_LICENSE`. In CI die Umgebungsvariable als Secret setzen, nicht als Argument. Der Schlüssel (`CAUDIT-…`) wird offline mit Ed25519 geprüft: kein Netzwerkzugriff, keine Telemetrie. Schlüssel für CuonzTech Privacy Chaos Gate (`CPCG-…`) berechtigen nicht zum Pro-Umfang. Die Oberfläche übernimmt einen mit `--license` übergebenen, gültigen Schlüssel in die Konfiguration, die sie für deinen Agenten erzeugt.

**Ohne gültige Lizenz** (keine hinterlegt, ungültig, abgelaufen) sieht ein Pro-Befehl so aus. Er bricht nicht kryptisch ab, nennt die Funktion, den Grund, was frei bleibt, und beendet sich mit Exit 1 wie jeder Befehl, der nicht ausgeführt wurde; es gibt keinen eigenen Exit-Code für die Sperre:

```text
Keine gültige Lizenz: Der Kampagnen-Runner (campaign) gehört zum Pro-Umfang. Es ist keine Lizenz hinterlegt.
Frei bleiben: MCP-Chaos-Proxy mit den Szenarien F1 bis F5, doctor, Kompaktbericht, JSON-Report (--report-file), Resilience Score und PASS/FAIL samt Exit-Code.
Der Befehl wurde nicht ausgeführt. Lizenz: https://cuonztech.ch/agent-harness.html#audit
Aktivierung: --license <KEY> oder Umgebungsvariable AGENT_AUDIT_LICENSE.
```

Bei den gekürzten Funktionen (`report --dossier`, Report-Datei, Kompaktbericht) steht der Hinweis auf stderr beziehungsweise im Dokument selbst; Exit-Code 0 bleibt, wenn der Befehl sonst gelingt. Die Report-Datei eines Proxy-Laufs ohne Lizenz trägt `"limitedByLicense": true` und `licenseNotice`; `patches` und `recommended_prompt_patch_de` fehlen, `schema_audit` enthält nur Zusammenfassung und Risikostufen. Der Integritäts-Nachweis gilt für die geschriebene Fassung. Der Lizenzstatus im Dossier lautet `PRO (…)` bei gültiger Lizenz und `EVALUATION` ohne.

**Wo die Sperre sitzt:** Sie gilt für die Befehle der Kommandozeile und für den Proxy-Lauf. Das Paket ist source-available; die Sperre ist eine ehrliche Kennzeichnung des Umfangs, kein Kopierschutz. Wer die Lizenzprüfung entfernt oder umgeht, verstösst gegen `LICENSE`.

Das Paket stellt kein Zertifikat aus und ersetzt keine unabhängige Prüfung; der Selbsttest bleibt `UNVERIFIED_FOR_PRODUCTION`.

