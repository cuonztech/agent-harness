# Lückensuche, Stufe 1: Namensmatrix

_Erzeugt von `tests/luecken/namen.test.ts` (`LUECKEN=1`). Nicht von Hand ändern._

14904 Namen aus Verb × Objekt × Schreibweise × Beschreibung (EN/DE/FR/ES, 30 Stile) und 30 handbeschriftete Fallen (je mit und ohne Beschreibung). Die Wahrheit steht durch die Konstruktion fest, nicht durch die Wortliste des Harness. **Gefährlich ist nur «Write als Read»** (ein Schreib-Tool gilt still als Lese-Tool: Duplikate bleiben unsichtbar). «Nicht eingeordnet» ist sicher (der Harness warnt), aber ohne Wirkung.

### Gesamt nach Beschreibung

| | Fälle | richtig | nicht eingeordnet | falsch eingeordnet | davon Write als Read |
|---|---:|---:|---:|---:|---:|
| Write, ohne Beschreibung | 3784 | 96 % | 4 % | 0 | 0 |
| Write, passende Beschreibung | 3784 | 100 % | 0 % | 0 | 0 |
| Write, neutrale Beschreibung | 3784 | 96 % | 4 % | 0 | 0 |
| Read, ohne Beschreibung | 1184 | 53 % | 47 % | 0 | 0 |
| Read, passende Beschreibung | 1184 | 53 % | 47 % | 0 | 0 |
| Read, neutrale Beschreibung | 1184 | 53 % | 47 % | 0 | 0 |

### Nur Name, nach Sprache

| | Fälle | richtig | nicht eingeordnet | falsch eingeordnet | davon Write als Read |
|---|---:|---:|---:|---:|---:|
| Write, en | 1995 | 93 % | 7 % | 0 | 0 |
| Write, de | 889 | 100 % | 0 % | 0 | 0 |
| Write, fr | 450 | 100 % | 0 % | 0 | 0 |
| Write, es | 450 | 100 % | 0 % | 0 | 0 |
| Read, en | 480 | 41 % | 59 % | 0 | 0 |
| Read, de | 299 | 65 % | 35 % | 0 | 0 |
| Read, fr | 210 | 64 % | 36 % | 0 | 0 |
| Read, es | 195 | 54 % | 46 % | 0 | 0 |

### Nur Name, nach Schreibweise (Write)

| | Fälle | richtig | nicht eingeordnet | falsch eingeordnet | davon Write als Read |
|---|---:|---:|---:|---:|---:|
| snake | 241 | 99 % | 1 % | 0 | 0 |
| kebab | 241 | 98 % | 2 % | 0 | 0 |
| camel | 241 | 99 % | 1 % | 0 | 0 |
| pascal | 241 | 100 % | 0 % | 0 | 0 |
| upper | 241 | 99 % | 1 % | 0 | 0 |
| objekt-zuerst | 241 | 93 % | 7 % | 0 | 0 |
| punkt | 241 | 90 % | 10 % | 0 | 0 |
| schraegstrich | 241 | 90 % | 10 % | 0 | 0 |
| namespace | 241 | 90 % | 10 % | 0 | 0 |
| mcp-praefix | 241 | 90 % | 10 % | 0 | 0 |
| api-v2 | 241 | 98 % | 2 % | 0 | 0 |
| suffix-tool | 241 | 100 % | 0 % | 0 | 0 |
| suffix-v2 | 241 | 100 % | 0 % | 0 | 0 |
| plural | 241 | 100 % | 0 % | 0 | 0 |
| nur-verb | 241 | 99 % | 1 % | 0 | 0 |
| mcp-praefix+umlaut | 11 | 100 % | 0 % | 0 | 0 |
| suffix-tool+umlaut | 11 | 100 % | 0 % | 0 | 0 |
| snake+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| kebab+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| camel+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| pascal+umlaut | 10 | 100 % | 0 % | 0 | 0 |
| upper+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| objekt-zuerst+umlaut | 11 | 100 % | 0 % | 0 | 0 |
| punkt+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| schraegstrich+umlaut | 11 | 100 % | 0 % | 0 | 0 |
| namespace+umlaut | 11 | 100 % | 0 % | 0 | 0 |
| api-v2+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| suffix-v2+umlaut | 11 | 100 % | 0 % | 0 | 0 |
| plural+umlaut | 12 | 100 % | 0 % | 0 | 0 |
| nur-verb+umlaut | 9 | 100 % | 0 % | 0 | 0 |

### Nur Name, nach Schreibweise (Read)

| | Fälle | richtig | nicht eingeordnet | falsch eingeordnet | davon Write als Read |
|---|---:|---:|---:|---:|---:|
| snake | 76 | 57 % | 43 % | 0 | 0 |
| kebab | 76 | 57 % | 43 % | 0 | 0 |
| camel | 76 | 57 % | 43 % | 0 | 0 |
| pascal | 76 | 57 % | 43 % | 0 | 0 |
| upper | 76 | 57 % | 43 % | 0 | 0 |
| objekt-zuerst | 76 | 49 % | 51 % | 0 | 0 |
| punkt | 76 | 50 % | 50 % | 0 | 0 |
| schraegstrich | 76 | 51 % | 49 % | 0 | 0 |
| namespace | 76 | 51 % | 49 % | 0 | 0 |
| mcp-praefix | 76 | 51 % | 49 % | 0 | 0 |
| api-v2 | 76 | 51 % | 49 % | 0 | 0 |
| suffix-tool | 76 | 57 % | 43 % | 0 | 0 |
| suffix-v2 | 76 | 57 % | 43 % | 0 | 0 |
| plural | 76 | 57 % | 43 % | 0 | 0 |
| nur-verb | 76 | 57 % | 43 % | 0 | 0 |
| mcp-praefix+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| suffix-tool+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| namespace+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| suffix-v2+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| pascal+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| api-v2+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| plural+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| snake+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| kebab+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| camel+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| upper+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| punkt+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| objekt-zuerst+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| schraegstrich+umlaut | 3 | 33 % | 67 % | 0 | 0 |
| nur-verb+umlaut | 2 | 0 % | 100 % | 0 | 0 |

### Fallen (Wort und Wirkung laufen auseinander)

| | Fälle | richtig | nicht eingeordnet | falsch eingeordnet | davon Write als Read |
|---|---:|---:|---:|---:|---:|
| Write · falle | 15 | 93 % | 0 % | **1** | **1** |
| Write · falle (nur Name) | 15 | 93 % | 0 % | **1** | **1** |
| Read · falle | 15 | 13 % | 33 % | **8** | 0 |
| Read · falle (nur Name) | 15 | 13 % | 20 % | **10** | 0 |

### Stilles «Write als Read»: Matrix

Keines.
### Stilles «Write als Read»: Fallen

- `getV2` (falle), Quelle `read prefix`
- `getV2` (falle (nur Name)), Quelle `read prefix`

### Schreib-Verben, die in mindestens 8 Schreibweisen ohne Einordnung bleiben (Wortlisten-Lücken)

`en:issue` (8), `en:confirm` (8), `en:swap` (8), `en:ban` (8)

### Lese-Verben ohne Einordnung (nur Lärm: das Tool löst nichts aus, wird aber nicht bewertet)

`de:pruefen` (30), `de:zaehlen` (30), `en:browse` (15), `en:summarize` (15), `en:explain` (15), `en:preview` (15), `en:validate` (15), `en:compare` (15), `en:calculate` (15), `en:estimate` (15), `en:download` (15), `en:poll` (15), `en:peek` (15), `en:scan` (15), `en:probe` (15), `en:locate` (15), `en:enumerate` (15), `en:load` (15), `en:open` (15), `de:ausgeben` (15), `de:berechnen` (15), `de:vergleichen` (15), `fr:compter` (15), `fr:verifier` (15), `fr:decrire` (15), `fr:comparer` (15), `fr:calculer` (15), `es:contar` (15), `es:verificar` (15), `es:describir` (15), `es:comparar` (15), `es:calcular` (15), `es:ver` (15)

### Fallen einzeln (mit Beschreibung → nur Name)

| Name | Wahrheit | mit Beschreibung | nur Name |
|---|---|---|---|
| `check_in_guest` | write | richtig | richtig |
| `status_change` | write | richtig | richtig |
| `get_or_create_user` | write | richtig | richtig |
| `read_and_delete_message` | write | richtig | richtig |
| `list_and_clear_queue` | write | richtig | richtig |
| `view_and_mark_read` | write | richtig | richtig |
| `count_and_increment` | write | richtig | richtig |
| `getV2` | write | write-als-read (+Hinweis) | write-als-read |
| `check_out` | write | richtig | richtig |
| `status_set` | write | richtig | richtig |
| `peek_and_ack` | write | richtig | richtig |
| `fetch_and_lock_job` | write | richtig | richtig |
| `lookup_or_register_device` | write | richtig | richtig |
| `validate_and_submit_form` | write | richtig | richtig |
| `preview_and_publish` | write | richtig | richtig |
| `update_status_view` | read | read-als-write (+Hinweis) | read-als-write |
| `create_report_preview` | read | read-als-write | read-als-write |
| `send_test_preview` | read | read-als-write | read-als-write |
| `set_filter_view` | read | read-offen | read-als-write |
| `delete_preview` | read | read-als-write | read-als-write |
| `run_query` | read | richtig | richtig |
| `execute_search` | read | read-offen | read-offen |
| `apply_filter` | read | read-offen | read-als-write |
| `post_search` | read | read-als-write | read-als-write |
| `tag_list` | read | richtig | richtig |
| `mark_list` | read | read-offen | read-offen |
| `order_status` | read | read-offen | read-offen |
| `book_availability` | read | read-als-write | read-als-write |
| `invoice_pdf_render` | read | read-als-write | read-als-write |
| `send_status` | read | read-als-write | read-als-write |
