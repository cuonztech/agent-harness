// A name pattern decides what most upstream tools are (annotations and explicit
// flags aside), and name patterns err both ways: `check_in_guest` writes but
// starts with "check", `update_status_view` only reads but starts with
// "update_". The tool's own description often gives it away. This looks for
// the contradiction and reports it; it never changes a classification (a
// description is prose, not a contract), it only makes the doubt visible.
//
// Only classifications taken from a NAME are questioned. An annotation or an
// explicit --write-tools/--read-tools is the caller's word and is trusted.
//
// The description comes from the upstream, so it is bounded (MAX_DESCRIPTION)
// and read with linear scans only (no backtracking patterns over its length).
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ToolClass } from "../engine/state-machine.js";

const MAX_DESCRIPTION = 600;

// A verb counts only where a verb stands in a description: at the start of a
// clause ("Books a room"), or after a comma or a conjunction ("... and bills the
// first night", ", or creates one"). The same words elsewhere are mostly nouns
// ("Lists issues", "Returns charges", "the booking that updates the view").
// Third person singular present (German: present); the bare form only at the
// start ("Create a booking").
const WRITE_VERBS = new Set([
  "creates", "books", "bills", "charges", "sends", "deletes", "removes", "cancels", "updates",
  "modifies", "writes", "inserts", "submits", "pays", "transfers", "refunds", "stores", "saves",
  "persists", "reserves", "registers", "approves", "issues", "withdraws", "deposits", "purchases",
  "places", "confirms", "schedules", "posts", "adds", "executes", "triggers", "publishes", "logs",
  "sets", "notifies", "emails", "uploads", "generates", "archives", "overwrites", "increments", "marks",
  "erstellt", "bucht", "sendet", "löscht", "loescht", "storniert", "ändert", "aendert", "schreibt",
  "speichert", "zahlt", "belastet", "verrechnet", "überweist", "ueberweist", "registriert", "entfernt",
  "schickt", "versendet", "aktualisiert", "reserviert", "bestätigt", "bestaetigt", "setzt", "erzeugt",
  "überschreibt", "ueberschreibt", "verbucht",
]);
const BARE_WRITE_VERBS = new Set([
  "create", "book", "bill", "charge", "send", "delete", "remove", "cancel", "update", "modify",
  "write", "insert", "submit", "pay", "transfer", "refund", "store", "save", "persist", "reserve",
  "register", "approve", "issue", "withdraw", "deposit", "purchase", "place", "confirm", "schedule",
  "post", "add", "execute", "trigger", "publish", "log", "set", "notify", "email", "upload", "generate",
  "archive", "overwrite", "increment", "mark",
]);
const CONJUNCTIONS = new Set(["and", "or", "then", "also", "und", "oder", "dann", "sowie", "danach", "plus"]);
// A verb inside a negated clause says the opposite ("Never writes or sends anything",
// "Sendet nichts, löscht nichts").
const NEGATIONS = new Set([
  "not", "never", "no", "without", "doesn't", "don't", "won't", "nothing", "nobody",
  "nicht", "kein", "keine", "keinen", "ohne", "nie", "niemals", "nichts",
]);
const NEGATION_AFTER = 3; // "bucht nichts", "does nothing"

function tokenize(clause: string): string[] {
  // Words and commas; letters by Unicode class (\b knows only ASCII).
  return clause.toLowerCase().match(/[\p{L}\p{N}']+|,/gu) ?? [];
}

function describesWriting(description: string): string | null {
  const text = description.slice(0, MAX_DESCRIPTION).replace(/\s+/g, " ");
  for (const clause of text.split(/[.;!?]+/)) {
    const tokens = tokenize(clause);
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i];
      const prev = i > 0 ? tokens[i - 1] : null;
      const inVerbPosition = prev === null || prev === "," || CONJUNCTIONS.has(prev);
      const isVerb = inVerbPosition && (WRITE_VERBS.has(word) || (i === 0 && BARE_WRITE_VERBS.has(word)));
      if (!isVerb) continue;
      const negated =
        tokens.slice(0, i).some((t) => NEGATIONS.has(t)) ||
        tokens.slice(i + 1, i + 1 + NEGATION_AFTER).some((t) => NEGATIONS.has(t));
      if (!negated) return word;
    }
  }
  return null;
}

// Unambiguous statements only, and only in the FIRST sentence ("The id field is
// read-only" in a later sentence is about a parameter, not about the tool).
const READ_ONLY_PHRASES = [
  "read-only", "read only", "readonly", "only reads", "no side effect", "no side-effect",
  "does not modify any", "does not change any", "does not write", "nur lesend", "schreibgeschützt",
  "schreibgeschuetzt", "nur lesen",
];

function firstSentence(description: string): string {
  const text = description.slice(0, MAX_DESCRIPTION).replace(/\s+/g, " ").trim();
  const end = text.search(/[.!?](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).toLowerCase();
}

export function classificationDoubt(tool: Tool, cls: ToolClass, source: string): string | undefined {
  const description = tool.description;
  if (!description) return undefined;
  const nameBased = source === "default write pattern" || source === "read prefix";
  if (!nameBased) return undefined;
  if (cls === "read") {
    const verb = describesWriting(description);
    return verb
      ? `taken for a read by its name, but its description says it "${verb}" — if it writes, duplicates through it stay invisible (set --write-tools or the readOnlyHint annotation)`
      : undefined;
  }
  if (cls === "write") {
    const first = firstSentence(description);
    if (READ_ONLY_PHRASES.some((p) => first.includes(p))) {
      return "taken for a write by its name, but its description says it only reads — calls to it may be treated as writes (set --read-tools or the readOnlyHint annotation)";
    }
  }
  return undefined;
}
