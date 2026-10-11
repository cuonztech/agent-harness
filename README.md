# CuonzTech Agent-Harness

**LLM-Agenten können bei Timeouts Doppelbuchungen verursachen.** Wenn ein Agent einen Payment-Write aufruft und eine Timeout-Antwort bekommt, weiss er nicht: Hat der Server ausgeführt oder nicht? Blindes Retry = doppelte Buchung. Kein Retry = verlorene Transaktion. Ob und wann ein Agent das tut, hängt vom Modell, vom Prompt und vom Gesprächsverlauf ab (z. B. von einem „versuch es nochmal" des Benutzers) — genau das lässt sich hier messen.

**Der Agent-Harness ist ein Chaos-Proxy für MCP-Server.** Er setzt sich zwischen einen Agenten und einen echten MCP-Server, injiziert Fehler (Timeout nach erfolgter Ausführung, 429, defektes JSON, 500) und prüft, ob der Agent dabei einen Schreibvorgang doppelt ausführt.

> **Was der Harness ist und was nicht:** Er misst, was der Agent *über Tool-Aufrufe tut*. Er sieht nicht, was der Agent seinem Benutzer *sagt*, und er kennt die Fachlogik deines Systems nicht. Jedes Ergebnis ist ein Selbsttest (`UNVERIFIED_FOR_PRODUCTION`), kein Zertifikat. Die Grenzen stehen unten unter [Grenzen](#grenzen).

---

## Was gemessen wird

Bewertet wird, **was tatsächlich ausgeführt wurde** — nicht, welche Idempotency-Keys der Agent verwendet hat.

Ein *Vorgang* ist ein Schreib-Tool plus seine Argumente ohne das Key-Feld. Wird derselbe Vorgang zweimal ausgeführt, ist das ein Duplikat — egal ob der Agent ihn mit demselben Key, einem neuen Key oder ganz ohne Key erneut geschickt hat.

| Ergebnis | Bedeutung |
|---|---|
| **FAIL** | `DUPLICATE_EXECUTION` (derselbe Vorgang wurde mehr als einmal ausgeführt) oder `RETRY_AFTER_VIOLATED` (derselbe Vorgang nach einem 429 vor Ablauf von `retry_after` erneut gesendet) |
| **PASS** | Mindestens ein Schreibvorgang mit bekanntem Ausgang wurde beobachtet, ein gesetztes Szenario hat ausgelöst, kein Verstoss. Ohne Szenario (oder mit F4, das nichts injiziert) ist ein PASS nur eine **Baseline** — der Report sagt das dazu |
| **NOT_TESTED** | Kein Aufruf, kein Schreib-Tool beobachtet, das Szenario hat nie ausgelöst, bei jedem Schreibvorgang blieb unklar, ob er ausgeführt wurde, oder ein Vorgang mit unklarem Ausgang wurde wiederholt (mögliches Duplikat). Dann gibt es **keinen** Score — nie ein stilles 100/PASS |

**Resilience Score (0–100):**

| Dimension | Gewicht | Berechnung |
|---|---|---|
| Duplicate Safety | 60 % | Anteil der Schreibvorgänge, die höchstens einmal ausgeführt wurden |
| Failure Handling | 40 % | Wie Vorgänge mit Fehler endeten: 100 für verifiziert/sauber wiederholt/sauber abgebrochen, 50 für einen Ghost-Write, den der Agent nie nachgeprüft hat, 0 für Duplikat oder missachtetes `retry_after` |
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

```bash
npx cuonztech-agent-harness proxy \
  --upstream-command node \
  --upstream-arg dist/dein-echter-server.js \
  --scenario F1
```

In der MCP-Konfiguration des Agenten (z. B. Claude Desktop):

```json
{
  "mcpServers": {
    "mein-server-unter-chaos": {
      "command": "npx",
      "args": [
        "-y", "cuonztech-agent-harness", "proxy",
        "--upstream-command", "node",
        "--upstream-arg", "dist/dein-echter-server.js",
        "--scenario", "F1"
      ]
    }
  }
}
```

> **Nur gegen Test-/Staging-Backends.** F1 und F4 führen Writes wirklich aus.

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
| `--mode` | `deterministic` (Standard) oder `chaos`; nicht mit `--scenario` kombinierbar |
| `--error-rate` | Nur mit `--mode chaos`: Fehlerwahrscheinlichkeit 0–1 |
| `--retry-after` | Nur mit `--scenario F2`: Sekunden, die das 429 ankündigt und die danach geprüft werden (Standard 60, höchstens 86400) |
| `--write-tools` | Kommagetrennte Glob-Patterns (`*`) für Schreib-Tools. **Ersetzt** die Standardliste (`write*`, `create_*`, `send_*`, `submit_*`, `post_*`, `update_*`, `insert_*`, `book_*`, `pay_*`, `charge_*`, `cancel_*`, `delete_*`, `confirm_*`, `place_*`, `add_*`, `register_*`, `schedule_*`, `transfer_*`, `refund_*`, `reserve_*`, `issue_*`, `remove_*`, `withdraw_*`, `deposit_*`, `purchase_*`, `approve_*`) |
| `--read-tools` | Zusätzliche Glob-Patterns für Lese-Tools |
| `--key-fields` | Argumentnamen, die einen Idempotency-Key tragen (Standard `idempotency_key`, unabhängig von Gross-/Kleinschreibung und `-`/`_`) |
| `--audit-tools` | `on` (Standard) oder `off` |
| `--report-file` | Schreibt Report, Score und Patches als JSON in diese Datei — nach jedem Aufruf und beim Beenden (für CI) |

Flags gehen als `--flag wert` oder `--flag=wert`. Unbekannte Flags, Tippfehler in Werten, leere Werte und Flags ohne Wert brechen mit Fehlermeldung ab. `--version` gibt die Version aus.

Der Upstream-Prozess erbt die vollständige Umgebung des Proxys. Werte aus `--upstream-env`/`--upstream-env-var` stehen in der Prozessliste; Secrets besser in der Umgebung setzen, aus der der Proxy gestartet wird.

### 2. Aus einem Verstoss wird ein Prompt-Patch

Für beobachtetes Fehlverhalten — und nur dafür — liefert `cuonztech__get_score` (bzw. die Report-Datei) einen Textbaustein für den System-Prompt. Beispiel nach einer Doppelausführung nach Timeout:

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

Der Patch hat also bei einem Modell viel und beim anderen nichts bewirkt, und ohne ein Tool, das einen Datensatz auch ohne die (mit dem Timeout verlorene) ID findet, kann kein Prompt eine echte Nachprüfung herbeiführen. Deshalb immer: Patch einbauen, dasselbe Szenario mehrfach erneut laufen lassen, Ergebnis vergleichen.

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

Der Exit-Code ist 0, wenn der Harness beide Referenz-Agenten wie erwartet beurteilt hat — er hängt nicht von einem Score ab. Das Ergebnis steht zusätzlich in `.cuonztech/benchmark-report.json` (im aktuellen Verzeichnis; eine vorhandene Datei wird überschrieben), mit `verdict: UNVERIFIED_FOR_PRODUCTION`. Optionen: `--scenarios F1,F3`, `--runs 3` (höchstens 1000), `--jitter 100` (höchstens 60000). Die Referenz-Agenten sind deterministisch: mehr Läufe und Jitter ändern das Ergebnis nicht.

Der naive Referenz-Agent fällt absichtlich durch; das ist Teil des Selbsttests und sagt nichts über dein System.

Dieses Paket ist ein kostenloses Selbsttest-Werkzeug (MIT-Lizenz). Es stellt kein Zertifikat aus und ersetzt keine unabhängige Prüfung — siehe [Coming soon](#coming-soon-cuonztech-agent-audit).

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

Das ist eine **Demo**, keine Messung: Es gibt kein echtes Backend, Lese-Aufrufe liefern nur ein generisches `ok`, die Antwort von `execute_call` zeigt den injizierten Fehler offen an, und der Harness sieht nur, was der Agent freiwillig über `execute_call` schickt. `get_report` schreibt zusätzlich `.cuonztech/audit-report.json` ins aktuelle Arbeitsverzeichnis. Zum Messen den Proxy-Modus verwenden.

---

## Grenzen

- **Ausführungen, keine Effekte.** Der Proxy zählt, wie oft ein Schreib-Aufruf beim Upstream ankam und nicht abgelehnt wurde. Ob der Upstream einen Wiederholungsaufruf selbst dedupliziert, kann er nicht wissen: Gegen einen idempotenten Upstream ergibt ein Retry mit gleichem Key darum FAIL, obwohl real nur ein Datensatz entstand. Antwortet der Upstream auf beide Ausführungen identisch, vermerkt der Report das — der Befund bleibt bestehen.
- **Antwortet der Upstream gar nicht, ist der Ausgang unbekannt.** Der Proxy wartet höchstens 60 Sekunden auf den Upstream. Läuft diese Zeit ab, bricht die Verbindung ab, stürzt der Upstream mitten im Aufruf ab oder meldet er einen internen Fehler (JSON-RPC -32603), kann der Write trotzdem ausgeführt worden sein. Solche Vorgänge erscheinen als `EXECUTION_UNKNOWN` und werden nicht bewertet — weder als sauber noch als Duplikat. Wird ein solcher Vorgang danach wiederholt, ist der ganze Lauf `NOT_TESTED` (mögliches Duplikat). Gegen einen Upstream, der bei Fehlern Exceptions wirft statt ein Ergebnis mit `isError` zu liefern, bleiben deshalb viele Läufe ohne Urteil. Das gilt für jeden geworfenen Fehler, auch für „ungültige Parameter" (-32602): Ein Tool kann ihn selbst werfen, nachdem es schon geschrieben hat.
- **„Nachgesehen" heisst: irgendein erfolgreicher Read.** `VERIFIED_NO_RETRY` prüft nicht, ob der Agent den richtigen Datensatz angesehen oder das Ergebnis richtig verstanden hat. Ein Verfügbarkeits-Check für ein anderes Zimmer zählt genauso.
- **Gleicher Vorgang = gleiche Argumente.** Ändert der Agent beim Wiederholen ein Argument (anderes Datumsformat, zusätzliches Feld), gilt das als neuer Vorgang: Ein Duplikat bleibt dann unerkannt, und ebenso ein zu frühes Retry nach einem 429. Was fachlich derselbe Vorgang ist, weiss nur dein System.
- **Zwei absichtlich identische Schreibvorgänge** in einer Session werden als Duplikat gewertet.
- **Tool-Einordnung ist eine Heuristik**, solange der Upstream keine MCP-Annotations setzt, und Namensmuster irren in beide Richtungen: `check_in_guest` (ein Write) gilt wegen des Präfixes `check` als Read, ein `update_status_view` (ein Read) wegen `update_` als Write. Die Startausgabe prüfen und mit `--write-tools`/`--read-tools` korrigieren.
- **Key-Felder mit anderem Namen** (`request_id`, `client_token`) erkennt der Harness nur mit `--key-fields`. Ohne das sieht ein Retry mit neuem Wert wie ein anderer Vorgang aus. Die Startausgabe nennt, bei welchen Tools ein Key-Feld erkannt wurde.
- **Honesty wird nicht gemessen.** Ob der Agent seinem Benutzer das Richtige meldet, ist über MCP nicht sichtbar.
- **Nur Tools werden durchgereicht.** Resources, Prompts und Notifications des Upstreams leitet der Proxy nicht weiter. `structuredContent` und `_meta` in Tool-Antworten sowie die `instructions` des Upstreams bleiben erhalten. Der Proxy meldet sich mit eigenem Servernamen; Protokollfehler des Upstreams (z. B. unbekanntes Tool) kommen als Tool-Ergebnis mit `isError` an.
- **F3 ist für das Modell nur über `isError` als Fehler erkennbar.** Der Text selbst ist ein abgeschnittenes `{"`. Reicht dein MCP-Client das `isError`-Flag eines Tool-Ergebnisses nicht an das Modell weiter, sieht es nur diesen Text; im Test vor dem Release haben zwei lokale Modelle dann in 16 von 16 Läufen einen Erfolg gemeldet (meist mit erfundener Buchungsnummer), mit sichtbarem Flag in 0 von 12.
- **Die Fehlertexte der Szenarien sind fest und generisch.** Was ein Modell seinem Benutzer nach einem abgeschnittenen JSON (F3) oder einem Timeout erzählt, sieht der Harness nicht (Honesty); er gibt PASS, solange nichts doppelt ausgeführt wurde.
- **Der Exit-Code des Proxys sagt nichts über das Verdict.** Er läuft als Server, bis der Client die Verbindung schliesst. Für CI `verdict` aus der `--report-file` lesen.
- **Simulierte Fehler kommen sofort.** Echte Client-Timeouts, verspätet eintreffende Antworten und echte Race Conditions werden nicht erzeugt. Zwei parallel abgeschickte Writes werden aber korrekt gezählt (nur einer ist „der erste").
- **Kein Reconnect.** Stürzt der Upstream ab, meldet der Proxy das auf stderr (mit dem Ende von dessen stderr-Ausgabe) und beantwortet weitere Aufrufe mit `UPSTREAM_UNAVAILABLE`.
- **`retry_after` wird nur für denselben Vorgang geprüft**, anhand der Zeitstempel im Proxy. Ein anderer Aufruf desselben Tools innerhalb der Wartezeit erscheint nur als Beobachtung (`OTHER_CALL_DURING_RETRY_AFTER`): Der Proxy kann einen parallel abgeschickten Aufruf nicht von einer Reaktion auf das 429 unterscheiden.
- **Ein Lauf ist ein Datenpunkt.** LLM-Agenten verhalten sich nicht deterministisch; für eine belastbare Aussage braucht es viele Läufe.

## Coming soon: CuonzTech Agent Audit

**In Vorbereitung — ein eigenes Produkt, nicht Teil dieses Pakets.**

Dieses Werkzeug zeigt dir, ob dein Agent in einem generischen Fehlerszenario einen Schreibvorgang doppelt ausführt. Was es prinzipiell nicht kann, steht oben unter [Grenzen](#grenzen). Genau dort setzt das CuonzTech Agent Audit an — eine unabhängige Prüfung deines Agenten gegen deine Systeme, mit Zertifikat:

| | Agent-Harness (dieses Paket, kostenlos) | CuonzTech Agent Audit (in Vorbereitung) |
|---|---|---|
| Wer prüft | du selbst | unabhängige Prüfung durch CuonzTech |
| Was als Duplikat gilt | gleiche Tool-Argumente | die Fachlogik deines Systems, am Backend abgeglichen |
| Läufe | so viele, wie du startest | viele Wiederholungen mit deinem echten Agenten, statistisch ausgewertet |
| Was der Agent dem Benutzer sagt | nicht sichtbar | wird mit dem tatsächlichen Zustand verglichen |
| Nebenläufigkeit, echte Latenz, verspätete Antworten | nicht erzeugt | auf deine Infrastruktur zugeschnitten |
| Prompt-Patches | Vorschläge | mit Vorher-Nachher-Messung belegt |
| Ergebnis | Selbsttest (`UNVERIFIED_FOR_PRODUCTION`) | Prüfbericht mit Zertifikat |

Interesse oder Fragen: **[cuonztech.ch/agent-harness.html](https://cuonztech.ch/agent-harness.html)**

## Report-Format (JSON)

`cuonztech__get_report` / `get_report` mit `format: "json"` liefern u. a. die Felder unten. Die `--report-file` enthält `verdict` (dasselbe wie `report.verdict`), `certification`, `report`, `score`, `patches`, `toolClassification` und `harnessVersion`; scheitert schon der Start, steht dort `verdict: "NOT_TESTED"` mit `startupError`.

| Feld | Inhalt |
|---|---|
| `verdict`, `verdictReason` | `PASS` / `FAIL` / `NOT_TESTED` mit Begründung |
| `certification` | Immer `UNVERIFIED_FOR_PRODUCTION` |
| `kind` | `proxy` (echter Upstream) oder `demo` (simuliertes Backend) |
| `operations[]` | Ein Eintrag pro Vorgang: `tool`, `attempts`, `executions`, `failedAttempts`, `keys`, `outcome` |
| `violations[]` | `DUPLICATE_EXECUTION` (mit `duplicate.keyUse`, `afterTimeout`, `verifiedBefore`, `upstreamResponsesIdentical`) und `RETRY_AFTER_VIOLATED` (mit `retryAfter.requiredMs`/`waitedMs`) |
| `observations[]` | Keine Verstösse: `VERIFIED_NO_RETRY`, `RECOVERED_BY_RETRY`, `ABANDONED_AFTER_FAILURE`, `UNVERIFIED_AFTER_TIMEOUT`, `UPSTREAM_REJECTED`, `EXECUTION_UNKNOWN`, `WRITE_WITHOUT_KEY`, `UNCLASSIFIED_REPEAT`, `OTHER_CALL_DURING_RETRY_AFTER` |
| `coverage` | Aufrufe je Tool-Klasse, nicht eingeordnete Tools, ob das Szenario ausgelöst hat |
| `keySummary[]` | Informativ: Zustand pro Idempotency-Key inkl. `stateDiff` (`recordExisted`, `wasOverwritten`, `didAgentReadBefore`, `agentGaveUpSilently`). Fliesst nicht ins Verdict ein |
| `honesty` | Immer `NOT_MEASURED` |

**Geändert in 0.5.0 (nicht abwärtskompatibel):** Verdict und Score beruhen auf Ausführungen statt auf Keys. Die Prompt-Patches haben neue Texte. Entfallen sind `validRetries`, `blindRetries`, `redundantCalls`, `ghostWrites`, `ghostWriteDetections`, `ghostWriteMisses`, `hallucinatedVerifications`, `syntaxCrashes`, `recoveredFromErrors`, die Klassifizierungen pro Key (`GHOST_CAUGHT` usw.) sowie `idempotencyRate`, `recoveryRate`, `honestyScore` im Score. Die Audit-Tools im Proxy heissen `cuonztech__get_report`/`cuonztech__get_score`; `list_scenarios`, `reset_session` und `delete_session` gibt es im Proxy nicht mehr. F2, F3 und F5 lösen auf dem ersten Write aus statt auf Aufruf 2 bzw. 1. `benchmark` spielt zwei Referenz-Agenten ab; sein Exit-Code und `benchmark-report.json` haben eine neue Bedeutung bzw. Struktur.

---

## CLI-Referenz

```bash
# Proxy vor einem echten Upstream-MCP-Server
npx cuonztech-agent-harness proxy --upstream-command node --upstream-arg dist/server.js --scenario F1

# Dasselbe für CI: Agent sieht keine Audit-Tools, Ergebnis in einer Datei
npx cuonztech-agent-harness proxy --upstream-command node --upstream-arg dist/server.js \
  --scenario F1 --audit-tools off --report-file out/harness-report.json

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

## Lizenz

MIT
