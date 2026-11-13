// Tool classification by the verb inside the NAME, wherever it stands: `slack_post_message`,
// `pipelines_create`, `ps_scale`, `API-patch-page`, `kubectl_apply`. The prefix patterns
// (`post_*`, `create_*`, `get_*`) only see a verb at the start of the name.
//
// Used only for tools that no annotation, flag or prefix pattern could classify, so nothing
// that is classified today changes. A name with both a write verb and a read verb
// (`get_or_create_user`, `API-post-search`) stays unclassified: the harness warns instead of
// guessing. A name with neither stays unclassified as well.
//
// The word lists are general API/CLI vocabulary, not tuned to individual tools. A tool whose
// semantics contradict its verb (`search_feedback` submits feedback) is not caught by names
// at all; the description hint (classification-doubt.ts) is the second line there.
import type { ToolClass } from "../engine/state-machine.js";

const WRITE_WORDS = new Set([
  "create", "add", "insert", "append", "prepend", "update", "edit", "modify", "patch", "put", "set",
  "delete", "remove", "drop", "destroy", "purge", "clear", "erase", "reset", "restore", "recover",
  "rename", "move", "copy", "clone", "duplicate", "push", "merge", "fork", "rebase", "revert",
  "apply", "deploy", "undeploy", "publish", "unpublish", "send", "post", "reply", "forward", "submit",
  "write", "save", "store", "persist", "upload", "import", "sync", "cancel", "approve", "reject",
  "deny", "book", "pay", "charge", "refund", "transfer", "withdraw", "deposit", "purchase", "buy",
  "register", "subscribe", "unsubscribe", "invite", "assign", "unassign", "close", "reopen",
  "enable", "disable", "toggle", "pause", "resume", "start", "stop", "restart", "kill", "terminate",
  "schedule", "sign", "revoke", "grant", "mark", "archive", "unarchive", "pin", "unpin", "star",
  "unstar", "like", "follow", "unfollow", "link", "unlink", "attach", "detach", "scale", "promote",
  "rollout", "rollback", "cordon", "drain", "install", "uninstall", "upgrade", "downgrade",
  "migrate", "cleanup", "flush", "commit",
]);

const READ_WORDS = new Set([
  "get", "list", "search", "find", "read", "fetch", "query", "retrieve", "show", "describe", "count",
  "view", "lookup", "resolve", "inspect", "browse", "preview", "explain", "download", "check",
  "verify", "status",
]);

// "slackPostMessage", "API-post-page", "kubectl_apply" -> lower-case words.
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
}

export function classifyByVerbWords(name: string): ToolClass {
  const words = nameWords(name);
  const write = words.some((w) => WRITE_WORDS.has(w));
  const read = words.some((w) => READ_WORDS.has(w));
  if (write && !read) return "write";
  if (read && !write) return "read";
  return "unclassified";
}
