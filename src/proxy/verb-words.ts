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
import { describesWriting, descriptionOpensWithReadVerb, descriptionSaysReadOnly } from "./classification-doubt.js";

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
]);

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
  const words = nameWords(name);
  const write = words.some((w) => WRITE_WORDS.has(w));
  const read = words.some((w) => STRONG_READ_WORDS.has(w));
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
  return conj !== -1 && words.slice(conj + 1).some((w) => WRITE_WORDS.has(w));
}
