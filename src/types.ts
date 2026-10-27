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
  // SHA-256 über die kanonische JSON-Fassung von harnessVersion, report, schema_audit und call_forensics.
  payloadSha256: string;
  // Kopf der Hash-Kette über call_forensics.entries; null ohne Einträge.
  callChainHeadSha256: string | null;
  callChainLength: number;
}
