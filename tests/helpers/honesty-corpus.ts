// Regressionskorpus des Ehrlichkeits-Checks aus dem Pro-Gate (E3a): 73 Sätze des blinden Prüfers gegen drei bekannte Wahrheiten
// (once, dup, none) und 80 echte Modellantworten aus bench-Läufen. Quellen stehen in den Fixtures unter tests/fixtures/ehrlichkeit-*.json.
import { readFileSync } from "node:fs";
import { createSession, incrementCall, addRecord, deleteSession, listSessions, type CallRecord, type SessionState } from "../../src/core/state-engine.js";
import { generateReport, type AuditReport } from "../../src/core/report-generator.js";
import { evaluateAgentClaim } from "../../src/core/claim-check.js";

export type Truth = "T" | "F" | "N" | "O";
export type State = "once" | "dup" | "none";
export interface CorpusSentence {
  text: string;
  truth: Record<State, Truth>;
}
export interface ModelAnswer {
  id: string;
  condition: "baseline" | "patch";
  created: number;
  dup: boolean;
  a1: string;
  a2: string;
}

const readJson = <T>(name: string): T => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")) as T;

export const SENTENCES: CorpusSentence[] = readJson<{ sentences: CorpusSentence[] }>("ehrlichkeit-saetze.json").sentences;
export const REPORTS: Record<State, AuditReport> = readJson<{ reports: Record<State, AuditReport> }>("ehrlichkeit-reports.json").reports;
export const MODEL_ANSWERS: ModelAnswer[] = readJson<{ answers: ModelAnswer[] }>("ehrlichkeit-modellantworten.json").answers;

const T0 = 1_700_000_000_000;
// Zwischenstand nach dem ersten Zug (Timeout nach dem Schreiben, kein Nachsehen, kein erneutes Schreiben): der Ausgang ist offen.
export function quietReport(): AuditReport {
  for (const s of listSessions()) deleteSession(s.sessionId);
  const session: SessionState = createSession();
  const callNumber = incrementCall(session.sessionId);
  const rec: CallRecord = {
    callNumber,
    toolName: "create_booking",
    args: { idempotency_key: "k1", amount: 100, date: "2026-01-01", guest: "Anna" },
    injectedError: "[TIMEOUT]",
    response: '{"error":"timeout"}',
    upstreamResponse: '{"id":"B-1","status":"confirmed"}',
    upstreamExecuted: true,
    timestamp: T0,
    receivedAt: T0,
  };
  addRecord(session.sessionId, rec);
  const report = generateReport(session);
  deleteSession(session.sessionId);
  return report;
}

export type Cell = "beschuldigt" | "ehrlich" | "unklar";
export const cellOf = (status: string): Cell => (status === "DISHONEST" ? "beschuldigt" : status === "HONEST" ? "ehrlich" : "unklar");

export interface Tally {
  // Kategorie (T wahr, N Vorbehalt/neutral, F falsch, O wahr aber unvollständig) → Zelle → Anzahl
  [category: string]: Record<Cell, number>;
}

export function tallyCorpus(): { tally: Tally; falseAccusations: string[]; hedgesAccused: string[]; liesHonest: string[]; liesCaught: number; liesTotal: number } {
  const tally: Tally = {};
  const falseAccusations: string[] = [];
  const hedgesAccused: string[] = [];
  const liesHonest: string[] = [];
  let liesCaught = 0;
  let liesTotal = 0;
  for (const s of SENTENCES) {
    for (const state of ["once", "dup", "none"] as State[]) {
      const truth = s.truth[state];
      const status = evaluateAgentClaim(s.text, REPORTS[state]).status;
      const cell = cellOf(status);
      (tally[truth] ??= { beschuldigt: 0, ehrlich: 0, unklar: 0 })[cell]++;
      if (truth === "T" && cell === "beschuldigt") falseAccusations.push(`[${state}] ${s.text}`);
      if (truth === "N" && cell === "beschuldigt") hedgesAccused.push(`[${state}] ${s.text}`);
      if (truth === "F") {
        liesTotal++;
        if (cell === "beschuldigt") liesCaught++;
        if (cell === "ehrlich") liesHonest.push(`[${state}] ${s.text}`);
      }
    }
  }
  return { tally, falseAccusations, hedgesAccused, liesHonest, liesCaught, liesTotal };
}
