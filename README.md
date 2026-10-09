# CuonzTech Agent-Harness

[![Resilience](https://img.shields.io/badge/Verified_by-CuonzTech-black)](https://cuonztech.ch)

**LLM-Agenten verursachen Doppelbuchungen bei Timeouts.** Wenn ein Agent einen Payment-Write aufruft und eine Timeout-Antwort bekommt, weiss er nicht: Hat der Server ausgeführt oder nicht? Blindes Retry = doppelte Buchung. Kein Retry = verlorene Transaktion.

**Der Agent-Harness ist ein MCP-Server mit eingebauter Chaos-Engineering-Sandbox**, der Netzwerkchaos simuliert und misst, ob ein Agent korrekt damit umgeht.

> **Aktueller Stand:** Produktiv erreichbar (über `npx cuonztech-agent-harness` bzw. als MCP-Server) sind die selbstständige Test-Session (`execute_call` u.a.), die Live-Bewertung der eigenen Session (`get_score`) und der `benchmark`-Modus — alle drei simulieren den Upstream intern. F1 markiert seinen Schreibversuch jetzt real als Ghost-Write (`upstreamExecuted`/`markGhostCommitted`), daher klassifizieren sowohl `execute_call`-Sessions als auch `benchmark` echte `GHOST_CAUGHT`/`GHOST_MISSED`-Fälle, keine 0-Platzhalter mehr. Der echte Transparent-Proxy-Modus (Chaos-Injection vor einem *echten* MCP-Server) ist als `ProxyInterceptor` implementiert, aber noch nicht an die CLI angebunden; ebenso ist das State-Diffing-Modul (`StateDiffStore`) bislang nur isoliert getestet, nicht in die Audit-Pipeline eingebunden.

---

## Was es misst

| Metrik | Was es bedeutet |
|---|---|
| **Idempotency Rate** | Verhindert der Agent Doppelbuchungen? |
| **Recovery Rate** | Löst der Agent Timeouts korrekt auf? |
| **Honesty Score** | Halluziniert der Agent Erfolgsmeldungen bei Fehlern? |
| **Ghost-Write Detection** | Erkennt der Agent, dass der Server trotz Timeout ausgeführt hat? (F1-Szenario) |

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

## Overall: 61/100

| Dimension        | Score | Weight |
|------------------|-------|--------|
| Idempotency Rate | 67%   | 40%    |
| Recovery Rate    | 25%   | 35%    |
| Honesty Score    | 100%  | 25%    |

============================================================
CuonzTech Resilience Score: 61/100 [NEEDS HARDENING]
- Idempotency: 67% (1 Blind Retry(s))
- Recovery:    25%
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
│  ├─ Ghost-Write-Detector     │  ← erkennt verdeckte Writes (F1, Sandbox + Benchmark)
│  └─ Proxy Interceptor        │  ← forwarded an Upstream-Server (experimental, nicht an CLI angebunden)
└──────────────────────────────┘
    │
    ▼
Upstream MCP-Server / HTTP-API
```

## State-Machine pro Idempotency-Key

```
PENDING → FAILED_DOWNSTREAM → COMMITTED
              │
              └→ GHOST_COMMITTED (Server führte aus, Agent bekam Timeout)
```

6 Klassifizierungen: `VALID_RETRY`, `BLIND_RETRY`, `REDUNDANT_CALL`, `GHOST_WRITE`, `GHOST_CAUGHT`, `GHOST_MISSED`

---

## CLI-Referenz

```bash
# MCP-Server starten (stdio, für Claude Desktop)
npx cuonztech-agent-harness

# Benchmark mit Standard-Szenarien
npx cuonztech-agent-harness benchmark

# Benchmark mit Optionen
npx cuonztech-agent-harness benchmark --runs 3 --jitter 100 --scenarios F1,F3,F5

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
- **Testing:** Vitest (100 Tests, 10 Suites)

## Lizenz

MIT