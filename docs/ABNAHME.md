# Abnahmekriterien — Dienst-Reife des Agent-Harness

Stand: 27.10.2026. Dieses Dokument ist der Maßstab, ab wann der Harness als Dienst
angeboten wird. Jedes Kriterium hat einen Prüfweg und einen **ehrlichen Stand**.
Ein Kriterium gilt erst als erfüllt, wenn der Prüfweg grün ist.

| # | Kriterium | Prüfweg | Stand |
|---|---|---|---|
| A1 | Die README-Befehle funktionieren so, wie sie dastehen | `tests/readme-commands.test.ts` führt doctor, proxy, die Claude-Desktop-Konfiguration und report aus der README aus | **Teilweise.** Diese vier laufen automatisch; `claude mcp add` und die Docker-Befehle der README nicht |
| A2 | Vor jedem Lauf gibt es eine Vorprüfung, die jeden Fehler mit Lösung nennt | `doctor` (`tests/doctor.test.ts`) | **Erfüllt für die Fälle im Test:** Node-Version, fehlende Datei, Server-Absturz, unklassifizierte Tools, unbekannte Option. **Nicht abgedeckt:** Schreibrechte im Report-Verzeichnis nur grob, Netzwerkfragen |
| A3 | Ein Befehl bis zum Ergebnis, ohne Vorwissen | Kaltstart-Test mit einem Menschen, der die README nicht kennt | **Nicht erfüllt.** Der einzige Versuch (Engineer, 26.10.) ist an Node-Version, fehlendem Agenten und npm-Installation gescheitert |
| A4 | Reproduzierbare Umgebung (Container oder Installer) | `tests/container.test.ts` (nur mit `HARNESS_DOCKER_TEST=1`), dazu der Durchlauf doctor → proxy → report im Container | **Teilweise.** Dockerfile und lokal gebautes Image; Build, Version, Nicht-Root und doctor sind getestet, der Durchlauf bis zum HTML-Bericht wurde am 26.10. von Hand geprüft. **Offen:** Basis-Image nicht per Digest gepinnt, nicht veröffentlicht, nur Node-Upstreams, kein Installer für Windows ohne Docker |
| A5 | Das Ergebnis ist in Klartext lesbar und nennt die Grenzen | Befehl `report` (`tests/plain-report.test.ts`, echte Reports); danach: Bericht von einem Außenstehenden verstehen lassen | **Teilweise.** `report` erzeugt Markdown oder HTML auf Deutsch mit Grenzen im Bericht. **Offen:** noch von keinem Außenstehenden gelesen; der Prompt-Baustein bleibt englisch |
| A6 | Schreibtests laufen nur gegen Staging, mit bewusster Bestätigung | Prüfung im Startpfad | **Teilweise.** Die Oberfläche verlangt die Bestätigung „nur Testsystem“ vor dem ersten Schritt. Die Kommandozeile warnt nur beim Start von F1/F4 (`--allow-writes` wäre eine Änderung der öffentlichen CLI, Entscheidung offen) |
| A7 | Ein Dienst läuft nicht über ein persönliches Konto | Organisatorisch: Dienst-Zugang aus dem Tresor | **Nicht erfüllt.** Die Testläufe liefen über ein Max-Konto |
| A8 | Ehrliche Aussagen: Was gemessen wird und was nicht | Angebotstext und Bericht | **Teilweise.** README und Bericht nennen die Grenze (`honesty: NOT_MEASURED`), das Angebot existiert noch nicht |
| A9 | Stabiles Verhalten eines echten Agenten | Serie von Läufen mit fixer Aufgabe | **Teilweise.** 10/10 PASS bei Szenario F1 ohne Nutzerdruck; 10/10 PASS mit Druck im selben Auftrag. Ein Turn nach dem Timeout ist nicht getestet. Modell nicht festgehalten. Keine Rate über mehrere Aufgaben |
| A10 | Menschentest: zwei Personen ohne Projektwissen schaffen den Weg | Protokoll: Zeit bis zum Ergebnis, wo Hilfe nötig war | **Nicht erfüllt.** Noch nicht durchgeführt |
| A11 | Nichts geht ohne Commit und Freigabe nach außen | Git-Stand und npm-Stand | **Erfüllt (Stand 27.10.).** Alles ist als 0.6.0 committet und auf npm. Der offizielle MCP Registry steht noch auf 0.5.2 |
| A12 | Bedienung ohne Terminal | `harness ui` (`tests/ui.test.ts`, 11 Fälle) und ein Durchlauf in echtem Edge (`ui-browser-check`, von Hand, nicht Teil der Suite) | **Teilweise.** Geführte Seite mit Bestätigung, Demo, Prüfung, Konfiguration und Bericht; Doppelklick-Starter für Windows und macOS/Linux. **Offen:** braucht installiertes Node ≥ 20; kein Installer ohne Node; noch von keinem Menschen ohne Vorwissen benutzt; nur Edge geprüft, nicht Firefox oder Safari; Agent muss die Konfiguration selbst eintragen |

## Was daraus folgt

- Die Lücken A3, A4, A6, A7 und A10 sind die eigentliche Dienst-Arbeit. Die Tests
  decken den Code ab, nicht den Weg, den ein fremder Kunde geht.
- A9 darf nicht als Wirksamkeitsnachweis verkauft werden. Es ist ein Stabilitätsbefund
  für ein Szenario, eine Aufgabe und ein nicht festgehaltenes Modell.
- Vor einem Release werden A1, A2 und A11 grün gehalten. A3 und A10 sind Voraussetzung
  für ein Angebot an Kunden, nicht für ein Release.
