# Messung an echten MCP-Servern: wie gut ordnet der Harness Tools ein?

Stand 2026-11-13, Harness 0.10.0. Der Harness muss wissen, welche Tools schreiben: Nur von diesen löst ein Szenario aus, nur sie werden bewertet. Was er nicht einordnen kann, meldet er («nicht eingeordnet») und bewertet es nicht. Diese Messung zeigt, wie oft er richtig liegt, an **376 Tools aus 24 öffentlichen Servern**.

Daten: `tests/accuracy/real-servers.json` (Name, Wahrheit, Quelle der Wahrheit, Serverversion). Test: `tests/accuracy/real-servers.test.ts` (die Zahlen unten sind dort festgenagelt).

## Wie gemessen wurde

- **Server:** die npm-Pakete der Server, installiert ohne Install-Skripte, gestartet mit **Dummy-Zugangsdaten** auf dem eigenen Rechner. Gelesen wurde nur `tools/list`. Kein Tool wurde aufgerufen, nichts wurde geschrieben, kein fremdes System kontaktiert.
- **Wahrheit:** Meldet der Server `readOnlyHint` (die Annotation, die MCP dafür vorsieht), gilt sie (`annotation`). Sonst habe ich das Tool nach seiner Beschreibung von Hand beschriftet (`manual`). **Diese Beschriftung ist mein Urteil**, nicht eine unabhängige Prüfung. Tools, die beides tun (Namespace-Tools wie die 68 von Azure, Browser-Aktionen wie `click`, `navigate`, `execute_sql`), sind **nicht gewertet**.
- **Gemessen wird die Einordnung nur nach dem Namen**, so wie sie bei einem Server ohne Annotationen entsteht. Das ist der schwierige Fall; liefert ein Server Annotationen, nutzt der Harness sie zuerst (Spalte «ausgeliefert»).
- **Zwei Mengen:** Menge A (14 Server, 200 Tools) hat die Lücken sichtbar gemacht. Menge B (10 weitere Server, 176 Tools) habe ich **vor** der Änderung als Kontrollmenge gemessen. Die Wortliste der neuen Regel habe ich danach um Wörter ergänzt, die in B fehlten (zum Beispiel `restart`, `promote`, `link`, `kill`). B ist deshalb **keine vollständig unabhängige** Kontrolle mehr, und die Zahlen sind eine obere Schätzung.

Menge A: filesystem 2.3.0, memory 2.1.1, sequential-thinking 2.1.1, everything 2.3.0, github 2025.4.8, slack 2025.4.25, brave-search 0.6.2, puppeteer 2025.5.12, playwright 0.0.85, context7 4.7.0, notion 2.6.1, firecrawl 3.40.0, supabase 0.17.0, postgres 0.6.2.
Menge B: sentry 0.49.0, exa 3.4.3, mapbox 0.18.0, heroku 1.2.14, kubernetes 4.2.3, browserbase 2.4.3, elasticsearch 0.3.1, google-maps 0.6.2, everart 0.6.2, azure 4.0.0-beta.7.
Nicht messbar (Installation, Start ohne Zugang, Protokollfehler oder Remote-Dienst): gitlab, gdrive, stripe, neon, cloudflare, redis, upstash.

## Ergebnis

Richtig = Name führt zur Wahrheit (Write → Write, Read → Read).

| | 0.9.0, nur Name | 0.10.0, nur Name | 0.9.0, ausgeliefert | 0.10.0, ausgeliefert |
|---|---:|---:|---:|---:|
| Menge A (200 Tools) | 77 (39 %) | **151 (76 %)** | 183 (92 %) | **196 (98 %)** |
| Menge B (176 Tools) | 85 (48 %) | **119 (68 %)** | 145 (82 %) | **159 (90 %)** |

«Ausgeliefert» heisst: Annotation des Servers zuerst, sonst Name.

Wohin die Fehler gehen (nur Name, 0.10.0):

| | Write als Read (still) | Write nicht eingeordnet | Read als Write | Read nicht eingeordnet |
|---|---:|---:|---:|---:|
| Menge A | **1** (0.9.0: 0) | 24 (0.9.0: 61) | 2 (0.9.0: 1) | 22 (0.9.0: 61) |
| Menge B | **0** (0.9.0: 0) | 10 (0.9.0: 31) | 2 (0.9.0: 1) | 45 (0.9.0: 59) |

**Was das heisst**

- Der Harness rät bei einem unklaren Namen nicht: Die meisten Fehler sind «nicht eingeordnet», nicht «falsch eingeordnet». Ein Tool ohne Einordnung löst kein Szenario aus und wird nicht bewertet; der Proxy warnt beim Start.
- **Gefährlich ist nur ein Write, der als Read gilt**, weil Duplikate darüber dann unsichtbar bleiben. In 0.9.0 gab es in beiden Mengen keinen. Die neue Regel (Verb irgendwo im Namen) bringt **einen**: `firecrawl_search_feedback` (sendet Feedback, heisst aber «search»). Die Beschreibung widerspricht dem Namen, und der Zweifels-Hinweis erkennt es.
- Die beiden Reads, die als Write gelten (`trigger-resource-update`, `extension_cli_install`), und `place_details_tool` (Muster `place_*`) sind Lärm: ein Szenario kann auf einem Read auslösen. Das fällt im Bericht auf, bleibt aber ohne stilles Falsch-PASS.

## Was die neue Regel tut

Für Tools, die weder Annotation noch `--write-tools`/`--read-tools` noch ein Präfix-Muster einordnet, sucht der Harness ein Verb **an beliebiger Stelle** im Namen (`slack_post_message`, `API-patch-page`, `kubectl_apply`, `ps_scale`, `pipelines_create`). Kommen ein Schreib- und ein Lesewort vor (`get_or_create_user`, `API-post-search`), bleibt das Tool unklar. Mit eigenen `--write-tools`/`--read-tools` ist die Regel aus. Bisher Eingeordnetes ändert sich nicht.

## Was weiter offen bleibt

- **Namen ohne Verb**, vor allem Werkzeug-Suffixe (`union_tool`, `buffer_tool`, `bbox_tool` bei Mapbox) und Browser-Aktionen (`browser_click`, `puppeteer_fill`). Das sind meist Reads oder mehrdeutige Aktionen; ohne Annotation bleiben sie «nicht eingeordnet». **Empfehlung an Server-Autoren: `readOnlyHint` setzen.** Dann ist die Einordnung ohne jede Namens-Heuristik richtig.
- **Namespace-Tools** (Azure: ein Tool mit Befehlen zum Lesen und Schreiben) lassen sich nicht in lesend oder schreibend teilen. Dafür gibt es keine richtige Antwort auf Tool-Ebene.
- **Fehleinordnung durch das Verb** (`search_feedback`): Der Zweifels-Hinweis fängt sie nur, wenn die Beschreibung eines der bekannten Verben enthält.

## Grenzen dieser Messung

- Die Wahrheit ist bei 106 von 376 Tools meine Beschriftung (`manual`), bei 270 die Annotation des Servers. Eine Annotation kann selbst falsch sein.
- 24 Server sind eine Stichprobe öffentlicher, bekannter Server, nicht der Markt. Server mit deutschen oder eigenen Namenskonventionen sind kaum darunter.
- Es wurde nur die Tool-Liste gelesen. Wie sich ein Tool bei einem Aufruf wirklich verhält, ist nicht geprüft.
- Die Zahlen gelten für die genannten Serverversionen; die Tool-Listen ändern sich.
