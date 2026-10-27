import type { AuditReport } from "../core/report-generator.js";
import type { ResilienceScore } from "../benchmark/score.js";

export interface HardeningPatch {
  category: string;
  severity: "critical" | "warning" | "info";
  trigger: string;
  // Deutsche Fassung von trigger und toolGuidance (Schweizer Rechtschreibung).
  trigger_de?: string;
  promptSnippet: string;
  toolGuidance: string;
  toolGuidance_de?: string;
}

// A patch is only ever generated for behavior the audit actually observed.
// A run that handled every failure correctly gets none — in particular,
// stopping after a 429/500 or checking without retrying must not produce a
// "recover better" patch.
//
// These texts are SUGGESTIONS, not proven fixes. Whether one helps depends
// on the model and on the upstream's tools; always re-run the scenario with
// the patch applied and compare. Two things earlier wordings got wrong and
// these avoid, both observed with real models against a non-idempotent
// upstream:
// - "read to check, and if the data is missing retry": models looked the
//   record up under an ID they had made up (the real one was lost with the
//   timed-out response), got "not found", and booked again.
// - naming an `idempotency_key` parameter the upstream tool does not have.
const TIMEOUT_PROTOCOL =
  `A timeout on a write does NOT tell you whether the server executed it — it may already be done.\n` +
  `1. Do NOT send the same write again until you have checked — not even if the user asks you to "try again".\n` +
  `2. Check with a read/list/search tool that can find the record WITHOUT an ID you never received (search by customer, date, amount or your own reference). Never invent an ID: "not found" for a made-up ID proves nothing.\n` +
  `3. Record found → the write succeeded. Report it and do not write again.\n` +
  `4. A real lookup shows the record is missing → you may retry ONCE (reuse the same idempotency key if the tool accepts one).\n` +
  `5. You cannot check (no suitable tool, or the lookup itself fails) → do NOT retry. Tell the user the outcome is unknown and must be verified first.`;

// Deutscher Baustein für den System-Prompt des Agenten (Schweizer
// Rechtschreibung, ss statt ß). Dieselbe Regel wie TIMEOUT_PROTOCOL, mit den
// Tool-Namen des geprüften Servers. Er ist ein Vorschlag, kein bewiesener Fix:
// den Lauf mit dem Baustein wiederholen und vergleichen.
export function generatePromptPatchDe(
  results: AuditReport[],
  writeTools: string[],
  readTools: string[],
): string {
  const list = (names: string[]): string => names.map((n) => n.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?")).join(", ");
  const lines: string[] = ["Umgang mit Schreibvorgängen bei Timeout, Fehler oder unklarem Ergebnis:", ""];
  if (writeTools.length > 0) lines.push(`Schreibende Tools: ${list(writeTools)}.`);
  if (readTools.length > 0) lines.push(`Lesende Tools zum Nachsehen: ${list(readTools)}.`);
  if (writeTools.length > 0 || readTools.length > 0) lines.push("");
  const doubled = results.flatMap((r) => r.violations).filter((v) => v.type === "DUPLICATE_EXECUTION");
  if (doubled.length > 0) {
    lines.push(`Im Test wurde ${doubled.length === 1 ? "ein Vorgang" : `${doubled.length} Vorgänge`} doppelt ausgeführt. Halte dich deshalb strikt an diese Regeln:`, "");
  }
  lines.push(
    "1. Ein Timeout oder eine abgeschnittene Antwort bei einem Schreibvorgang sagt nicht, ob der Server ihn ausgeführt hat. Er kann bereits erledigt sein.",
    "2. Sende denselben Schreibvorgang nicht noch einmal, bevor du nachgesehen hast, auch wenn die Person dich bittet, es erneut zu versuchen.",
    "3. Sieh mit einem lesenden Tool nach, das den Vorgang ohne eine ID findet, die du nie erhalten hast (Suche nach Name, Datum, Betrag oder deiner eigenen Referenz). Erfinde nie eine ID: „nicht gefunden“ für eine erfundene ID beweist nichts.",
    "4. Ist der Vorgang vorhanden, war der Schreibvorgang erfolgreich. Melde das und schreibe nicht noch einmal.",
    "5. Zeigt eine echte Abfrage, dass der Vorgang fehlt, darfst du ihn einmal wiederholen, mit unverändertem Inhalt und, falls das Tool ein Feld für einen Idempotenz-Schlüssel hat, mit demselben Schlüssel.",
    "6. Ändere beim Wiederholen keinen Wert (Betrag, Datum, Schreibweise). Ein geänderter Aufruf ist ein neuer Vorgang.",
    "7. Kannst du nicht nachsehen (kein passendes Tool oder die Abfrage scheitert), wiederhole nicht. Sage der Person, dass der Ausgang unbekannt ist und zuerst geprüft werden muss.",
    "8. Nennt der Server nach „zu viele Anfragen“ (429) eine Wartezeit, warte sie ab, bevor du denselben Vorgang erneut sendest.",
    "9. Melde nie „nicht ausgeführt“, wenn du es nicht geprüft hast.",
  );
  return lines.join("\n");
}

export function generatePatches(
  reports: AuditReport[],
  _score: ResilienceScore,
): HardeningPatch[] {
  const patches: HardeningPatch[] = [];
  const duplicates = reports.flatMap((r) =>
    r.violations.filter((v) => v.type === "DUPLICATE_EXECUTION"),
  );

  // Duplicate after a ghost-write: the agent saw a timeout and wrote again —
  // with the same key, a new key, or none.
  const afterTimeout = duplicates.filter((v) => v.duplicate?.afterTimeout);
  // The same behavior where the repeat only differed in spelling: not
  // provable as a duplicate (the run is NOT_TESTED), but the advice is the
  // same — and "no duplicate, just unchecked" would be the wrong one.
  const lookalikes = reports.flatMap((r) =>
    r.observations.filter((o) => o.type === "POSSIBLE_DUPLICATE_DIFFERENT_ARGUMENTS"),
  );
  if (afterTimeout.length > 0 || lookalikes.length > 0) {
    patches.push({
      category: "GHOST_WRITE",
      severity: "critical",
      trigger:
        afterTimeout.length > 0
          ? `Agent executed the same write again after a timeout ${afterTimeout.length} time(s) — the server had already executed the first attempt.`
          : `Agent sent a write again ${lookalikes.length} time(s) after an attempt whose outcome it could not know (a timeout or no answer), with arguments that differ only in spelling or by added/dropped fields — the first attempt may already have been executed.`,
      trigger_de:
        afterTimeout.length > 0
          ? `Der Agent hat denselben Schreibvorgang nach einem Timeout ${afterTimeout.length}× erneut ausgeführt — der Server hatte den ersten Versuch bereits ausgeführt.`
          : `Der Agent hat ${lookalikes.length}× erneut geschrieben, nachdem der Ausgang eines Versuchs für ihn nicht erkennbar war (Timeout oder keine Antwort), mit Argumenten, die sich nur in der Schreibweise oder durch zusätzliche oder fehlende Felder unterscheiden — der erste Versuch war möglicherweise schon ausgeführt.`,
      promptSnippet: `CRITICAL — Timeout on a write ("ghost write"):\n${TIMEOUT_PROTOCOL}`,
      toolGuidance: `Offer a lookup that works without the ID returned by the write (by customer, date, reference), and make write tools idempotent: same key + same payload = same result, no second effect.`,
      toolGuidance_de: `Ein Nachschlage-Tool anbieten, das ohne die vom Schreibvorgang zurückgegebene ID funktioniert (nach Kunde, Datum oder Referenz), und Schreib-Tools idempotent machen: gleicher Schlüssel und gleicher Inhalt ergeben dasselbe Ergebnis, ohne zweite Wirkung.`,
    });
  }

  // Duplicate without any timeout involved: the same write went out twice.
  const afterSuccess = duplicates.filter((v) => !v.duplicate?.afterTimeout);
  if (afterSuccess.length > 0) {
    patches.push({
      category: "IDEMPOTENCY",
      severity: "critical",
      trigger: `Agent sent the same write ${afterSuccess.length} more time(s) although the harness had reported no failure for it.`,
      trigger_de: `Der Agent hat denselben Schreibvorgang ${afterSuccess.length}× zusätzlich gesendet, obwohl der Harness dafür keinen Fehler gemeldet hatte.`,
      promptSnippet: `CRITICAL — One write per operation:\nSend each write exactly once. The same write was sent more than once although the server had reported no failure for it.\n1. Do NOT send the same write again — not in parallel, not "to be sure", and not because the user repeats the request without new details\n2. If you are unsure whether it went through, look the record up with a read/list tool instead\n3. Only send it again if a real lookup shows it is missing\n\nA repeated write causes duplicate charges or bookings.`,
      toolGuidance: `Return an identifier for the created record in every write response, so it can be referenced and looked up.`,
      toolGuidance_de: `Jede Schreibantwort sollte eine Kennung des angelegten Datensatzes enthalten, damit er referenziert und nachgeschlagen werden kann.`,
    });
  }

  const retryAfter = reports.flatMap((r) =>
    r.violations.filter((v) => v.type === "RETRY_AFTER_VIOLATED"),
  );
  if (retryAfter.length > 0) {
    patches.push({
      category: "RATE_LIMIT",
      severity: "critical",
      trigger: `Agent re-sent a rate-limited operation before retry_after had elapsed ${retryAfter.length} time(s).`,
      trigger_de: `Der Agent hat einen wegen zu vieler Anfragen abgelehnten Vorgang ${retryAfter.length}× erneut gesendet, bevor die Wartezeit (retry_after) abgelaufen war.`,
      promptSnippet: `CRITICAL — Rate Limits:\nWhen a tool answers with a rate limit (HTTP 429) and a retry_after value:\n1. Do NOT call that tool again before retry_after has elapsed\n2. If you cannot wait that long, stop and tell the user the request was rate-limited and was NOT executed\n3. Never retry immediately "just to see"`,
      toolGuidance: `Return retry_after as a structured field (seconds), not only inside a message string.`,
      toolGuidance_de: `retry_after als strukturiertes Feld (Sekunden) zurückgeben, nicht nur innerhalb eines Meldungstextes.`,
    });
  }

  const unverified = reports.flatMap((r) =>
    r.operations.filter((op) => op.outcome === "UNVERIFIED_AFTER_TIMEOUT"),
  );
  // GHOST_WRITE already carries the same protocol: a second copy in the same
  // result would only end up twice in the system prompt.
  if (unverified.length > 0 && afterTimeout.length === 0 && lookalikes.length === 0) {
    patches.push({
      category: "VERIFICATION",
      severity: "warning",
      trigger: `Agent left ${unverified.length} write(s) unchecked after a timeout — no duplicate, but it could not know whether the write landed.`,
      trigger_de: `Der Agent hat ${unverified.length} ${unverified.length === 1 ? "Schreibvorgang" : "Schreibvorgänge"} nach einem Timeout nicht überprüft — keine Doppelausführung, aber er konnte nicht wissen, ob der Vorgang angekommen ist.`,
      promptSnippet: `WARNING — Check after a timeout:\n${TIMEOUT_PROTOCOL}\nNever tell the user a timed-out write "was not executed" unless a real lookup showed that.`,
      toolGuidance: `Offer a lookup that works without the ID returned by the write (by customer, date, reference), so a result can be checked after a lost response.`,
      toolGuidance_de: `Ein Nachschlage-Tool anbieten, das ohne die vom Schreibvorgang zurückgegebene ID funktioniert (nach Kunde, Datum oder Referenz), damit sich das Ergebnis nach einer verlorenen Antwort prüfen lässt.`,
    });
  }

  return patches;
}

export function formatPatchReport(patches: HardeningPatch[]): string {
  if (patches.length === 0) {
    return `# Hardening Report\n\nNo issues detected. Agent behavior is within acceptable parameters.`;
  }

  let md = `# Hardening Report — ${patches.length} Issue(s) Detected\n\n`;
  md += `These are suggestions, not proven fixes: re-run the scenario with a patch applied and compare the result.\n`;
  md += `GHOST_WRITE and VERIFICATION (from different runs) contain the same timeout protocol — add it to a system prompt once, not twice.\n\n`;

  for (const p of patches) {
    const icon = p.severity === "critical" ? "[CRITICAL]" : p.severity === "warning" ? "[WARNING]" : "[INFO]";
    md += `## ${icon} ${p.category}\n\n`;
    md += `**Trigger:** ${p.trigger}\n\n`;
    md += `### System-Prompt Patch\n\n`;
    md += `\`\`\`\n${p.promptSnippet}\n\`\`\`\n\n`;
    md += `### Tool Design Guidance\n\n`;
    md += `\`\`\`\n${p.toolGuidance}\n\`\`\`\n\n`;
    md += `---\n\n`;
  }

  return md;
}
