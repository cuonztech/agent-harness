// An answer the upstream marked as a success (no isError) whose content says it failed:
// "Fehler: Zimmer belegt", {"error":"DB down"}, {"success":false}, {"statusCode":409}. The
// harness counts such a call as executed (README, "Als ausgeführt gilt, was der Upstream nicht
// als Fehler markiert"); the effect probe must not rely on "a success answer means a record
// exists" for it.
//
// Narrow on purpose, in both directions. A miss keeps the old behaviour (documented); a false
// alarm turns a probe run `inconclusive`, which is the safe direction. Looked at: the start of a
// text answer, and the top-level fields (and one level into result/data/response) of a JSON
// answer. A text that only talks about errors ("Error handling summary", "no errors", "Error:
// none") does not count.
const MAX_JSON_CHARS = 100_000;

// "Error: …", "Fehler: …", "Error - …", "Error!": the word, then punctuation. (Not "Error handling".)
const ERROR_LABEL = /^\W*(error|fehler)\s*[:\-–—!.]/iu;
// "Failed to …", "Could not …", "Invalid …", "Request failed", "Not found", "Sorry, …"
const FAILURE_PHRASE =
  /^\W*(failed|failure|exception|unable to|could not|couldn't|cannot|can't|invalid\p{L}*|forbidden|unauthori[sz]ed|denied|rejected|declined|not found|no such|request failed|operation failed|sorry|unfortunately|nicht möglich|konnte nicht|nicht gefunden|nicht erlaubt|ungültig\p{L}*|fehlgeschlagen|abgelehnt|leider)(?![\p{L}\p{N}])/iu;
// "Error: none", "Error: 0", "Error: false": a label with an empty value.
const EMPTY_ERROR_VALUE = /^\W*(error|fehler)\s*[:\-–—]\s*(none|no|null|nil|n\/a|false|0|kein|keiner|keine)\b/iu;

const NO_ERROR_STRINGS = new Set(["", "none", "no", "null", "nil", "n/a", "false", "0", "ok", "kein", "keine", "keiner"]);

function isEmptyErrorValue(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0) return true;
  if (typeof v === "string") return NO_ERROR_STRINGS.has(v.trim().toLowerCase());
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

const ERROR_KEYS = ["error", "errors", "exception", "errorMessage", "error_message", "errorCode", "error_code", "fault"];
const BAD_STATUS = /^(error|failed|failure|rejected|denied|declined|conflict|not[_ -]?found|forbidden|unauthori[sz]ed)$/i;

function objectLooksLikeError(o: Record<string, unknown>): boolean {
  for (const k of ERROR_KEYS) if (k in o && !isEmptyErrorValue(o[k])) return true;
  if (o.success === false || o.ok === false || o.ok === 0) return true;
  if (typeof o.status === "string" && BAD_STATUS.test(o.status)) return true;
  for (const k of ["status", "statusCode", "status_code", "code"]) {
    const n = o[k];
    if (typeof n === "number" && Number.isInteger(n) && n >= 400 && n <= 599) return true;
  }
  return false;
}

function jsonLooksLikeError(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (objectLooksLikeError(o)) return true;
  for (const k of ["result", "data", "response"]) {
    const inner = o[k];
    if (inner !== null && typeof inner === "object" && !Array.isArray(inner) && objectLooksLikeError(inner as Record<string, unknown>)) return true;
  }
  return false;
}

function textLooksLikeError(head: string): boolean {
  if (EMPTY_ERROR_VALUE.test(head)) return false;
  return ERROR_LABEL.test(head) || FAILURE_PHRASE.test(head);
}

export function looksLikeErrorAnswer(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const head = text.slice(0, 400).trim();
  if (head === "") return false;
  if ((head[0] === "{" || head[0] === "[") && text.length <= MAX_JSON_CHARS) {
    try {
      return jsonLooksLikeError(JSON.parse(text));
    } catch {
      return textLooksLikeError(head);
    }
  }
  return textLooksLikeError(head);
}
