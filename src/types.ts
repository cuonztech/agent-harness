// Gemeinsame Typen für das Schnittstellen-Gutachten (src/schema-audit.ts), die
// Call-by-Call-Forensik (src/core/call-forensics.ts), den Ehrlichkeits-Check
// (src/core/claim-check.ts) und den Integritäts-Nachweis (src/core/artifact-integrity.ts).
import type { CallRecord } from "./engine/state-machine.js";

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
  // Ab 0.12.0: false, wenn der Lauf ohne Lizenz aufgezeichnet wurde. Dann ist `findingsDe: []` «nicht berechnet», nicht «keine Befunde»
  // (und `recommendedSchemaPatch: null` «nicht berechnet»). Fehlt das Feld, gilt es als vorhanden (Berichte vor 0.12.0 und mit Lizenz).
  findingsAvailable?: boolean;
  findingsNoteDe?: string;
  // Seit 0.11.1: Zweifel an der Einordnung (Beschreibung widerspricht dem Namen, Annotation widerspricht dem Namen).
  // Das Tool erscheint dann auch im Detail des Gutachtens, wenn es als lesend gilt.
  classificationNoteDe?: string;
  // Kopierfertige Schema-Definition für das Feld `idempotency_key`
  // (unter `inputSchema.properties.idempotency_key` einzutragen).
  recommendedSchemaPatch: Record<string, unknown> | null;
  // Ab 0.12.0: Feldname des Vorschlags im Stil der Parameter des Tools (idempotency_key, idempotencyKey oder idempotency-key). Fehlt: idempotency_key.
  recommendedFieldName?: string;
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
  // Ab 0.12.0, wie bei den Tools: false ohne Lizenz (Befunde und Vorschläge nicht berechnet).
  findingsAvailable?: boolean;
  findingsNoteDe?: string;
}

// --- Call-by-Call-Forensik ---

export interface ArgumentDiffEntry {
  field: string;
  kind: "unchanged" | "changed" | "added" | "removed";
  // Bei "added" undefined.
  before?: unknown;
  // Bei "removed" undefined.
  after?: unknown;
}

export interface CallForensicEntry {
  callNumber: number;
  timestamp: number;
  // Millisekunden seit dem ersten Aufruf der Session (beim ersten Aufruf 0).
  offsetMs: number;
  toolName: string;
  toolClass: "write" | "read" | "unclassified";
  idempotencyKey: string | null;
  // Kopie der Argumente; lange Strings sind gekürzt.
  argsPreview: Record<string, unknown>;
  injectedError: string | null;
  upstreamExecuted: boolean;
  tookEffect: boolean;
  effectUnknown: boolean;
  outcome: CallRecord["outcome"];
  // Unmittelbar vorangegangener Aufruf desselben Schreib-Tools, sonst null.
  previousWriteCallNumber: number | null;
  argumentDiff: ArgumentDiffEntry[] | null;
  // Nur bei einer ausgeführten Wiederholung eines Schreib-Tools: Antwort des Zielsystems verglichen mit der
  // Antwort auf den vorangegangenen Aufruf. "identical" = gleicher Text (ohne Leerraum-Unterschiede),
  // "dedup-marker" = die Antwort nennt die Wiederholung (z. B. deduplicated, already exists).
  answerComparedToPrevious?: "identical" | "dedup-marker" | "different" | null;
  summaryDe: string;
}

export interface CallForensicReport {
  totalCalls: number;
  writeRetriesCount: number;
  // Wiederholungen, bei denen sich ein Feld ausserhalb der Schlüsselfelder geändert hat.
  mutationsOnRetryCount: number;
  // Wiederholungen, bei denen ein Schlüsselfeld geändert, hinzugefügt oder entfernt wurde.
  keyChangesOnRetryCount: number;
  entries: CallForensicEntry[];
}

// --- Ehrlichkeits-Check ---

export type ClaimCheckStatus = "NOT_PROVIDED" | "HONEST" | "DISHONEST" | "UNCLEAR";
export type ClaimIssueCode = "OVERCLAIMED_SUCCESS" | "FALSE_NEGATIVE_AFTER_GHOST_WRITE" | "UNREPORTED_DUPLICATE";

export interface ClaimCheckResult {
  status: ClaimCheckStatus;
  // null = nicht geprüft oder nicht entscheidbar.
  honest: boolean | null;
  issueCode?: ClaimIssueCode;
  // Was im Text des Agenten erkannt wurde (nur gesetzt, wenn ein Text vorlag).
  detected?: { claimsSuccess: boolean; claimsNotExecuted: boolean; mentionsUncertainty: boolean };
  summaryDe: string;
  findingsDe: string[];
}

// --- Integritäts-Nachweis ---

export interface ReportIntegrityProof {
  algorithm: "sha256";
  // Format 2 (ab 0.11.1): die ganze Datei ausser integrity und claim_check. Fehlt das Feld, ist es Format 1
  // (bis 0.11.0: nur report, schema_audit, call_forensics, Harness-Version) und nicht mehr prüfbar.
  formatVersion?: number;
  scope?: string;
  // SHA-256 über die kanonische JSON-Fassung der gedeckten Felder (siehe README, «Prüfsumme und verify»).
  payloadSha256: string;
  // SHA-256 je Feld oberster Ebene: damit `verify` bei einer Abweichung sagen kann, welches Feld sich geändert hat.
  fieldSha256?: Record<string, string>;
  // Kopf der Hash-Kette über call_forensics.entries; null ohne Einträge.
  callChainHeadSha256: string | null;
  callChainLength: number;
}
