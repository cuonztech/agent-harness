// Luckensuche, Stufe 1: Namensmatrix.
//
// Erzeugt Tool-Namen aus Verben (EN/DE/FR/ES) x Objekten x Schreibweisen. Die Wahrheit
// (schreibt / liest) steht durch die Konstruktion fest und haengt NICHT an der Wortliste
// des Harness (src/proxy/verb-words.ts): die Verblisten hier sind eigenstaendig geschrieben,
// aus Alltags- und Fachvokabular (Buchung, Zahlung, Ticket, Deployment ...). Grenze: sie
// stammen vom selben Autor wie der Harness; der unabhaengige Anker bleibt die Messung an
// echten Servern (real-servers.json).
//
// Bewusst NICHT aufgenommen: Verben, die je nach Kontext lesen oder schreiben
// (log, export, track, sync, resolve, process, handle, manage, run ...). Sie waeren Raten.

export type Wahrheit = "write" | "read";
export type Sprache = "en" | "de" | "fr" | "es";

export const WRITE_VERBEN: Record<Sprache, string[]> = {
  en: [
    "create", "add", "insert", "update", "modify", "edit", "delete", "remove", "destroy", "drop",
    "purge", "send", "post", "publish", "submit", "book", "reserve", "cancel", "refund", "charge",
    "pay", "transfer", "approve", "reject", "assign", "unassign", "archive", "restore", "rename",
    "move", "copy", "upload", "import", "deploy", "restart", "stop", "start", "kill", "enable",
    "disable", "activate", "deactivate", "merge", "close", "reopen", "escalate", "invite", "revoke",
    "grant", "subscribe", "unsubscribe", "register", "provision", "schedule", "reschedule", "notify",
    "trigger", "execute", "apply", "commit", "push", "tag", "label", "mark", "flag", "pin", "lock",
    "unlock", "sign", "issue", "void", "capture", "settle", "dispatch", "enqueue", "set", "put",
    "patch", "append", "write", "save", "store", "record", "reset", "rotate", "retry", "replay",
    "confirm", "complete", "finalize", "checkout", "order", "purchase", "buy", "sell", "ship",
    "deliver", "bill", "invoice", "withdraw", "deposit", "mint", "burn", "stake", "swap", "claim",
    "vote", "follow", "like", "reply", "forward", "share", "attach", "detach", "link", "unlink",
    "clone", "fork", "rollback", "promote", "demote", "block", "unblock", "ban", "mute", "snooze",
    "dismiss", "acknowledge", "escalate", "reassign", "renew", "extend", "terminate", "suspend",
  ],
  de: [
    "erstellen", "anlegen", "hinzufuegen", "loeschen", "entfernen", "aendern", "aktualisieren",
    "senden", "versenden", "buchen", "stornieren", "bezahlen", "ueberweisen", "freigeben",
    "ablehnen", "zuweisen", "archivieren", "verschieben", "hochladen", "importieren", "starten",
    "stoppen", "aktivieren", "deaktivieren", "schliessen", "einladen", "abonnieren", "registrieren",
    "bestellen", "speichern", "melden", "ausfuehren", "bestaetigen", "abschliessen", "kuendigen",
    "verlaengern", "eintragen", "ausbuchen", "einchecken", "auschecken", "reservieren", "absagen",
    "umbenennen", "kopieren", "veroeffentlichen", "genehmigen", "sperren", "entsperren", "buchung",
  ].filter((w) => w !== "buchung"),
  fr: [
    "creer", "ajouter", "supprimer", "modifier", "envoyer", "reserver", "annuler", "payer",
    "rembourser", "valider", "archiver", "deplacer", "telecharger", "importer", "activer",
    "desactiver", "fermer", "inviter", "enregistrer", "commander", "approuver", "refuser",
    "assigner", "renommer", "copier", "publier", "bloquer", "debloquer", "resilier", "renouveler",
  ],
  es: [
    "crear", "agregar", "eliminar", "borrar", "actualizar", "enviar", "reservar", "cancelar",
    "pagar", "aprobar", "rechazar", "asignar", "archivar", "mover", "subir", "importar",
    "activar", "desactivar", "cerrar", "invitar", "registrar", "pedir", "guardar", "confirmar",
    "renombrar", "copiar", "publicar", "bloquear", "desbloquear", "renovar",
  ],
};

export const READ_VERBEN: Record<Sprache, string[]> = {
  en: [
    "get", "list", "search", "find", "fetch", "retrieve", "query", "describe", "read", "show",
    "lookup", "view", "inspect", "browse", "count", "check", "summarize", "explain", "preview",
    "validate", "compare", "calculate", "estimate", "download", "poll", "peek", "scan", "probe",
    "locate", "enumerate", "lookup", "load", "open",
  ],
  de: [
    "lesen", "abrufen", "auflisten", "suchen", "anzeigen", "finden", "holen", "zeigen", "ermitteln",
    "pruefen", "abfragen", "zaehlen", "ansehen", "ausgeben", "berechnen", "vergleichen", "nachschlagen",
  ],
  fr: [
    "lire", "lister", "chercher", "afficher", "obtenir", "recuperer", "consulter", "rechercher",
    "trouver", "compter", "verifier", "decrire", "comparer", "calculer",
  ],
  es: [
    "obtener", "listar", "buscar", "leer", "consultar", "mostrar", "encontrar", "contar",
    "verificar", "describir", "comparar", "calcular", "ver",
  ],
};

// Objekte je Sprache (damit deutsche Namen deutsch bleiben).
export const OBJEKTE: Record<Sprache, string[]> = {
  en: ["booking", "order", "user", "invoice", "ticket", "customer", "payment", "message", "file", "page", "record", "subscription", "device", "task", "report", "shipment", "account", "deployment", "repository"],
  de: ["buchung", "bestellung", "benutzer", "rechnung", "ticket", "kunde", "zahlung", "nachricht", "datei", "seite", "eintrag", "abo", "geraet", "aufgabe", "bericht", "sendung", "konto"],
  fr: ["reservation", "commande", "utilisateur", "facture", "ticket", "client", "paiement", "message", "fichier", "page", "enregistrement", "abonnement", "appareil", "tache", "rapport", "compte"],
  es: ["reserva", "pedido", "usuario", "factura", "ticket", "cliente", "pago", "mensaje", "archivo", "pagina", "registro", "suscripcion", "dispositivo", "tarea", "informe", "cuenta"],
};

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function umlaute(s: string): string {
  return s.replace(/ae/g, "ä").replace(/oe/g, "ö").replace(/ue/g, "ü").replace(/AE/g, "Ä").replace(/OE/g, "Ö").replace(/UE/g, "Ü");
}

export interface Stil {
  id: string;
  /** (verb, objekt) -> Name */
  bau: (v: string, o: string) => string;
  /** Verb steht nicht am Anfang des Namens (z. B. Objekt zuerst). */
  verbHinten?: boolean;
}

export const STILE: Stil[] = [
  { id: "snake", bau: (v, o) => `${v}_${o}` },
  { id: "kebab", bau: (v, o) => `${v}-${o}` },
  { id: "camel", bau: (v, o) => `${v}${cap(o)}` },
  { id: "pascal", bau: (v, o) => `${cap(v)}${cap(o)}` },
  { id: "upper", bau: (v, o) => `${v}_${o}`.toUpperCase() },
  { id: "objekt-zuerst", bau: (v, o) => `${o}_${v}`, verbHinten: true },
  { id: "punkt", bau: (v, o) => `${o}.${v}`, verbHinten: true },
  { id: "schraegstrich", bau: (v, o) => `${o}s/${v}`, verbHinten: true },
  { id: "namespace", bau: (v, o) => `crm.${v}_${o}` },
  { id: "mcp-praefix", bau: (v, o) => `mcp__crm__${v}_${o}` },
  { id: "api-v2", bau: (v, o) => `api_v2_${v}_${o}` },
  { id: "suffix-tool", bau: (v, o) => `${v}_${o}_tool` },
  { id: "suffix-v2", bau: (v, o) => `${v}${cap(o)}V2` },
  { id: "plural", bau: (v, o) => `${v}_${o}s` },
  { id: "nur-verb", bau: (v) => v },
];

export type Beschreibung = "keine" | "passend" | "neutral";

/** Beschreibungstexte: passend (sagt dasselbe wie die Wahrheit) und neutral (sagt nichts). */
export function beschreibung(art: Beschreibung, wahrheit: Wahrheit, sprache: Sprache, objekt: string): string | undefined {
  if (art === "keine") return undefined;
  if (art === "neutral") return `Tool fuer ${objekt}.`;
  if (sprache === "de") return wahrheit === "write" ? `Aendert oder legt ${objekt} an.` : `Liefert ${objekt} zurueck.`;
  if (sprache === "fr") return wahrheit === "write" ? `Modifie ou cree ${objekt}.` : `Retourne ${objekt}.`;
  if (sprache === "es") return wahrheit === "write" ? `Modifica o crea ${objekt}.` : `Devuelve ${objekt}.`;
  return wahrheit === "write" ? `Creates or modifies the ${objekt}.` : `Returns the ${objekt}.`;
}

export interface NameFall {
  name: string;
  wahrheit: Wahrheit;
  sprache: Sprache;
  verb: string;
  objekt: string;
  stil: string;
  gruppe: "matrix" | "falle";
  beschreibung?: string;
}

export interface Probenmenge {
  faelle: NameFall[];
}

/**
 * Matrix: jedes Verb mit EINEM Objekt (rotierend, damit alle Objekte vorkommen), in jedem
 * Stil, mit jeder Beschreibung. Das haelt die Zahl bei einigen zehntausend.
 */
export function matrix(beschr: Beschreibung[] = ["keine", "passend", "neutral"]): NameFall[] {
  const out: NameFall[] = [];
  for (const wahrheit of ["write", "read"] as const) {
    const verben = wahrheit === "write" ? WRITE_VERBEN : READ_VERBEN;
    for (const sprache of Object.keys(verben) as Sprache[]) {
      const objekte = OBJEKTE[sprache];
      [...new Set(verben[sprache])].forEach((verb, i) => {
        for (const stil of STILE) {
          const objekt = objekte[(i + stil.id.length) % objekte.length];
          for (const b of beschr) {
            const fall: NameFall = {
              name: stil.bau(verb, objekt),
              wahrheit,
              sprache,
              verb,
              objekt,
              stil: stil.id,
              gruppe: "matrix",
              beschreibung: beschreibung(b, wahrheit, sprache, objekt),
            };
            out.push(fall);
            // Deutsche Namen kommen in der Praxis auch mit echten Umlauten vor.
            const mitUmlaut = umlaute(fall.name);
            if (sprache === "de" && mitUmlaut !== fall.name) {
              out.push({ ...fall, name: mitUmlaut, stil: `${stil.id}+umlaut` });
            }
          }
        }
      });
    }
  }
  return out;
}

/**
 * Handbeschriftete Fallen: Namen, bei denen Wort und Wirkung auseinanderlaufen. Die Wahrheit
 * folgt der Beschreibung (die ein ehrlicher Server mitliefert); `beschreibung` ist gesetzt.
 */
export const FALLEN: Array<{ name: string; wahrheit: Wahrheit; beschreibung: string }> = [
  // Schreiben unter Lese-Namen
  { name: "check_in_guest", wahrheit: "write", beschreibung: "Checks a guest in and bills the first night." },
  { name: "status_change", wahrheit: "write", beschreibung: "Changes the status of a ticket." },
  { name: "get_or_create_user", wahrheit: "write", beschreibung: "Returns the user, creating it when missing." },
  { name: "read_and_delete_message", wahrheit: "write", beschreibung: "Reads a message and deletes it from the queue." },
  { name: "list_and_clear_queue", wahrheit: "write", beschreibung: "Lists pending jobs and removes them." },
  { name: "view_and_mark_read", wahrheit: "write", beschreibung: "Shows the notification and marks it as read." },
  { name: "count_and_increment", wahrheit: "write", beschreibung: "Counts page views and increments the counter." },
  { name: "getV2", wahrheit: "write", beschreibung: "Fetches the next job and locks it for the caller." },
  { name: "check_out", wahrheit: "write", beschreibung: "Checks out the cart and charges the card." },
  { name: "status_set", wahrheit: "write", beschreibung: "Sets the status." },
  { name: "peek_and_ack", wahrheit: "write", beschreibung: "Pops a message from the queue and acknowledges it." },
  { name: "fetch_and_lock_job", wahrheit: "write", beschreibung: "Fetches the next job and locks it." },
  { name: "lookup_or_register_device", wahrheit: "write", beschreibung: "Looks up a device and registers it if unknown." },
  { name: "validate_and_submit_form", wahrheit: "write", beschreibung: "Validates the form and submits it." },
  { name: "preview_and_publish", wahrheit: "write", beschreibung: "Renders a preview and publishes the page." },
  // Lesen unter Schreib-Namen
  { name: "update_status_view", wahrheit: "read", beschreibung: "Refreshes the status view (read only)." },
  { name: "create_report_preview", wahrheit: "read", beschreibung: "Returns a preview of the report. Does not store anything." },
  { name: "send_test_preview", wahrheit: "read", beschreibung: "Returns what the email would look like. Nothing is sent." },
  { name: "set_filter_view", wahrheit: "read", beschreibung: "Returns the list with the given filter applied (no changes)." },
  { name: "delete_preview", wahrheit: "read", beschreibung: "Dry run: shows what a delete would remove. Read only." },
  { name: "run_query", wahrheit: "read", beschreibung: "Runs a read-only SQL query and returns rows." },
  { name: "execute_search", wahrheit: "read", beschreibung: "Executes a search and returns the hits." },
  { name: "apply_filter", wahrheit: "read", beschreibung: "Returns items matching the filter." },
  { name: "post_search", wahrheit: "read", beschreibung: "Searches posts and returns the matches." },
  { name: "tag_list", wahrheit: "read", beschreibung: "Lists all tags." },
  { name: "mark_list", wahrheit: "read", beschreibung: "Lists all bookmarks." },
  { name: "order_status", wahrheit: "read", beschreibung: "Returns the status of an order." },
  { name: "book_availability", wahrheit: "read", beschreibung: "Returns free slots for booking." },
  { name: "invoice_pdf_render", wahrheit: "read", beschreibung: "Renders the invoice as a PDF and returns it." },
  { name: "send_status", wahrheit: "read", beschreibung: "Returns the delivery status of a message." },
];
