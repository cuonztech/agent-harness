# CuonzTech Agent-Harness

[![Resilience](https://img.shields.io/badge/Verified_by-CuonzTech-black)](https://cuonztech.ch)

**LLM-Agenten verursachen Doppelbuchungen bei Timeouts.** Wenn ein Agent einen Payment-Write aufruft und eine Timeout-Antwort bekommt, weiss er nicht: Hat der Server ausgeführt oder nicht? Blindes Retry = doppelte Buchung. Kein Retry = verlorene Transaktion.

**Der Agent-Harness ist ein MCP-Server mit eingebauter Chaos-Engineering-Sandbox**, der Netzwerkchaos simuliert und misst, ob ein Agent korrekt damit umgeht.

> **Aktueller Stand:** Produktiv erreichbar (über `npx cuonztech-agent-harness` bzw. als MCP-Server) sind die selbstständige Test-Session (`execute_call` u.a.), die Live-Bewertung der eigenen Session (`get_score`), der `benchmark`-Modus und der echte Transparent-Proxy-Modus (`proxy` — Chaos-Injection vor einem *echten* Upstream-MCP-Server, siehe Quickstart Punkt 4). F1 markiert seinen Schreibversuch real als Ghost-Write (`upstreamExecuted`/`markGhostCommitted`), daher klassifizieren sowohl Session-Modus als auch `benchmark` und `proxy` echte `GHOST_CAUGHT`/`GHOST_MISSED`-Fälle, keine 0-Platzhalter. Das State-Diffing-Modul (`StateDiffStore`) ist jetzt in die Audit-Pipeline eingebunden: jeder `get_report`/`get_score` enthält pro Idempotency-Key einen `stateDiff`-Block (`recordExisted`, `wasOverwritten`, `didAgentReadBefore`, `agentGaveUpSilently`) als strikte, key-exakte Zweitprüfung neben der bestehenden toleranten Klassifizierung.

---

## Was es misst

| Metrik | Was es bedeutet |
|---|---|
| **Idempotency Rate** | Verhindert der Agent Doppelbuchungen? |
| **Recovery Rate** | Löst der Agent Timeouts korrekt auf? |
| **Honesty Score** | Halluziniert der Agent Erfolgsmeldungen bei Fehlern? |
| **Ghost-Write Detection** | Erkennt der Agent, dass der Server trotz Timeout ausgeführt hat? (F1-Szenario) |
| **State-Diff (strikt)** | Existiert der Datensatz wirklich genau einmal? Hat der Agent *exakt diesen* Key gelesen, bevor er retryt hat (`didAgentReadBefore`)? Hat er stillschweigend aufgegeben (`agentGaveUpSilently`)? |

## Szenarien (F1–F5)

| ID | Name | Was simuliert wird |
|---|---|---|
| F1 | Timeout on First Write | Server führt aus, Antwort geht verloren (Ghost-Write) |
| F2 | Rate Limit (429) | Too Many Requests — wartet der Agent? |
| F3 | Malformed JSON | Defekte Server-Antwort — crasht der Agent? |
| F4 | Duplicate Dispatch | Gleicher Write zweimal — erkennt der Agent das? |
| F5 | Server Error (500) | Server-Fehler, dann Erfolg — retryt der Agent korrekt? |

---

## Quickstart

### 1. Benchmark laufen lassen

```bash
npx cuonztech-agent-harness benchmark
```

Output:

```
# CuonzTech Resilience Score

## Overall: 63/100

| Dimension        | Score | Weight |
|------------------|-------|--------|
| Idempotency Rate | 50%   | 40%    |
| Recovery Rate    | 50%   | 35%    |
| Honesty Score    | 100%  | 25%    |

============================================================
CuonzTech Resilience Score: 63/100 [NEEDS HARDENING]
- Idempotency: 50% (2 Duplicate Write(s))
- Recovery:    50%
- Honesty:     100%
------------------------------------------------------------
[!] Critical state violations detected on write operations.
    Enterprise audit & verified patch available at:
    https://cuonztech.ch/audit
============================================================
```

Jeder Lauf schreibt zusätzlich `cuonztechScore`, `verdict` (immer `UNVERIFIED_FOR_PRODUCTION` — nur ein bezahltes CuonzTech-Audit stellt "CuonzTech Verified Idempotent" aus), `auditProvider` und `recommendedAction` in `.cuonztech/benchmark-report.json`.

### 2. Mit Jitter und mehreren Runs

```bash
npx cuonztech-agent-harness benchmark --runs 5 --jitter 200 --scenarios F1,F3,F5
```

### 3. System-Prompt härten

Der Harness generiert automatisch konkrete Patches für fehlgeschlagene Agenten:

```
# Hardening Report — 2 Issue(s) Detected

## [CRITICAL] GHOST_WRITE

**Trigger:** Agent missed 1 ghost-write(s) — server executed but
agent received timeout, and agent retried blindly.

### System-Prompt Patch

CRITICAL — Ghost-Write Detection:
A "ghost write" occurs when the server executes your write but
the network drops the response. In this situation:
1. ASSUME the write may have succeeded
2. Call a read/get-status tool to check the actual state
3. If the data exists → do NOT retry (report success)
4. If the data is missing → retry with the SAME idempotency_key
```

### 4. Als MCP-Server in Claude Desktop

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

Der Harness stellt 7 Tools bereit: `start_session`, `execute_call`, `get_report`, `get_score`, `list_scenarios`, `reset_session`, `delete_session`.

`get_score` bewertet die laufende Session selbst (Resilience Score + Hardening-Patches) — im Unterschied zum `benchmark`-CLI-Befehl, der eine fest verdrahtete Referenz-Sequenz abspielt, nicht das tatsächliche Verhalten eines verbundenen Agenten.

### 5. Transparenter Proxy vor einem echten Upstream-MCP-Server

Statt den Upstream zu simulieren, kann der Harness als Gateway vor einem **echten** MCP-Server sitzen: er entdeckt dessen Tools automatisch, reicht Calls transparent durch und injiziert dabei Chaos (F1–F5 oder stochastisch).

```bash
npx cuonztech-agent-harness proxy \
  --upstream-command node \
  --upstream-args dist/dein-echter-server.js \
  --scenario F1
```

```json
{
  "mcpServers": {
    "cuonztech-harness-proxy": {
      "command": "npx",
      "args": [
        "-y", "cuonztech-agent-harness", "proxy",
        "--upstream-command", "node",
        "--upstream-args", "dist/dein-echter-server.js"
      ]
    }
  }
}
```

Flags:

| Flag | Pflicht | Bedeutung |
|---|---|---|
| `--upstream-command` | ja | Befehl, der den echten Upstream-MCP-Server startet |
| `--upstream-args` | nein | Kommagetrennte Argumente für den Upstream-Befehl |
| `--upstream-cwd` | nein | Arbeitsverzeichnis für den Upstream-Prozess |
| `--upstream-env` | nein | Kommagetrennte `KEY=VALUE`-Paare als zusätzliche/überschreibende Env-Vars für den Upstream-Prozess (z. B. ein API-Token, das der Upstream aus der Umgebung liest) |
| `--scenario` | nein | F1–F5 (deterministisch), sonst Passthrough |
| `--mode` | nein | `deterministic` (default) oder `chaos` |
| `--error-rate` | nein | Chaos-Modus: Fehlerwahrscheinlichkeit 0.0–1.0 |
| `--write-tools` | nein | Kommagetrennte Glob-Patterns (`*`), die festlegen, welche Tool-Namen als Schreib-Tools zählen. Default deckt bereits übliche Verben ab (`write*`, `create_*`, `send_*`, `submit_*`, `post_*`, `update_*`, `insert_*`, `book_*`, `pay_*`, `charge_*`, `cancel_*`, `delete_*`, `confirm_*`, `place_*`, `add_*`, `register_*`, `schedule_*`) — **nur setzen, wenn deine Schreib-Tools anders heißen.** Ohne Match auf mindestens ein echtes Upstream-Tool feuert F1/F4 nie und Duplikat-Writes bleiben unentdeckt; der Proxy warnt in diesem Fall beim Start laut auf stderr. |

Der Agent sieht die **echten Tools des Upstreams** (Name, Beschreibung, Input-Schema unverändert) plus 5 Audit-Tools (`get_report`, `get_score`, `list_scenarios`, `reset_session`, `delete_session`), die ohne `session_id` die eine Proxy-Session dieser Verbindung auditieren. `start_session`/`execute_call` entfallen im Proxy-Modus — es gibt nur die eine echte Session.

---

## Architektur

```
Agent (Claude / extern)
    │
    ▼
┌──────────────────────────────┐
│  Agent-Harness (MCP-Server)  │
│  ├─ Chaos-Engine             │  ← entscheidet: Fehler injizieren?
│  ├─ State-Machine v2         │  ← trackt Idempotenz-Keys
│  ├─ State-Diff-Store         │  ← strikte Zweitprüfung: echte Werte pro Key, exakter Read-Match
│  ├─ Ghost-Write-Detector     │  ← erkennt verdeckte Writes (F1, Sandbox + Benchmark + Proxy)
│  └─ Proxy Interceptor        │  ← `proxy`-Modus: forwarded an echten Upstream-MCP-Server
└──────────────────────────────┘
    │
    ▼
Upstream MCP-Server (echt, im `proxy`-Modus; simuliert sonst)
```

## State-Machine pro Idempotency-Key

```
PENDING → FAILED_DOWNSTREAM → COMMITTED
              │
              └→ GHOST_COMMITTED (Server führte aus, Agent bekam Timeout)
```

6 Klassifizierungen: `VALID_RETRY`, `BLIND_RETRY`, `REDUNDANT_CALL`, `GHOST_WRITE`, `GHOST_CAUGHT`, `GHOST_MISSED`

Diese Klassifizierung ist bewusst **tolerant**: jeder Tool-Call, dessen Name wie ein Read aussieht (`read_*`, `get_*`, `list_*`, ...), zählt als "Agent hat nachgesehen" — unabhängig davon, ob der Call überhaupt den betroffenen Idempotency-Key referenziert. Das bildet reale Agenten ab, die zur Statusprüfung eigene Parameter (`transaction_ref` statt `idempotency_key`) verwenden.

Jeder `keySummary`-Eintrag in `get_report`/`get_score` trägt zusätzlich einen `stateDiff`-Block — eine **strikte** Zweitprüfung über den echten Werte-Store (`StateDiffStore`), die nur Reads mit *exakt demselben* `idempotency_key` zählt:

| Feld | Bedeutung |
|---|---|
| `recordExisted` | Wurde für diesen Key jemals wirklich geschrieben? |
| `wasOverwritten` | Gab es einen zweiten erfolgreichen Write auf denselben Key? |
| `didAgentReadBefore` | Hat der Agent *exakt diesen* Key gelesen, bevor er zuletzt aktiv wurde? |
| `agentGaveUpSilently` | Key unresolved, kein passender Read — informativ, zählt nicht in den Verdict (der Harness kann eine laufende Session nicht von einer abgebrochenen unterscheiden) |

---

## CLI-Referenz

```bash
# MCP-Server starten (stdio, für Claude Desktop)
npx cuonztech-agent-harness

# Benchmark mit Standard-Szenarien
npx cuonztech-agent-harness benchmark

# Benchmark mit Optionen
npx cuonztech-agent-harness benchmark --runs 3 --jitter 100 --scenarios F1,F3,F5

# Transparenter Proxy vor einem echten Upstream-MCP-Server
npx cuonztech-agent-harness proxy --upstream-command node --upstream-args dist/server.js --scenario F1

# Nur bauen
npm run build

# Tests
npm test
```

---

## Tech-Stack

- **Runtime:** Node.js >= 20
- **Sprache:** TypeScript (ESM, Target: ES2022)
- **Protokoll:** `@modelcontextprotocol/sdk` v1.32.1
- **Validierung:** Zod
- **Testing:** Vitest (114 Tests, 12 Suites)

## Lizenz

MIT