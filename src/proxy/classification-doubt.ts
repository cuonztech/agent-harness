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
  // 0.11.0: further verbs that put something into a state ("Changes the status", "locks the job").
  "changes", "locks", "unlocks", "clears", "resets", "assigns", "grants", "revokes", "moves", "renames",
  "deploys", "restarts", "stops", "starts", "enables", "disables", "activates", "deactivates", "invites",
  "subscribes", "unsubscribes", "inserts", "appends", "replaces", "kills", "terminates", "closes", "reopens",
  "dispatches", "enqueues", "settles", "captures", "voids", "orders", "ships", "invoices", "mints", "burns",
  "swaps", "stakes", "claims", "votes", "shares", "tags", "labels", "flags", "pops", "acknowledges", "dismisses",
  "ändert", "legt", "löscht", "setzt", "sperrt",
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

export function describesWriting(description: string): string | null {
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

// The description opens with a read verb ("Returns the commit history", "Gets …", "Lists …"):
// it says what the tool gives back, not what it changes.
const READ_OPENERS = new Set([
  "returns", "gets", "lists", "fetches", "retrieves", "shows", "searches", "finds", "reads", "describes",
  "looks", "displays", "queries", "counts", "checks", "return", "get", "list", "fetch", "retrieve", "show",
  "search", "find", "read", "describe", "query", "liefert", "zeigt", "listet", "gibt", "sucht", "liest", "holt",
]);
export function descriptionOpensWithReadVerb(description: string): boolean {
  const first = description.slice(0, 200).trim().toLowerCase().match(/^[\p{L}]+/u);
  return first !== null && READ_OPENERS.has(first[0]);
}

// The first sentence opens with a plain write verb ("Creates a booking", "Löscht einen Eintrag"), not
// negated. Narrower than describesWriting: no generic verbs ("generates", "logs", "marks"), and only at
// the very start, because the prefix decides nothing here — the description is the only witness.
const OPENING_WRITE_VERBS = new Set([
  "creates", "adds", "inserts", "updates", "modifies", "deletes", "removes", "cancels", "books", "sends",
  "submits", "pays", "transfers", "refunds", "charges", "writes", "saves", "stores", "registers", "approves",
  "publishes", "uploads", "schedules", "reserves", "places", "posts", "archives", "overwrites", "changes",
  "assigns", "deploys", "restarts", "activates", "deactivates", "enables", "disables",
  "create", "add", "insert", "update", "modify", "delete", "remove", "cancel", "book", "send", "submit",
  "pay", "transfer", "refund", "charge", "write", "save", "store", "register", "approve", "publish",
  "upload", "schedule", "reserve", "place", "post", "archive", "overwrite", "change", "assign", "deploy",
  "erstellt", "legt", "löscht", "loescht", "ändert", "aendert", "sendet", "bucht", "storniert", "speichert",
  "überweist", "ueberweist", "entfernt", "aktualisiert", "versendet", "registriert", "reserviert",
  "bestätigt", "bestaetigt", "schreibt", "verbucht", "setzt",
]);
export function descriptionOpensWithWriteVerb(description: string): boolean {
  const tokens = tokenize(firstSentence(description));
  if (tokens.length === 0 || !OPENING_WRITE_VERBS.has(tokens[0])) return false;
  return !tokens.slice(1, 1 + NEGATION_AFTER + 1).some((t) => NEGATIONS.has(t));
}

// 0.12.0 (E3c): «Creates a payment. Read-only, does not modify anything.» Die Aussage steht nicht im ersten Satz, sondern in einem späteren,
// der mit ihr beginnt. Nur Sätze, die selbst mit der Aussage über das Tool beginnen, zählen («The id field is read-only» beginnt anders und
// betrifft einen Parameter). Eine Verneinung über bestehende Daten («Does not change existing bookings») ist keine solche Aussage, und «Has no side
// effects» allein bleibt wie bisher unbeachtet (nur der erste Satz zählt dort; siehe tests/classification-doubt.test.ts).
const READ_ONLY_SENTENCE =
  /^(this (tool|call|function|operation|endpoint|method|action) (is |only |just |does )?(read[- ]?only|only reads|just reads|reads only|not (modify|change|write|alter) anything)|read[- ]?only\b|only reads\b|(does not|doesn't|do not|don't) (modify|change|write|alter) (anything|any data|any state|any records?)|(modifies|changes|writes|alters) nothing|nur lesend|nur lesezugriff|schreibgesch(ü|ue)tzt|(ändert|aendert|verändert|veraendert|schreibt) nichts)/;

export function descriptionSaysReadOnlyLater(description: string): boolean {
  const text = description.slice(0, MAX_DESCRIPTION).replace(/\s+/g, " ").trim();
  const sentences = text.split(/(?<=[.!?])\s+/).slice(1);
  return sentences.some((s) => READ_ONLY_SENTENCE.test(s.trim().toLowerCase()));
}

export function descriptionSaysReadOnly(description: string): boolean {
  const sentence = firstSentence(description);
  return READ_ONLY_PHRASES.some((p) => sentence.includes(p));
}

function firstSentence(description: string): string {
  const text = description.slice(0, MAX_DESCRIPTION).replace(/\s+/g, " ").trim();
  const end = text.search(/[.!?](\s|$)/);
  return (end === -1 ? text : text.slice(0, end + 1)).toLowerCase();
}

// 0.11.1 (hint only, the classification rules above and in verb-words.ts stay as they are): verbs that take
// something from a counter or a pool and so change state, although the tool reads like a getter
// ("Allocates a fresh invoice number", "each call issues a new code"), plus the "each call ..." phrasing
// that puts the verb behind a subject.
const HINT_VERBS = new Set([
  "allocates", "dispenses", "consumes", "issues", "generates", "reserves", "assigns", "claims", "mints",
  "increments", "decrements", "dequeues", "advances", "rotates", "regenerates", "leases", "burns",
  "vergibt", "reserviert", "verbraucht", "erzeugt", "erhöht", "erhoeht",
]);
// The bare form only at the very start ("Allocate a fresh number").
const BARE_HINT_VERBS = new Set(["allocate", "dispense", "consume", "issue", "generate", "reserve", "assign", "claim", "mint", "increment", "decrement", "dequeue", "lease"]);
// "Each call issues a new code", "Jeder Aufruf erzeugt ...": the subject names the call, the verb changes state.
const PER_CALL_WORDS = new Set(["call", "time", "invocation", "request", "use", "run", "aufruf", "mal", "abruf"]);
const EACH_WORDS = new Set(["each", "every", "jeder", "jeden", "jedes", "bei"]);

// describesWriting plus the hint-only verbs, for classificationDoubt only. A verb counts at the start of a clause,
// after a comma or conjunction, or right behind "each call"; negations around it cancel it as in describesWriting.
export function describesWritingHint(description: string): string | null {
  const base = describesWriting(description);
  if (base !== null) return base;
  const text = description.slice(0, MAX_DESCRIPTION).replace(/\s+/g, " ");
  for (const clause of text.split(/[.;!?]+/)) {
    const tokens = tokenize(clause);
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i];
      if (!HINT_VERBS.has(word) && !(i === 0 && BARE_HINT_VERBS.has(word))) continue;
      const prev = i > 0 ? tokens[i - 1] : null;
      const afterEachCall = i >= 2 && PER_CALL_WORDS.has(tokens[i - 1]) && EACH_WORDS.has(tokens[i - 2]);
      const inVerbPosition = prev === null || prev === "," || CONJUNCTIONS.has(prev) || afterEachCall;
      if (!inVerbPosition) continue;
      const negated =
        tokens.slice(0, i).some((t) => NEGATIONS.has(t)) ||
        tokens.slice(i + 1, i + 1 + NEGATION_AFTER).some((t) => NEGATIONS.has(t));
      if (!negated) return word;
    }
  }
  return null;
}

export interface ClassificationDoubtText {
  en: string;
  de: string;
}

export function classificationDoubtText(tool: Tool, cls: ToolClass, source: string): ClassificationDoubtText | undefined {
  const description = tool.description;
  if (!description) return undefined;
  const nameBased = source === "default write pattern" || source === "read prefix" || source === "verb word in name";
  if (!nameBased) return undefined;
  if (cls === "read") {
    const verb = describesWritingHint(description);
    return verb
      ? {
          en: `taken for a read by its name, but its description says it "${verb}" — if it writes, duplicates through it stay invisible (set --write-tools or the readOnlyHint annotation)`,
          de: `nach dem Namen als Lese-Tool eingeordnet, die Beschreibung sagt aber, dass es «${verb}»: Schreibt es, bleiben Doppelausführungen darüber unsichtbar (mit --write-tools oder der Annotation readOnlyHint festlegen)`,
        }
      : undefined;
  }
  if (cls === "write") {
    const first = firstSentence(description);
    if (READ_ONLY_PHRASES.some((p) => first.includes(p))) {
      return {
        en: "taken for a write by its name, but its description says it only reads — calls to it may be treated as writes (set --read-tools or the readOnlyHint annotation)",
        de: "nach dem Namen als Schreib-Tool eingeordnet, die Beschreibung sagt aber, dass es nur liest: Aufrufe können als Schreibvorgang gewertet werden (mit --read-tools oder der Annotation readOnlyHint festlegen)",
      };
    }
    // 0.12.0 (E3c): the read-only statement stands in a later sentence ("Creates a payment. Read-only, does not modify anything.").
    if (descriptionSaysReadOnlyLater(description)) {
      return {
        en: "taken for a write by its name, but a later sentence of its description says it only reads — calls to it may be treated as writes (set --read-tools or the readOnlyHint annotation)",
        de: "nach dem Namen als Schreib-Tool eingeordnet, ein späterer Satz der Beschreibung sagt aber, dass es nur liest: Aufrufe können als Schreibvorgang gewertet werden (mit --read-tools oder der Annotation readOnlyHint festlegen)",
      };
    }
    // 0.11.1: "update_status_view": "Shows the current status view." The description opens with a read verb and names
    // no write verb anywhere.
    if (descriptionOpensWithReadVerb(description) && describesWritingHint(description) === null) {
      return {
        en: "taken for a write by its name, but its description opens with a read verb and names nothing that is written — calls to it may be treated as writes (set --read-tools or the readOnlyHint annotation)",
        de: "nach dem Namen als Schreib-Tool eingeordnet, die Beschreibung beginnt aber mit einem Lese-Verb und nennt nichts, was geschrieben wird: Aufrufe können als Schreibvorgang gewertet werden (mit --read-tools oder der Annotation readOnlyHint festlegen)",
      };
    }
  }
  return undefined;
}

export function classificationDoubt(tool: Tool, cls: ToolClass, source: string): string | undefined {
  return classificationDoubtText(tool, cls, source)?.en;
}
