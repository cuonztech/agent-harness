// Gemeinsame Typen für das Schnittstellen-Gutachten (src/schema-audit.ts).

// Was das Gutachten von einem Tool aus `tools/list` braucht. Ein Teil des
// MCP-SDK-Typs `Tool`; jedes Tool aus `listTools()` passt hinein.
export interface ToolInput {
  name: string;
  description?: string;
  inputSchema?: {
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: Record<string, unknown>;
}

export type SchemaToolClassification = "write" | "read" | "ambiguous";
export type SchemaRiskLevel = "HIGH" | "MEDIUM" | "LOW";

export interface ToolSchemaAuditEntry {
  name: string;
  classification: SchemaToolClassification;
  hasIdempotencyKey: boolean;
  idempotencyFieldName: string | null;
  hasMcpAnnotations: boolean;
  // Lese-/Such-Tools, mit denen sich nach einem Timeout prüfen lässt, ob der
  // Schreibvorgang schon ausgeführt wurde. Leer bei Lese-Tools.
  matchingReadTools: string[];
  // Mindestens eines davon braucht keine ID als Pflichtfeld. Nach einem Timeout
  // kennt der Agent die vom Server vergebene ID noch nicht.
  canVerifyWithoutId: boolean;
  riskLevel: SchemaRiskLevel;
  findingsDe: string[];
  // Kopierfertige Schema-Definition für das Feld `idempotency_key`
  // (unter `inputSchema.properties.idempotency_key` einzutragen).
  recommendedSchemaPatch: Record<string, unknown> | null;
}

export interface SchemaAuditReport {
  totalTools: number;
  writeToolsCount: number;
  readToolsCount: number;
  ambiguousToolsCount: number;
  writeToolsWithoutIdempotencyKey: string[];
  writeToolsWithoutLookupTool: string[];
  highRiskToolsCount: number;
  tools: ToolSchemaAuditEntry[];
  summaryDe: string;
}
