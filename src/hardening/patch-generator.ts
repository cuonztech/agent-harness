import type { AuditReport } from "../core/report-generator.js";
import type { ResilienceScore } from "../benchmark/score.js";

export interface HardeningPatch {
  category: string;
  severity: "critical" | "warning" | "info";
  trigger: string;
  promptSnippet: string;
  toolGuidance: string;
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
      promptSnippet: `CRITICAL — Timeout on a write ("ghost write"):\n${TIMEOUT_PROTOCOL}`,
      toolGuidance: `Offer a lookup that works without the ID returned by the write (by customer, date, reference), and make write tools idempotent: same key + same payload = same result, no second effect.`,
    });
  }

  // Duplicate without any timeout involved: the same write went out twice.
  const afterSuccess = duplicates.filter((v) => !v.duplicate?.afterTimeout);
  if (afterSuccess.length > 0) {
    patches.push({
      category: "IDEMPOTENCY",
      severity: "critical",
      trigger: `Agent sent the same write ${afterSuccess.length} more time(s) although the harness had reported no failure for it.`,
      promptSnippet: `CRITICAL — One write per operation:\nSend each write exactly once. The same write was sent more than once although the server had reported no failure for it.\n1. Do NOT send the same write again — not in parallel, not "to be sure", and not because the user repeats the request without new details\n2. If you are unsure whether it went through, look the record up with a read/list tool instead\n3. Only send it again if a real lookup shows it is missing\n\nA repeated write causes duplicate charges or bookings.`,
      toolGuidance: `Return an identifier for the created record in every write response, so it can be referenced and looked up.`,
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
      promptSnippet: `CRITICAL — Rate Limits:\nWhen a tool answers with a rate limit (HTTP 429) and a retry_after value:\n1. Do NOT call that tool again before retry_after has elapsed\n2. If you cannot wait that long, stop and tell the user the request was rate-limited and was NOT executed\n3. Never retry immediately "just to see"`,
      toolGuidance: `Return retry_after as a structured field (seconds), not only inside a message string.`,
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
      promptSnippet: `WARNING — Check after a timeout:\n${TIMEOUT_PROTOCOL}\nNever tell the user a timed-out write "was not executed" unless a real lookup showed that.`,
      toolGuidance: `Offer a lookup that works without the ID returned by the write (by customer, date, reference), so a result can be checked after a lost response.`,
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
