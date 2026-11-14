// Statisches Schnittstellen-Gutachten: liest nur die `tools/list`-Antwort eines
// MCP-Servers und beurteilt, wie gut sich ein Schreib-Tool gegen Doppelausführung
// absichern lässt. Es wird nichts aufgerufen und nichts gemessen; das Ergebnis
// beschreibt das Schema, nicht das Verhalten eines Agenten.
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { classifyUpstreamTool } from "./proxy/interceptor.js";
import { DEFAULT_KEY_FIELDS, isKeyField } from "./engine/state-machine.js";
import type {
  SchemaAuditReport,
  SchemaRiskLevel,
  SchemaToolClassification,
  ToolInput,
  ToolSchemaAuditEntry,
} from "./types.js";

export interface SchemaAuditOptions {
  // Wie bei --write-tools / --read-tools: ersetzt die Namensmuster.
  writeToolPatterns?: string[];
  readToolPatterns?: string[];
  // Wie bei --key-fields: Feldnamen, die einen Schlüssel tragen. Standard: dieselbe Liste wie im Lauf (DEFAULT_KEY_FIELDS).
  keyFields?: string[];
}

// Felder, die das Gutachten zusätzlich als Schlüssel gelten lässt, obwohl der Proxy sie im Lauf nicht von sich aus
// kennt (zu oft ein fachliches Datum): ohne Trennzeichen und Gross-/Kleinschreibung verglichen. Für diese steht der
// Hinweis, --key-fields anzugeben.
const SCHEMA_ONLY_KEY_FIELDS = new Set(["transactionid", "clientreferenceid"]);

// Allgemeiner Mustervorschlag; die Beschreibung nennt das Tool, die Logik ist für jedes Tool dieselbe.
function idempotencyPatch(toolName: string): Record<string, unknown> {
  return {
    type: "string",
    description: `Eindeutiger Schlüssel für diesen Aufruf von ${shown(toolName)}: Bei einer Wiederholung nach einem Timeout denselben Wert noch einmal senden, damit der Server den Vorgang nur einmal ausführt.`,
  };
}

// Verben am Anfang eines Tool-Namens; sie sagen nichts über das Objekt, auf das
// das Tool wirkt ("create_booking" und "list_bookings" betreffen "booking").
const VERBS = new Set([
  "create", "add", "book", "send", "update", "delete", "remove", "cancel", "submit", "post", "insert",
  "register", "schedule", "transfer", "refund", "reserve", "issue", "withdraw", "deposit", "purchase",
  "approve", "pay", "charge", "confirm", "place", "write", "set", "make", "new", "check", "apply",
  "get", "list", "search", "find", "read", "fetch", "query", "show", "lookup", "view", "count",
  "describe", "retrieve", "browse", "filter",
]);
const STOP_WORDS = new Set(["a", "an", "the", "by", "for", "of", "in", "to", "on", "with", "from", "my", "me"]);
// Namen, die kein bestimmtes Objekt bezeichnen: ein Tool, das nur aus Verb und
// einem solchen Wort besteht ("search", "list_all", "query_records"), sucht überall.
const GENERIC_NOUNS = new Set(["all", "any", "everything", "record", "item", "object", "data", "entity", "resource", "result"]);
const LOOKUP_VERBS = new Set(["list", "search", "find", "query", "lookup", "browse", "filter", "get", "read", "fetch", "retrieve", "show", "view"]);

function tokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function singular(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(ses|xes|zes|ches|shes)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

function nouns(name: string): string[] {
  return tokens(name)
    .filter((t) => !VERBS.has(t) && !STOP_WORDS.has(t))
    .map(singular);
}

function isGenericLookup(name: string): boolean {
  const parts = tokens(name);
  const first = parts[0];
  if (first === undefined || !LOOKUP_VERBS.has(first)) return false;
  const rest = nouns(name);
  return rest.length === 0 || rest.every((n) => GENERIC_NOUNS.has(n));
}

function normalizedFieldName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

// Das erste Schlüsselfeld des Tools: oberste Ebene zuerst, dann eine Ebene tiefer ("meta.request_id").
function findKeyField(tool: ToolInput, keyFields: string[]): { name: string; nested: boolean } | null {
  const properties = tool.inputSchema?.properties;
  if (properties === null || typeof properties !== "object") return null;
  for (const name of Object.keys(properties)) {
    if (isKeyField(name, keyFields) || SCHEMA_ONLY_KEY_FIELDS.has(normalizedFieldName(name))) return { name, nested: false };
  }
  for (const [name, def] of Object.entries(properties)) {
    const inner = def !== null && typeof def === "object" ? (def as { properties?: unknown }).properties : undefined;
    if (inner === null || typeof inner !== "object" || inner === undefined) continue;
    for (const child of Object.keys(inner as Record<string, unknown>)) {
      if (isKeyField(child, keyFields)) return { name: `${name}.${child}`, nested: true };
    }
  }
  return null;
}

function isIdField(field: string): boolean {
  return (
    field.toLowerCase() === "id" ||
    /[_-]id$/i.test(field) ||
    /[a-z0-9]Id$/.test(field) ||
    /(^|[_-])uuid$/i.test(field) ||
    /[a-z0-9]Uuid$/.test(field)
  );
}

function propertyNames(tool: ToolInput): string[] {
  const properties = tool.inputSchema?.properties;
  return properties !== null && typeof properties === "object" ? Object.keys(properties) : [];
}

function requiresId(tool: ToolInput): boolean {
  const required = tool.inputSchema?.required;
  return Array.isArray(required) && required.some((f) => typeof f === "string" && isIdField(f));
}

function hasAnnotations(tool: ToolInput): boolean {
  const a = tool.annotations;
  if (a === undefined || a === null || typeof a !== "object") return false;
  return a.readOnlyHint !== undefined || a.destructiveHint !== undefined || a.idempotentHint !== undefined;
}

// Ein Tool-Name kommt vom Upstream: Steuerzeichen dürfen in Texten keine Zeilen vortäuschen.
export function shown(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

function summarize(
  total: number,
  writes: number,
  reads: number,
  ambiguous: number,
  withoutKey: string[],
  withoutLookup: string[],
  high: number,
): string {
  if (total === 0) return "Der Server meldet keine Tools; es gab nichts zu beurteilen.";
  const parts: string[] = [
    `Der Server bietet ${total} ${plural(total, "Tool", "Tools")}: ${writes} schreibend, ${reads} lesend` +
      (ambiguous > 0 ? `, ${ambiguous} nicht eindeutig einzuordnen` : "") +
      ".",
  ];
  if (writes + ambiguous === 0) {
    parts.push("Es wurde kein Schreib-Tool erkannt; damit gibt es keine Doppelausführung zu verhindern und kein Szenario, das auslösen könnte.");
    return parts.join(" ");
  }
  parts.push(
    withoutKey.length === 0
      ? "Alle Schreib-Tools haben ein Feld für einen Idempotenz-Schlüssel."
      : `${withoutKey.length} ${plural(withoutKey.length, "Schreib-Tool hat", "Schreib-Tools haben")} keinen Idempotenz-Schlüssel (${withoutKey.map(shown).join(", ")}): Das Zielsystem kann einen wiederholten Aufruf nicht als Duplikat erkennen.`,
  );
  parts.push(
    withoutLookup.length === 0
      ? "Für alle Schreib-Tools gibt es ein Lese- oder Such-Tool ohne Pflicht-ID, mit dem ein Agent nach einem Timeout nachsehen kann."
      : `Für ${withoutLookup.length} ${plural(withoutLookup.length, "Schreib-Tool gibt", "Schreib-Tools gibt")} es kein Lese- oder Such-Tool ohne Pflicht-ID (${withoutLookup.map(shown).join(", ")}): Ein Agent kann nach einem Timeout nicht selbstständig prüfen, ob der Vorgang schon ausgeführt wurde.`,
  );
  parts.push(
    high === 0
      ? "Kein Tool hat die Risikostufe HOCH."
      : `${high} ${plural(high, "Tool hat", "Tools haben")} die Risikostufe HOCH (weder Schlüssel noch Nachsehen ohne ID).`,
  );
  return parts.join(" ");
}

export function auditToolSchemas(tools: ToolInput[], options: SchemaAuditOptions = {}): SchemaAuditReport {
  const config = {
    writeToolPatterns: options.writeToolPatterns ?? [],
    readToolPatterns: options.readToolPatterns ?? [],
  };
  const keyFields = options.keyFields && options.keyFields.length > 0 ? options.keyFields : DEFAULT_KEY_FIELDS;
  // Einordnung samt Zweifel (0.11.1): Widerspricht die Beschreibung dem Namen oder die Annotation dem Namen, steht das
  // im Gutachten, statt dass ein Tool stillschweigend als Schreib-Tool mit Risiko HOCH oder als «Lesend, NIEDRIG» geführt wird.
  interface Placed {
    classification: SchemaToolClassification;
    note?: string;
    // Die Beschreibung widerspricht einem Schreib-Tool nach dem Namen: kein Risiko HOCH daraus.
    readLooking?: boolean;
  }
  const place = (tool: ToolInput): Placed => {
    const result = classifyUpstreamTool(tool as unknown as Tool, config);
    const base: SchemaToolClassification = result.class === "unclassified" ? "ambiguous" : result.class;
    if (result.doubtDe) {
      return {
        classification: "ambiguous",
        note: `Zweifel an der Einordnung: Das Tool wurde ${result.doubtDe}.`,
        readLooking: result.class === "write",
      };
    }
    if (result.source.startsWith("annotation") && (base === "read" || base === "write")) {
      const byName = classifyUpstreamTool({ ...(tool as unknown as Tool), annotations: undefined }, config);
      if ((byName.class === "write" || byName.class === "read") && byName.class !== base) {
        const nameSays = byName.class === "write" ? "schreibend" : "lesend";
        const annotationSays = base === "read" ? "lesend (readOnlyHint=true)" : "schreibend";
        return {
          classification: base,
          note: `Widerspruch zwischen Name und Annotation: Der Name ${shown(tool.name)} sieht ${nameSays} aus, die Annotation sagt ${annotationSays}. Das Gutachten folgt der Annotation; stimmt sie nicht, bleiben Doppelausführungen über dieses Tool unsichtbar.`,
        };
      }
    }
    return { classification: base };
  };
  const classified = tools.map((tool) => ({ tool, ...place(tool) }));
  const readTools = classified.filter((c) => c.classification === "read").map((c) => c.tool);

  const entries: ToolSchemaAuditEntry[] = classified.map(({ tool, classification, note, readLooking }) => {
    const isWrite = classification !== "read";
    const keyMatch = findKeyField(tool, keyFields);
    const keyField = keyMatch?.name ?? null;
    const hasKey = keyField !== null;
    const annotated = hasAnnotations(tool);

    let matching: string[] = [];
    if (isWrite) {
      const own = new Set(nouns(tool.name));
      matching = readTools
        .filter((r) => r.name !== tool.name && (nouns(r.name).some((n) => own.has(n)) || isGenericLookup(r.name)))
        .map((r) => r.name);
    }
    const canVerify = isWrite && readTools.some((r) => matching.includes(r.name) && !requiresId(r));

    let risk: SchemaRiskLevel = "LOW";
    if (isWrite) {
      if (!hasKey && !canVerify) risk = "HIGH";
      else if (!hasKey || !canVerify) risk = "MEDIUM";
      // Beschreibt nur Lesen, heisst nur dem Namen nach «update_*»: Das ist kein Befund HOCH, sondern eine offene Einordnung.
      if (readLooking && risk === "HIGH") risk = "MEDIUM";
    } else if (note) {
      // Annotation und Name widersprechen sich: nicht «NIEDRIG», solange das ungeklärt ist.
      risk = "MEDIUM";
    }

    const findings: string[] = [];
    if (note) findings.push(note);
    if (isWrite) {
      if (classification === "ambiguous" && !note) {
        findings.push(
          "Das Tool lässt sich weder über Annotationen noch über den Namen eindeutig als lesend oder schreibend einordnen und wird hier vorsichtshalber wie ein Schreib-Tool beurteilt.",
        );
      }
      if (!hasKey) {
        findings.push(
          "Kein Idempotenz-Schlüssel (z. B. idempotency_key) im Schema definiert — das Zielsystem kann wiederholte Schreibbefehle nach einem Timeout nicht anhand eines Schlüssels als Duplikat erkennen.",
        );
      } else if (keyMatch?.nested) {
        findings.push(
          `Hinweis: Das Schlüsselfeld liegt verschachtelt ('${shown(keyField)}'). Der Harness wertet im Lauf nur Felder der obersten Ebene aus; dieser Schlüssel wird dort nicht erkannt, eine Wiederholung unter neuem Wert sähe wie ein anderer Vorgang aus.`,
        );
      } else if (!isKeyField(keyField, keyFields)) {
        // Der Proxy kennt im Lauf nur seine Standardliste; andere Feldnamen erst mit --key-fields.
        findings.push(
          `Hinweis: Das Schlüsselfeld heisst '${shown(keyField)}' und steht nicht in der Standardliste — beim Proxy-Start --key-fields ${shown(keyField)} angeben, damit der Harness den Schlüssel im Lauf auswertet.`,
        );
      }
      if (!canVerify) {
        findings.push(
          matching.length === 0
            ? "Kein passendes Lese- oder Such-Tool ohne Pflicht-ID gefunden — der Agent kann nach einem abgebrochenen Schreibbefehl nicht selbstständig prüfen, ob der Vorgang bereits ausgeführt wurde."
            : `Die passenden Lese-Tools (${matching.map(shown).join(", ")}) verlangen alle eine ID als Pflichtfeld — nach einem Timeout kennt der Agent die vom Server vergebene ID noch nicht und kann den Vorgang nicht selbstständig nachschlagen.`,
        );
      }
      if (!annotated) {
        findings.push("Keine MCP-Tool-Annotationen (readOnlyHint / destructiveHint / idempotentHint) hinterlegt.");
      }
    }

    return {
      name: tool.name,
      classification,
      hasIdempotencyKey: hasKey,
      idempotencyFieldName: keyField,
      hasMcpAnnotations: annotated,
      matchingReadTools: matching,
      canVerifyWithoutId: canVerify,
      riskLevel: risk,
      findingsDe: findings,
      ...(note ? { classificationNoteDe: note } : {}),
      recommendedSchemaPatch: isWrite && !hasKey ? idempotencyPatch(tool.name) : null,
    };
  });

  const writeLike = entries.filter((e) => e.classification !== "read");
  const writeToolsWithoutIdempotencyKey = writeLike.filter((e) => !e.hasIdempotencyKey).map((e) => e.name);
  const writeToolsWithoutLookupTool = writeLike.filter((e) => !e.canVerifyWithoutId).map((e) => e.name);
  const count = (c: SchemaToolClassification): number => entries.filter((e) => e.classification === c).length;
  const highRiskToolsCount = entries.filter((e) => e.riskLevel === "HIGH").length;

  return {
    totalTools: entries.length,
    writeToolsCount: count("write"),
    readToolsCount: count("read"),
    ambiguousToolsCount: count("ambiguous"),
    writeToolsWithoutIdempotencyKey,
    writeToolsWithoutLookupTool,
    highRiskToolsCount,
    tools: entries,
    summaryDe:
      summarize(
        entries.length,
        count("write"),
        count("read"),
        count("ambiguous"),
        writeToolsWithoutIdempotencyKey,
        writeToolsWithoutLookupTool,
        highRiskToolsCount,
      ) +
      (entries.some((e) => e.classificationNoteDe)
        ? ` ${entries.filter((e) => e.classificationNoteDe).length} ${entries.filter((e) => e.classificationNoteDe).length === 1 ? "Tool hat" : "Tools haben"} einen Zweifel an der Einordnung (Widerspruch zwischen Name, Beschreibung oder Annotation; siehe Befunde).`
        : ""),
  };
}
