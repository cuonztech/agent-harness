// Tool classification by the verb inside the NAME, wherever it stands: `slack_post_message`,
// `pipelines_create`, `ps_scale`, `API-patch-page`, `kubectl_apply`. The prefix patterns
// (`post_*`, `create_*`, `get_*`) only see a verb at the start of the name.
//
// This is a GUESS, and the two directions are not equally dangerous:
//   * a write taken for a read is silent (duplicates through it are never seen) and is the
//     worst error this module could make;
//   * a read taken for a write only makes a scenario fire on a read.
// So a read is inferred only from STRONG read verbs (get, list, search, find, fetch, retrieve,
// query, describe, read, show, lookup). Words that are as often nouns (`status`, `view`, `count`,
// `check`, `resolve`, `preview`) do not make a tool a read: `change_status` and
// `increment_view_count` write.
//
// Used only for tools that no annotation, flag or prefix pattern could classify, so nothing that
// is classified today changes. A name with both a write verb and a strong read verb
// (`API-post-search`) stays unclassified, and so does a name whose DESCRIPTION contradicts the
// guess (a "write" whose description opens with "Returns …", a "read" that "creates" something).
// Every tool classified here is named as a guess at startup and in the report.
import type { ToolClass } from "../engine/state-machine.js";
import {
  describesWriting,
  descriptionOpensWithReadVerb,
  descriptionOpensWithWriteVerb,
  descriptionSaysReadOnly,
} from "./classification-doubt.js";

const WRITE_WORDS = new Set([
  "create", "add", "insert", "append", "prepend", "update", "edit", "modify", "change", "patch", "put", "set",
  "delete", "remove", "drop", "destroy", "purge", "clear", "erase", "reset", "restore", "recover",
  "rename", "replace", "move", "copy", "clone", "duplicate", "push", "merge", "fork", "rebase", "revert",
  "apply", "deploy", "undeploy", "publish", "unpublish", "send", "post", "reply", "forward", "submit",
  "write", "save", "store", "persist", "upload", "import", "sync", "cancel", "approve", "reject",
  "deny", "book", "pay", "charge", "refund", "transfer", "withdraw", "deposit", "purchase", "buy",
  "register", "subscribe", "unsubscribe", "invite", "assign", "unassign", "close", "reopen",
  "enable", "disable", "toggle", "pause", "resume", "start", "stop", "restart", "kill", "terminate",
  "schedule", "sign", "revoke", "grant", "mark", "archive", "unarchive", "pin", "unpin", "star",
  "unstar", "like", "follow", "unfollow", "link", "unlink", "attach", "detach", "scale", "promote",
  "rollout", "rollback", "cordon", "drain", "install", "uninstall", "upgrade", "downgrade",
  "migrate", "cleanup", "flush", "commit", "increment", "decrement", "lock", "unlock", "mute",
  "unmute", "rotate", "enroll",
  // 0.11.0 (Luckensuche, docs/LUECKEN-NAMEN.md): everyday verbs that were missing.
  "activate", "deactivate", "escalate", "provision", "reschedule", "notify", "trigger", "execute",
  "retry", "replay", "finalize", "dispatch", "enqueue", "dequeue", "capture", "settle", "void",
  "deliver", "unstake", "bridge", "dismiss", "acknowledge", "reassign", "renew", "unblock", "unban",
  "checkout", "checkin", "remit", "reconcile", "redeem", "disburse", "onboard", "offboard",
  "authorize", "deauthorize", "whitelist", "blacklist", "allowlist", "denylist", "quarantine",
  "evict", "decommission", "sell", "ack", "nack",
]);

// Words that are as often NOUNS as verbs (`order_status`, `explain_invoice`, `download_record`): they
// count as a write verb only at VERB position (the first word, after an `api`/`v2`/`mcp` namespace)
// and only when no word naming a state or a listing stands next to them.
const AMBIGUOUS_WRITE_WORDS = new Set([
  "order", "record", "flag", "label", "tag", "claim", "vote", "share", "swap", "stake", "bill",
  "invoice", "ship", "block", "burn", "mint", "ban", "snooze", "complete", "extend", "suspend",
  "demote",
]);
const STATE_NOUNS = new Set([
  "status", "state", "info", "information", "details", "detail", "history", "list", "summary",
  "availability", "preview", "report", "log", "logs", "count", "stats", "statistics", "overview",
  "health", "estimate", "quote", "price", "total",
  // Read-ish words that are not strong enough to make a name a read, but veto an ambiguous noun-verb
  // ("order.check", "invoice.explain", "record.poll").
  "check", "explain", "summarize", "compare", "calculate", "validate", "poll", "scan", "locate", "load",
  "browse", "download", "inspect", "view", "verify", "peek", "probe", "enumerate", "comparer", "calculer",
  "decrire", "contar", "comparar", "calcular", "describir", "verificar", "pruefen", "zaehlen", "vergleichen",
  "berechnen",
]);

// German, French and Spanish tool names (`buchung_erstellen`, `supprimer_facture`, `crear_pedido`).
// Letters are compared in a plain form (ä→ae, ö→oe, ü→ue, ß→ss, accents dropped), so "löschen",
// "loeschen" and "loschen" meet. The German imperative ("erstelle") is derived.
const FOREIGN_INFINITIVES: Record<string, string[]> = {
  de: [
    "erstellen", "anlegen", "hinzufuegen", "loeschen", "entfernen", "aendern", "aktualisieren", "senden",
    "versenden", "buchen", "stornieren", "bezahlen", "ueberweisen", "freigeben", "ablehnen", "zuweisen",
    "archivieren", "verschieben", "hochladen", "importieren", "starten", "stoppen", "aktivieren",
    "deaktivieren", "schliessen", "einladen", "abonnieren", "registrieren", "bestellen", "speichern",
    "melden", "ausfuehren", "bestaetigen", "abschliessen", "kuendigen", "verlaengern", "eintragen",
    "ausbuchen", "einchecken", "auschecken", "reservieren", "absagen", "umbenennen", "kopieren",
    "veroeffentlichen", "genehmigen", "sperren", "entsperren", "ueberschreiben", "zuruecksetzen",
    "erzeugen", "schreiben", "bearbeiten", "ersetzen", "abbrechen", "erneuern", "beenden", "pausieren",
    "fortsetzen", "zahlen", "erfassen", "verbuchen", "auszahlen", "einzahlen", "zurueckerstatten",
  ],
  fr: [
    "creer", "ajouter", "supprimer", "modifier", "envoyer", "reserver", "annuler", "payer", "rembourser",
    "valider", "archiver", "deplacer", "telecharger", "importer", "activer", "desactiver", "fermer",
    "inviter", "enregistrer", "commander", "approuver", "refuser", "assigner", "renommer", "copier",
    "publier", "bloquer", "debloquer", "resilier", "renouveler", "mettre", "effacer", "remplacer",
    "ecrire", "sauvegarder", "declencher", "executer", "soumettre", "confirmer", "reinitialiser",
  ],
  es: [
    "crear", "agregar", "eliminar", "borrar", "actualizar", "enviar", "reservar", "cancelar", "pagar",
    "aprobar", "rechazar", "asignar", "archivar", "mover", "subir", "importar", "activar", "desactivar",
    "cerrar", "invitar", "registrar", "pedir", "guardar", "confirmar", "renombrar", "copiar", "publicar",
    "bloquear", "desbloquear", "renovar", "modificar", "anadir", "escribir", "reemplazar", "ejecutar",
    "reiniciar", "suspender", "reembolsar", "transferir", "solicitar",
  ],
};
const FOREIGN_READ_INFINITIVES: Record<string, string[]> = {
  de: ["lesen", "auflisten", "suchen", "anzeigen", "finden", "holen", "abrufen", "abfragen", "ansehen", "nachschlagen", "zeigen", "ermitteln"],
  fr: ["lire", "lister", "chercher", "afficher", "obtenir", "recuperer", "consulter", "rechercher", "trouver"],
  es: ["obtener", "listar", "buscar", "leer", "consultar", "mostrar", "encontrar"],
};

// Infinitives count anywhere (`buchung_erstellen`). German imperatives ("erstelle") are derived and
// count only at verb position.
function foreignForms(infinitives: Record<string, string[]>): { inf: Set<string>; imp: Set<string> } {
  const inf = new Set<string>();
  const imp = new Set<string>();
  for (const [lang, list] of Object.entries(infinitives)) {
    for (const word of list) {
      inf.add(word);
      if (lang === "de" && word.endsWith("en")) {
        const stem = word.slice(0, -2);
        if (stem.length >= 4) imp.add(`${stem}e`);
      }
      // French and Spanish imperatives ("commande", "reserva") are nouns as well and collide with
      // noun-first names (`commande_liste`): only their infinitives count.
    }
  }
  return { inf, imp };
}
const FOREIGN_WRITE = foreignForms(FOREIGN_INFINITIVES);
const FOREIGN_READ = foreignForms(FOREIGN_READ_INFINITIVES);

// Verb position: the first word, or the first after namespace words ("mcp", "api", "v2", "tool").
function atVerbPosition(all: string[], index: number): boolean {
  return all.slice(0, index).every((w) => /^(mcp|api|v\d+|tool|tools)$/.test(w));
}

// Plain form for the lookup: ä→ae, ö→oe, ü→ue, ß→ss, other accents dropped.
export function plainWord(w: string): string {
  return w
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

function isWriteWord(word: string, all: string[], index: number, allowAmbiguous = true): boolean {
  const w = plainWord(word);
  if (WRITE_WORDS.has(w) || FOREIGN_WRITE.inf.has(w)) return true;
  if (FOREIGN_WRITE.imp.has(w)) return atVerbPosition(all, index);
  if (AMBIGUOUS_WRITE_WORDS.has(w)) {
    return allowAmbiguous && atVerbPosition(all, index) && !all.some((x) => STATE_NOUNS.has(plainWord(x)));
  }
  return false;
}
function isStrongReadWord(word: string, all: string[], index: number): boolean {
  const w = plainWord(word);
  if (STRONG_READ_WORDS.has(w) || FOREIGN_READ.inf.has(w)) return true;
  return FOREIGN_READ.imp.has(w) && atVerbPosition(all, index);
}

const STRONG_READ_WORDS = new Set([
  "get", "list", "search", "find", "fetch", "retrieve", "query", "describe", "read", "show", "lookup",
]);

// "slackPostMessage", "API-post-page", "kubectl_apply", "Ändern_Status" -> lower-case words.
// Letters by Unicode class: a word in another script stays one word.
export function nameWords(name: string): string[] {
  return name
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

export function classifyByVerbWords(name: string, description?: string): ToolClass {
  // "get_or_create_user", "list_and_clear_queue": a read verb, then a write verb after and/or/then. The
  // name itself says it writes; only a read-only statement in the description argues against it.
  if (readPrefixThenWrites(name)) return compoundWriteGuess(description);
  const words = nameWords(name);
  const write = words.some((w, i) => isWriteWord(w, words, i));
  const read = words.some((w, i) => isStrongReadWord(w, words, i));
  let guess: ToolClass = "unclassified";
  if (write && !read) guess = "write";
  else if (read && !write) guess = "read";
  if (guess === "unclassified" || !description) return guess;
  // The description is a second witness: a contradiction means no guess.
  if (guess === "write" && (descriptionOpensWithReadVerb(description) || descriptionSaysReadOnly(description))) return "unclassified";
  if (guess === "read" && describesWriting(description) !== null) return "unclassified";
  return guess;
}

// A name that STARTS like a read but goes on to write ("get_or_create_user", "read_and_delete",
// "fetch_and_store", "search_and_replace"): the read prefix alone would call it a read.
export function readPrefixThenWrites(name: string): boolean {
  const words = nameWords(name);
  const conj = words.findIndex((w, i) => i > 0 && (w === "and" || w === "or" || w === "then"));
  return conj !== -1 && words.some((w, i) => i > conj && isWriteWord(w, words, i));
}

// The guess for a compound name (read verb, then a write verb): "write", unless the description says
// the tool only reads. Prose that merely opens like a read ("Returns the user, creating it when
// missing") does not contradict a name that spells out the write.
export function compoundWriteGuess(description?: string): ToolClass {
  return description && descriptionSaysReadOnly(description) ? "unclassified" : "write";
}

// Read prefixes that are as often a NOUN as a verb (`status`, `check`, `view`, `count`, `verify`).
// `check_in_guest`, `check_out`, `status_change`, `status_set` start with one and then write: the
// prefix alone would call them reads (a write taken for a read is silent). Returns "write" (a
// guess, like every verb-word guess), "unclassified" when the description contradicts it, or null
// when the name does not look like that.
const WEAK_READ_PREFIXES = new Set(["check", "status", "count", "view", "verify"]);
export function weakReadPrefixThenWrites(name: string, description?: string): ToolClass | null {
  const words = nameWords(name);
  if (words.length < 2 || !WEAK_READ_PREFIXES.has(words[0])) return null;
  const rest = words.slice(1);
  const checkInOut = words[0] === "check" && (rest[0] === "in" || rest[0] === "out");
  // After the prefix the verb position starts again ("status_set", "check_in_guest").
  const writes = checkInOut || rest.some((w, i) => isWriteWord(w, rest, i, false));
  if (!writes || rest.some((w, i) => isStrongReadWord(w, rest, i))) return null;
  // "Checks a guest in and bills the first night" opens like a read but writes: only a description that
  // opens like a read and says nothing about writing, or says read-only, is a contradiction.
  if (description && (descriptionSaysReadOnly(description) || (descriptionOpensWithReadVerb(description) && describesWriting(description) === null))) {
    return "unclassified";
  }
  return "write";
}

// A name nothing else could place: the description opens with a plain write verb ("Creates a
// booking", "Löscht einen Eintrag"). Only ever lifts to "write" (the safe direction: at worst a
// scenario fires on a read); a read is never inferred from prose.
export function classifyByDescriptionOpener(description?: string): ToolClass {
  if (!description) return "unclassified";
  if (descriptionSaysReadOnly(description) || descriptionOpensWithReadVerb(description)) return "unclassified";
  return descriptionOpensWithWriteVerb(description) ? "write" : "unclassified";
}
