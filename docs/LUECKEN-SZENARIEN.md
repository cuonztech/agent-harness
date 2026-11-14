# Lückensuche, Stufe 2: Szenario-Matrix

_Erzeugt von `tests/luecken/szenarien.test.ts` (`LUECKEN=1`). Nicht von Hand ändern._

3072 Zellen (219 s), jede gegen den echten Proxy. Wahrheit = Ledger des Upstreams (Datensätze > gewollt) bzw. Regelverstoss bei F2. **Falsch-PASS** = der Harness sagt PASS, obwohl ein Duplikat/Regelverstoss entstand (gefährlich). **Falsch-FAIL** = FAIL ohne Duplikat. **NOT_TESTED** = keine Aussage trotz klarer Wahrheit.

Gesamt: richtig 2314, **Falsch-PASS 48**, Falsch-FAIL 217, NOT_TESTED 493.

### Nach Szenario

| | Zellen | richtig | **Falsch-PASS** | Falsch-FAIL | NOT_TESTED |
|---|---:|---:|---:|---:|---:|
| none | 512 | 336 | **4** | **64** | 108 |
| F1 | 512 | 323 | **8** | **64** | 117 |
| F2 | 512 | 459 | **32** | **5** | 16 |
| F3 | 512 | 430 | 0 | **10** | 72 |
| F4 | 512 | 336 | **4** | **64** | 108 |
| F5 | 512 | 430 | 0 | **10** | 72 |

### Nach Upstream-Dedup

| | Zellen | richtig | **Falsch-PASS** | Falsch-FAIL | NOT_TESTED |
|---|---:|---:|---:|---:|---:|
| none | 768 | 601 | **12** | **32** | 123 |
| key | 768 | 592 | **12** | **41** | 123 |
| requestid | 768 | 592 | **12** | **41** | 123 |
| natural | 768 | 529 | **12** | **103** | 124 |

### Nach Upstream-Fehlerart (erster Aufruf)

| | Zellen | richtig | **Falsch-PASS** | Falsch-FAIL | NOT_TESTED |
|---|---:|---:|---:|---:|---:|
| none | 768 | 680 | **8** | **56** | 24 |
| text | 768 | 596 | **8** | **140** | 24 |
| iserror | 768 | 523 | **8** | **9** | 228 |
| partial | 768 | 515 | **24** | **12** | 217 |

### Nach Sonde

| | Zellen | richtig | **Falsch-PASS** | Falsch-FAIL | NOT_TESTED |
|---|---:|---:|---:|---:|---:|
| ohne Sonde | 1536 | 885 | **28** | **199** | 424 |
| mit --effect-probe | 1536 | 1429 | **20** | **18** | 69 |

### Nach Agent-Verhalten

| | Zellen | richtig | **Falsch-PASS** | Falsch-FAIL | NOT_TESTED |
|---|---:|---:|---:|---:|---:|
| V01 ein Aufruf, aufgegeben | 192 | 152 | 0 | 0 | 40 |
| V02 blindes Retry, gleiche Args, gleicher Key | 192 | 131 | 0 | **21** | 40 |
| V03 blindes Retry unter neuem Key | 192 | 137 | 0 | **15** | 40 |
| V04 blindes Retry ohne Key | 192 | 137 | 0 | **15** | 40 |
| V05 Retry umgeschrieben (Name klein, Datum anders) | 192 | 88 | **48** | 0 | 56 |
| V06 nachgesehen, nicht wiederholt | 192 | 152 | 0 | 0 | 40 |
| V07 nachgesehen, dann doch wiederholt | 192 | 131 | 0 | **21** | 40 |
| V08 zwei Gäste, keine Wiederholung | 192 | 192 | 0 | 0 | 0 |
| V09 zwei Gäste, der erste wird wiederholt | 192 | 141 | 0 | **27** | 24 |
| V10 zwei Gäste, der zweite wird wiederholt | 192 | 135 | 0 | **33** | 24 |
| V11 gleichzeitig, gleiche Args | 192 | 132 | 0 | **15** | 45 |
| V12 Wartezeit eingehalten, dann Retry | 192 | 123 | 0 | **21** | 48 |
| V13 drei Versuche | 192 | 154 | 0 | **22** | 16 |
| V14 Read über anderen Gast, dann Retry | 192 | 137 | 0 | **15** | 40 |
| V15 Write, dann update_booking (kein neuer Datensatz) | 192 | 192 | 0 | 0 | 0 |
| V16 anderes Write-Tool (create_order), Retry | 192 | 180 | 0 | **12** | 0 |

### Abweichungen: falsch-pass (48 Zellen in 4 Gruppen)

- **V05 Retry umgeschrieben (Name klein, Datum anders) · F2** — 32× (dedup key/natural/none/requestid; fehler iserror/none/partial/text; Sonde/ohne Sonde). Beispiel `F2-none-none-V05-o`: Urteil PASS, Wahrheit FAIL, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:CLEAN
- **V05 Retry umgeschrieben (Name klein, Datum anders) · F1** — 8× (dedup key/natural/none/requestid; fehler partial; Sonde/ohne Sonde). Beispiel `F1-none-partial-V05-o`: Urteil PASS, Wahrheit FAIL, Datensätze 2/1, Ausführungen laut Harness 1, Operationen create_booking:UPSTREAM_REJECTED, create_booking:UNVERIFIED_AFTER_TIMEOUT
- **V05 Retry umgeschrieben (Name klein, Datum anders) · none** — 4× (dedup key/natural/none/requestid; fehler partial; ohne Sonde). Beispiel `none-none-partial-V05-o`: Urteil PASS, Wahrheit FAIL, Datensätze 2/1, Ausführungen laut Harness 1, Operationen create_booking:UPSTREAM_REJECTED, create_booking:CLEAN
- **V05 Retry umgeschrieben (Name klein, Datum anders) · F4** — 4× (dedup key/natural/none/requestid; fehler partial; ohne Sonde). Beispiel `F4-none-partial-V05-o`: Urteil PASS, Wahrheit FAIL, Datensätze 2/1, Ausführungen laut Harness 1, Operationen create_booking:UPSTREAM_REJECTED, create_booking:CLEAN

### Abweichungen: falsch-fail (217 Zellen in 38 Gruppen)

- **V09 zwei Gäste, der erste wird wiederholt · none** — 9× (dedup key/natural/none/requestid; fehler none/text; Sonde/ohne Sonde). Beispiel `none-none-text-V09-o`: Urteil FAIL, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 3, Operationen create_booking:DUPLICATE_EXECUTION, create_booking:CLEAN
- **V09 zwei Gäste, der erste wird wiederholt · F1** — 9× (dedup key/natural/none/requestid; fehler none/text; Sonde/ohne Sonde). Beispiel `F1-none-text-V09-o`: Urteil FAIL, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 3, Operationen create_booking:DUPLICATE_EXECUTION, create_booking:CLEAN
- **V09 zwei Gäste, der erste wird wiederholt · F4** — 9× (dedup key/natural/none/requestid; fehler none/text; Sonde/ohne Sonde). Beispiel `F4-none-text-V09-o`: Urteil FAIL, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 3, Operationen create_booking:DUPLICATE_EXECUTION, create_booking:CLEAN
- **V02 blindes Retry, gleiche Args, gleicher Key · none** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V02-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V07 nachgesehen, dann doch wiederholt · none** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V07-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V12 Wartezeit eingehalten, dann Retry · none** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V12-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V02 blindes Retry, gleiche Args, gleicher Key · F1** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V02-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V07 nachgesehen, dann doch wiederholt · F1** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V07-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V12 Wartezeit eingehalten, dann Retry · F1** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V12-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V02 blindes Retry, gleiche Args, gleicher Key · F4** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V02-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V07 nachgesehen, dann doch wiederholt · F4** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V07-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V12 Wartezeit eingehalten, dann Retry · F4** — 7× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V12-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V10 zwei Gäste, der zweite wird wiederholt · none** — 6× (dedup natural; fehler iserror/none/partial/text; Sonde/ohne Sonde). Beispiel `none-natural-none-V10-o`: Urteil FAIL, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 3, Operationen create_booking:CLEAN, create_booking:DUPLICATE_EXECUTION
- **V10 zwei Gäste, der zweite wird wiederholt · F1** — 6× (dedup natural; fehler iserror/none/partial/text; Sonde/ohne Sonde). Beispiel `F1-natural-none-V10-o`: Urteil FAIL, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 3, Operationen create_booking:UNVERIFIED_AFTER_TIMEOUT, create_booking:DUPLICATE_EXECUTION
- **V10 zwei Gäste, der zweite wird wiederholt · F4** — 6× (dedup natural; fehler iserror/none/partial/text; Sonde/ohne Sonde). Beispiel `F4-natural-none-V10-o`: Urteil FAIL, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 3, Operationen create_booking:CLEAN, create_booking:DUPLICATE_EXECUTION
- **V03 blindes Retry unter neuem Key · none** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V03-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V04 blindes Retry ohne Key · none** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V04-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V11 gleichzeitig, gleiche Args · none** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V11-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V14 Read über anderen Gast, dann Retry · none** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `none-none-text-V14-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V03 blindes Retry unter neuem Key · F1** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V03-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V04 blindes Retry ohne Key · F1** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V04-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V11 gleichzeitig, gleiche Args · F1** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V11-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V14 Read über anderen Gast, dann Retry · F1** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F1-none-text-V14-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V10 zwei Gäste, der zweite wird wiederholt · F2** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F2-none-text-V10-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/2, Ausführungen laut Harness 2, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:DUPLICATE_EXECUTION
- **V10 zwei Gäste, der zweite wird wiederholt · F3** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F3-none-text-V10-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/2, Ausführungen laut Harness 2, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:DUPLICATE_EXECUTION
- **V13 drei Versuche · F3** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F3-none-text-V13-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V03 blindes Retry unter neuem Key · F4** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V03-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V04 blindes Retry ohne Key · F4** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V04-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V11 gleichzeitig, gleiche Args · F4** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V11-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V14 Read über anderen Gast, dann Retry · F4** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F4-none-text-V14-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V10 zwei Gäste, der zweite wird wiederholt · F5** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F5-none-text-V10-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/2, Ausführungen laut Harness 2, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:DUPLICATE_EXECUTION
- **V13 drei Versuche · F5** — 5× (dedup key/natural/none/requestid; fehler none/text; ohne Sonde). Beispiel `F5-none-text-V13-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_booking:DUPLICATE_EXECUTION
- **V13 drei Versuche · none** — 4× (dedup natural; fehler iserror/none/partial/text; ohne Sonde). Beispiel `none-natural-none-V13-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 3, Operationen create_booking:DUPLICATE_EXECUTION
- **V16 anderes Write-Tool (create_order), Retry · none** — 4× (dedup natural; fehler iserror/none/partial/text; ohne Sonde). Beispiel `none-natural-none-V16-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_order:DUPLICATE_EXECUTION
- **V13 drei Versuche · F1** — 4× (dedup natural; fehler iserror/none/partial/text; ohne Sonde). Beispiel `F1-natural-none-V13-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 3, Operationen create_booking:DUPLICATE_EXECUTION
- **V16 anderes Write-Tool (create_order), Retry · F1** — 4× (dedup natural; fehler iserror/none/partial/text; ohne Sonde). Beispiel `F1-natural-none-V16-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_order:DUPLICATE_EXECUTION
- **V13 drei Versuche · F4** — 4× (dedup natural; fehler iserror/none/partial/text; ohne Sonde). Beispiel `F4-natural-none-V13-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 3, Operationen create_booking:DUPLICATE_EXECUTION
- **V16 anderes Write-Tool (create_order), Retry · F4** — 4× (dedup natural; fehler iserror/none/partial/text; ohne Sonde). Beispiel `F4-natural-none-V16-o`: Urteil FAIL, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 2, Operationen create_order:DUPLICATE_EXECUTION

### Abweichungen: unentschieden (493 Zellen in 53 Gruppen)

- **V05 Retry umgeschrieben (Name klein, Datum anders) · none** — 20× (dedup key/natural/none/requestid; fehler none/partial/text; Sonde/ohne Sonde). Beispiel `none-none-none-V05-o`: Urteil NOT_TESTED, Wahrheit FAIL, Datensätze 2/1, Ausführungen laut Harness 2, Operationen create_booking:CLEAN, create_booking:CLEAN
- **V05 Retry umgeschrieben (Name klein, Datum anders) · F4** — 20× (dedup key/natural/none/requestid; fehler none/partial/text; Sonde/ohne Sonde). Beispiel `F4-none-none-V05-o`: Urteil NOT_TESTED, Wahrheit FAIL, Datensätze 2/1, Ausführungen laut Harness 2, Operationen create_booking:CLEAN, create_booking:CLEAN
- **V05 Retry umgeschrieben (Name klein, Datum anders) · F1** — 16× (dedup key/natural/none/requestid; fehler none/text; Sonde/ohne Sonde). Beispiel `F1-none-none-V05-o`: Urteil NOT_TESTED, Wahrheit FAIL, Datensätze 2/1, Ausführungen laut Harness 2, Operationen create_booking:UNVERIFIED_AFTER_TIMEOUT, create_booking:CLEAN
- **V01 ein Aufruf, aufgegeben · F1** — 16× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `F1-none-iserror-V01-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:UPSTREAM_REJECTED
- **V06 nachgesehen, nicht wiederholt · F1** — 16× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `F1-none-iserror-V06-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:UPSTREAM_REJECTED
- **V11 gleichzeitig, gleiche Args · F1** — 13× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `F1-none-iserror-V11-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V01 ein Aufruf, aufgegeben · none** — 12× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `none-none-iserror-V01-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:UPSTREAM_REJECTED
- **V06 nachgesehen, nicht wiederholt · none** — 12× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `none-none-iserror-V06-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:UPSTREAM_REJECTED
- **V01 ein Aufruf, aufgegeben · F4** — 12× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `F4-none-iserror-V01-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:UPSTREAM_REJECTED
- **V06 nachgesehen, nicht wiederholt · F4** — 12× (dedup key/natural/none/requestid; fehler iserror/partial; Sonde/ohne Sonde). Beispiel `F4-none-iserror-V06-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:UPSTREAM_REJECTED
- **V02 blindes Retry, gleiche Args, gleicher Key · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V02-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V03 blindes Retry unter neuem Key · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V03-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V04 blindes Retry ohne Key · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V04-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V07 nachgesehen, dann doch wiederholt · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V07-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V09 zwei Gäste, der erste wird wiederholt · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V09-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 2, Operationen create_booking:EXECUTION_UNKNOWN, create_booking:CLEAN
- **V11 gleichzeitig, gleiche Args · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V11-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V12 Wartezeit eingehalten, dann Retry · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V12-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V14 Read über anderen Gast, dann Retry · none** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `none-none-iserror-V14-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V02 blindes Retry, gleiche Args, gleicher Key · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V02-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V03 blindes Retry unter neuem Key · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V03-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V04 blindes Retry ohne Key · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V04-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V07 nachgesehen, dann doch wiederholt · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V07-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V09 zwei Gäste, der erste wird wiederholt · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V09-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 2, Operationen create_booking:EXECUTION_UNKNOWN, create_booking:UNVERIFIED_AFTER_TIMEOUT
- **V12 Wartezeit eingehalten, dann Retry · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V12-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V14 Read über anderen Gast, dann Retry · F1** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F1-none-iserror-V14-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V10 zwei Gäste, der zweite wird wiederholt · F2** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F2-none-iserror-V10-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/2, Ausführungen laut Harness 1, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:EXECUTION_UNKNOWN
- **V12 Wartezeit eingehalten, dann Retry · F2** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F2-none-iserror-V12-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V02 blindes Retry, gleiche Args, gleicher Key · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V02-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V03 blindes Retry unter neuem Key · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V03-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V04 blindes Retry ohne Key · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V04-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V07 nachgesehen, dann doch wiederholt · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V07-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V10 zwei Gäste, der zweite wird wiederholt · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V10-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/2, Ausführungen laut Harness 1, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:EXECUTION_UNKNOWN
- **V11 gleichzeitig, gleiche Args · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V11-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V12 Wartezeit eingehalten, dann Retry · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V12-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V13 drei Versuche · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V13-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V14 Read über anderen Gast, dann Retry · F3** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F3-none-iserror-V14-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V02 blindes Retry, gleiche Args, gleicher Key · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V02-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V03 blindes Retry unter neuem Key · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V03-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V04 blindes Retry ohne Key · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V04-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V07 nachgesehen, dann doch wiederholt · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V07-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V09 zwei Gäste, der erste wird wiederholt · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V09-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 2/2, Ausführungen laut Harness 2, Operationen create_booking:EXECUTION_UNKNOWN, create_booking:CLEAN
- **V11 gleichzeitig, gleiche Args · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V11-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V12 Wartezeit eingehalten, dann Retry · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V12-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V14 Read über anderen Gast, dann Retry · F4** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F4-none-iserror-V14-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V02 blindes Retry, gleiche Args, gleicher Key · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V02-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V03 blindes Retry unter neuem Key · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V03-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V04 blindes Retry ohne Key · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V04-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V07 nachgesehen, dann doch wiederholt · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V07-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V10 zwei Gäste, der zweite wird wiederholt · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V10-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/2, Ausführungen laut Harness 1, Operationen create_booking:ABANDONED_AFTER_FAILURE, create_booking:EXECUTION_UNKNOWN
- **V11 gleichzeitig, gleiche Args · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V11-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V12 Wartezeit eingehalten, dann Retry · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V12-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
- **V13 drei Versuche · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V13-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 1/1, Ausführungen laut Harness 1, Operationen create_booking:EXECUTION_UNKNOWN
- **V14 Read über anderen Gast, dann Retry · F5** — 8× (dedup key/natural/none/requestid; fehler iserror/partial; ohne Sonde). Beispiel `F5-none-iserror-V14-o`: Urteil NOT_TESTED, Wahrheit PASS, Datensätze 0/1, Ausführungen laut Harness 0, Operationen create_booking:EXECUTION_UNKNOWN
