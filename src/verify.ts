// `verify <dossier|report>`: rechnet die Prüfsumme einer Report-Datei oder eines Dossiers neu und meldet
// OK oder MISMATCH mit dem Grund. Exit-Code 0 nur bei OK, sonst 1. Es bleibt eine Prüfsumme ohne Signatur
// eines Dritten: Wer Datei und Prüfsumme zusammen ändert, kann fälschen; der Wert schützt nur, wenn er
// getrennt von der Datei aufbewahrt wird (dafür gibt es `--expect <sha256>`).
import { readFile, stat } from "node:fs/promises";
import { DOSSIER_SEAL_MARKER, canonicalJson, checkReportIntegrity, extractDossierSeal, sha256Hex, type IntegrityCheck } from "./core/artifact-integrity.js";
import { dossierHeaderChecks } from "./dossier-report.js";
import type { ReportFile } from "./plain-report.js";

const MAX_BYTES = 64 * 1024 * 1024;

function countOf(text: string, part: string): number {
  if (part === "") return 0;
  let n = 0;
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n++;
  return n;
}

const USAGE = "Usage: verify <dossier|report-file> [--report <report-file>] [--expect <sha256>]\n";

const HELP =
  `${USAGE}\n` +
  "Rechnet die Prüfsumme einer Report-Datei (--report-file des Proxys) oder eines Dossiers (report --dossier) neu\n" +
  "und gibt OK oder MISMATCH mit dem Grund aus. Exit-Code 0 bei OK, sonst 1.\n" +
  "  --report <file>   bei einem Dossier zusätzlich die Report-Datei prüfen, aus der es erzeugt wurde, und beide abgleichen\n" +
  "  --expect <sha256> die getrennt aufbewahrte Prüfsumme (Report-Datei: payloadSha256; Dossier: Prüfsumme des Dossiers);\n" +
  "                    stimmt sie nicht mit der Datei überein, ist das ein MISMATCH\n\n" +
  "Es ist eine Prüfsumme ohne Signatur eines Dritten und kein Zertifikat. Wer Datei und Prüfsumme zusammen ändert, kann\n" +
  "fälschen. Sie schützt nur, wenn der Wert getrennt von der Datei aufbewahrt wird.\n";

export type VerifyStatus = "OK" | "MISMATCH" | "NOT_VERIFIABLE";

export interface VerifyResult {
  status: VerifyStatus;
  kind: "report" | "dossier" | "unknown";
  // Die Prüfsumme, die die Datei trägt (Report: payloadSha256, Dossier: Prüfsumme des Kerns).
  sha256: string | null;
  lines: string[];
}

function statusOfCheck(check: IntegrityCheck): VerifyStatus {
  if (check.status === "ok") return "OK";
  return check.status === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE";
}

export function verifyReportFileContent(file: ReportFile, expect?: string): VerifyResult {
  const check = checkReportIntegrity(file);
  const lines: string[] = [check.reasonDe];
  let status = statusOfCheck(check);
  const sha = file.integrity?.payloadSha256 ?? null;
  if (status === "OK" && expect !== undefined && expect.toLowerCase() !== sha) {
    status = "MISMATCH";
    lines.unshift(`Die Datei stimmt zwar mit ihrer eigenen Prüfsumme überein, die Prüfsumme ist aber nicht die erwartete: erwartet ${expect.toLowerCase()}, in der Datei ${sha ?? "—"}. Datei und Prüfsumme wurden gemeinsam ausgetauscht oder die falsche Datei liegt vor.`);
  }
  return { status, kind: "report", sha256: sha, lines };
}

export function verifyDossierContent(text: string, options: { report?: ReportFile; expect?: string } = {}): VerifyResult {
  const extracted = extractDossierSeal(text);
  if ("error" in extracted) {
    return {
      status: "NOT_VERIFIABLE",
      kind: "dossier",
      sha256: null,
      lines: [
        extracted.error === "missing"
          ? "Kein Prüfsummen-Siegel gefunden: Das Dossier stammt aus Harness < 0.11.1 (Siegel erst ab 0.11.1) oder das Siegel wurde entfernt. Nicht prüfbar."
          : "Das Prüfsummen-Siegel am Ende des Dossiers ist beschädigt und lässt sich nicht lesen. Nicht prüfbar.",
      ],
    };
  }
  const { seal } = extracted;
  const recomputed = sha256Hex(canonicalJson(seal.core));
  const lines: string[] = [];
  if (recomputed !== seal.sha256) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: ["Die Prüfsumme des Dossiers stimmt nicht zu seinem eingebetteten Kern: Kern (Urteil, Score, Namen, Lizenzstatus ...) oder Prüfsumme wurden nach dem Erzeugen verändert."],
    };
  }
  // Der sichtbare Kopf muss dem gesiegelten Kern entsprechen.
  const header = seal.core.header as unknown;
  if (!header || typeof header !== "object" || !Array.isArray((header as { rows?: unknown }).rows) || !Array.isArray((header as { notes?: unknown }).notes)) {
    return { status: "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines: ["Das Siegel enthält den sichtbaren Kopf nicht (Dossier aus einer Vorabfassung von 0.11.1). Nicht prüfbar."] };
  }
  const isHtml = /<html[\s>]/i.test(text.slice(0, 2000));
  const expected = dossierHeaderChecks(seal.core)[isHtml ? "html" : "md"];
  // Gezählt wird im sichtbaren Teil vor dem Siegel (das JSON des Siegels wiederholt Teile des Kopfes).
  const sealAt = text.lastIndexOf(`<!-- ${DOSSIER_SEAL_MARKER} `);
  const visible = sealAt === -1 ? text : text.slice(0, sealAt);
  const missing = expected.filter((check) => countOf(visible, check.needle) !== 1 || (check.prefix !== undefined && countOf(visible, check.prefix) !== 1));
  if (missing.length > 0) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: [
        `Der sichtbare Kopf des Dossiers weicht vom gesiegelten Kern ab (${missing.length} von ${expected.length} Angaben fehlen, sind verändert oder doppelt: Kopfzeilen, Datum, Version, Urteil, Score oder die Hinweise unter dem Urteil wurden im Text verändert).`,
      ],
    };
  }
  if (options.expect !== undefined && options.expect.toLowerCase() !== seal.sha256) {
    return {
      status: "MISMATCH",
      kind: "dossier",
      sha256: seal.sha256,
      lines: [`Das Dossier ist in sich stimmig, seine Prüfsumme ist aber nicht die erwartete: erwartet ${options.expect.toLowerCase()}, im Dossier ${seal.sha256}.`],
    };
  }
  const source = seal.core.reportFile;
  if (source.check !== "ok") {
    lines.push(
      source.check === "mismatch"
        ? "Das Dossier ist unverändert, wurde aber aus einer Report-Datei erzeugt, die ihre eigene Prüfsumme nicht bestand: Urteil und Score sind nicht belastbar."
        : "Das Dossier ist unverändert, wurde aber aus einer Report-Datei erzeugt, deren Prüfsumme nicht prüfbar war (fehlend oder aus Harness < 0.11.1): Das Urteil war schon beim Erzeugen ungeprüft.",
    );
    return { status: source.check === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines };
  }
  lines.push("Siegel, Kern und sichtbarer Kopf (Titelzeile, alle Kopfzeilen, Urteil, Score und die Hinweise unter dem Urteil) stimmen überein. Der Fliesstext der Abschnitte 1 bis 6 ist nicht gesiegelt und wurde nicht geprüft.");
  if (options.report) {
    const reportCheck = checkReportIntegrity(options.report);
    if (reportCheck.status !== "ok") {
      return { status: reportCheck.status === "mismatch" ? "MISMATCH" : "NOT_VERIFIABLE", kind: "dossier", sha256: seal.sha256, lines: [`Die angegebene Report-Datei besteht ihre Prüfung nicht: ${reportCheck.reasonDe}`] };
    }
    if (options.report.integrity?.payloadSha256 !== source.payloadSha256) {
      return {
        status: "MISMATCH",
        kind: "dossier",
        sha256: seal.sha256,
        lines: ["Die angegebene Report-Datei ist nicht die, aus der das Dossier erzeugt wurde (ihre Prüfsumme weicht von der im Dossier festgehaltenen ab)."],
      };
    }
    lines.push("Die angegebene Report-Datei gehört zu diesem Dossier und ist unverändert. Der Fliesstext des Dossiers wurde dabei nicht gegen die Report-Datei abgeglichen.");
  } else {
    lines.push("Die Report-Datei wurde nicht mitgeprüft; mit --report <datei> abgleichen.");
  }
  lines.push("Das ist eine Prüfsumme ohne Signatur eines Dritten: Sie schützt nur, wenn ihr Wert getrennt aufbewahrt wird (--expect <sha256>).");
  return { status: "OK", kind: "dossier", sha256: seal.sha256, lines };
}

async function readText(path: string): Promise<{ text: string } | { error: string }> {
  const info = await stat(path).catch(() => null);
  if (!info || !info.isFile()) return { error: `Datei nicht gefunden: ${path}` };
  if (info.size > MAX_BYTES) return { error: `Datei zu gross (${info.size} Byte, höchstens ${MAX_BYTES}): ${path}` };
  return { text: await readFile(path, "utf8") };
}

function looksLikeReportFile(value: unknown): value is ReportFile {
  return value !== null && typeof value === "object" && !Array.isArray(value) && ("harnessVersion" in value || "report" in value || "integrity" in value);
}

export async function runVerifyMode(argv: string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return 0;
  }
  let file: string | undefined;
  let reportPath: string | undefined;
  let expect: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq !== -1 ? token.slice(0, eq) : token;
    if (name === "--report" || name === "--expect") {
      const v = token.startsWith("--") && eq !== -1 ? token.slice(eq + 1) : argv[++i];
      if (v === undefined || v.trim() === "" || v.startsWith("--")) {
        process.stderr.write(`Error: ${name} needs a value.\n${USAGE}`);
        return 1;
      }
      if (name === "--report") reportPath = v;
      else {
        if (!/^[0-9a-fA-F]{64}$/.test(v.trim())) {
          process.stderr.write(`Error: --expect needs a SHA-256 (64 hex characters).\n${USAGE}`);
          return 1;
        }
        expect = v.trim();
      }
    } else if (token.startsWith("--")) {
      process.stderr.write(`Error: unknown option ${name}\n${USAGE}`);
      return 1;
    } else if (file === undefined) {
      file = token;
    } else {
      process.stderr.write(`Error: unexpected argument ${token}\n${USAGE}`);
      return 1;
    }
  }
  if (file === undefined) {
    process.stderr.write(`Error: verify needs a dossier or report file.\n${USAGE}`);
    return 1;
  }
  const read = await readText(file);
  if ("error" in read) {
    process.stderr.write(`Error: ${read.error}\n`);
    return 1;
  }
  let reportFile: ReportFile | undefined;
  if (reportPath !== undefined) {
    const r = await readText(reportPath);
    if ("error" in r) {
      process.stderr.write(`Error: ${r.error}\n`);
      return 1;
    }
    try {
      const parsed: unknown = JSON.parse(r.text);
      if (!looksLikeReportFile(parsed)) throw new Error("not a report");
      reportFile = parsed;
    } catch {
      process.stderr.write(`Error: ${reportPath} is not a report file written by the proxy (--report-file).\n`);
      return 1;
    }
  }

  let result: VerifyResult;
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    isJson = false;
  }
  if (isJson) {
    if (!looksLikeReportFile(parsed)) {
      process.stderr.write(`Error: ${file} is JSON, but not a report written by the proxy (--report-file).\n`);
      return 1;
    }
    if (reportFile !== undefined) {
      process.stderr.write("Error: --report only applies when verifying a dossier.\n");
      return 1;
    }
    result = verifyReportFileContent(parsed, expect);
  } else {
    result = verifyDossierContent(read.text, { report: reportFile, expect });
  }

  const label = result.status === "NOT_VERIFIABLE" ? "NICHT PRÜFBAR" : result.status;
  const what = result.kind === "report" ? "Report-Datei" : "Dossier";
  process.stdout.write(`${label}  ${what} ${file}\n`);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (result.sha256) process.stdout.write(`Prüfsumme (SHA-256): ${result.sha256}\n`);
  return result.status === "OK" ? 0 : 1;
}
