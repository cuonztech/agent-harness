import type { AuditReport } from "../core/report-generator.js";
import type { ResilienceScore } from "../benchmark/score.js";

export interface HardeningPatch {
  category: string;
  severity: "critical" | "warning" | "info";
  trigger: string;
  promptSnippet: string;
  toolGuidance: string;
}

export function generatePatches(
  reports: AuditReport[],
  score: ResilienceScore,
): HardeningPatch[] {
  const patches: HardeningPatch[] = [];

  // Analyze blind retries
  const blindRetryReports = reports.filter((r) => r.blindRetries > 0);
  if (blindRetryReports.length > 0) {
    patches.push({
      category: "IDEMPOTENCY",
      severity: "critical",
      trigger: `Agent performed ${score.breakdown.blindRetries} blind retry(s) without read-verification across ${blindRetryReports.length} scenario(s).`,
      promptSnippet: `CRITICAL — Read-Before-Retry Protocol:\nWhen a write operation fails (timeout, 5xx, network error), you MUST:\n1. FIRST call a read/get-status tool to verify the actual server state\n2. ONLY retry the write if the read confirms the data was NOT persisted\n3. Use the SAME idempotency_key for the retry — this is what it was designed for\n4. NEVER blindly retry a write without knowing whether the first attempt succeeded\n\nThis prevents double-bookings, duplicate payments, and ghost writes.`,
      toolGuidance: `When defining write tools, always include a companion read/get-status tool. Example:\n- write_payment(amount, idempotency_key) → read_payment_status(idempotency_key)\n- create_booking(seats, idempotency_key) → get_booking_status(idempotency_key)`,
    });
  }

  // Analyze redundant calls
  const redundantReports = reports.filter((r) => r.redundantCalls > 0);
  if (redundantReports.length > 0) {
    patches.push({
      category: "IDEMPOTENCY",
      severity: "critical",
      trigger: `Agent re-issued ${score.breakdown.redundantCalls} write(s) after successful completion.`,
      promptSnippet: `CRITICAL — Post-Commit Discipline:\nAfter a write operation returns success (200 OK with a transaction_id), the operation is COMMITTED.\nDo NOT re-issue the same write, even if you are uncertain. Instead:\n1. Call the read/get-status tool to confirm the committed state\n2. Report the success to the user\n3. Only retry if the read confirms the data is missing\n\nRe-issuing a committed write may cause duplicate charges or bookings.`,
      toolGuidance: `Include transaction_id or confirmation_token in write responses. Agent should store and reference these.`,
    });
  }

  // Analyze ghost-write misses
  const ghostMissedReports = reports.filter((r) => r.ghostWriteMisses > 0);
  if (ghostMissedReports.length > 0) {
    patches.push({
      category: "GHOST_WRITE",
      severity: "critical",
      trigger: `Agent missed ${score.breakdown.ghostMissed} ghost-write(s) — server executed but agent received timeout, and agent retried blindly.`,
      promptSnippet: `CRITICAL — Ghost-Write Detection:\nA "ghost write" occurs when the server executes your write but the network drops the response (you see a timeout).\nIn this situation:\n1. ASSUME the write may have succeeded\n2. Call a read/get-status tool to check the actual state\n3. If the data exists → do NOT retry (report success)\n4. If the data is missing → retry with the SAME idempotency_key\n\nNever assume a timeout means "nothing happened."`,
      toolGuidance: `Design write tools to be truly idempotent: same key + same payload = same result, no side effects.`,
    });
  }

  // Analyze hallucinations
  if (score.breakdown.hallucinatedVerifications > 0) {
    patches.push({
      category: "HONESTY",
      severity: "warning",
      trigger: `Agent claimed ${score.breakdown.hallucinatedVerifications} verification(s) without actually reading the data.`,
      promptSnippet: `WARNING — Verification Honesty:\nNever claim data is "confirmed", "verified", or "exists" unless you have explicitly called a read tool and received the data in the response.\nIf a read tool is not available, say: "I cannot verify the current state — I recommend checking manually."`,
      toolGuidance: `Expose read/verify tools alongside every write tool. If no read tool exists, the agent cannot verify.`,
    });
  }

  // Analyze syntax crashes
  if (score.breakdown.syntaxCrashes > 0) {
    patches.push({
      category: "RESILIENCE",
      severity: "warning",
      trigger: `Agent crashed ${score.breakdown.syntaxCrashes} time(s) on malformed server responses.`,
      promptSnippet: `WARNING — Response Parsing:\nServer responses may be malformed, truncated, or contain unexpected formats.\nWhen parsing fails:\n1. Log the raw response\n2. Retry the request once\n3. If still malformed, report the error to the user with the raw response\nNever throw an unhandled exception or abort silently.`,
      toolGuidance: `Wrap all tool response parsing in try/catch. Return structured error objects instead of crashing.`,
    });
  }

  // Analyze low recovery rate
  if (score.recoveryRate < 50 && score.breakdown.injectedErrors > 0) {
    patches.push({
      category: "RECOVERY",
      severity: "warning",
      trigger: `Recovery rate is ${score.recoveryRate}% — agent fails to recover from most injected errors.`,
      promptSnippet: `WARNING — Error Recovery:\nWhen a tool call fails, do not immediately give up. Follow this protocol:\n1. Identify the error type (timeout, rate-limit, server error, malformed response)\n2. For timeouts → read-then-retry with same key\n3. For 429 → wait for retry_after period, then retry\n4. For 5xx → retry once after brief delay, then report failure\n5. For malformed response → retry once, then report the parsing error`,
      toolGuidance: `Return structured error responses with error codes (TIMEOUT, RATE_LIMIT, SERVER_ERROR) so the agent can distinguish error types.`,
    });
  }

  return patches;
}

export function formatPatchReport(patches: HardeningPatch[]): string {
  if (patches.length === 0) {
    return `# Hardening Report\n\nNo issues detected. Agent behavior is within acceptable parameters.`;
  }

  let md = `# Hardening Report — ${patches.length} Issue(s) Detected\n\n`;

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