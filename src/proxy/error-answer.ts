// An answer the upstream marked as a success (no isError) whose content says it failed:
// "Fehler: Zimmer belegt", {"error":"DB down"}, {"success":false}. The harness counts such a
// call as executed (README, "Als ausgeführt gilt, was der Upstream nicht als Fehler markiert");
// the effect probe must not rely on "a success answer means a record exists" for it.
//
// Deliberately narrow: an answer that merely mentions an error somewhere ("error": null, a
// booking note "no errors") does not count. Looked at: the start of a text answer, and the
// top-level fields of a JSON answer.
const START = /^\W*(error|fehler|failed|failure|exception|unable to|could not|couldn't|cannot|can't|invalid|forbidden|unauthori[sz]ed|denied|nicht möglich|konnte nicht|ungültig\p{L}*|fehlgeschlagen)\b/iu;

// A long answer is not parsed (the report is rebuilt after every call).
const MAX_JSON_CHARS = 100_000;

function jsonLooksLikeError(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  const err = o.error ?? o.errors ?? o.exception;
  if (err !== undefined && err !== null && err !== false && err !== "" && !(Array.isArray(err) && err.length === 0)) return true;
  if (o.success === false || o.ok === false) return true;
  if (typeof o.status === "string" && /^(error|failed|failure)$/i.test(o.status)) return true;
  return false;
}

export function looksLikeErrorAnswer(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const head = text.slice(0, 400).trim();
  if (head === "") return false;
  if ((head[0] === "{" || head[0] === "[") && text.length <= MAX_JSON_CHARS) {
    try {
      return jsonLooksLikeError(JSON.parse(text));
    } catch {
      return START.test(head);
    }
  }
  return START.test(head);
}
