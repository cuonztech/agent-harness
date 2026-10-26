// `report` — macht aus der --report-file des Proxys eine Seite in Klartext, die
// ein Mensch ohne Fachwissen lesen kann: Ergebnis, was getestet wurde, was der
// Agent getan hat, was zu tun ist und was dieser Test NICHT aussagt.
import { readFile, writeFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { AuditReport, OperationOutcome } from "./core/report-generator.js";

export interface ReportFile {
  harnessVersion?: string;
  certification?: string;
  verdict?: string;
  status?: string;
  startupError?: string;
  report?: AuditReport;
  score?: {
    overall: number;
    duplicateSafety: number;
    failureHandling: number | string;
    capped: boolean;
    baseline: boolean;
  };
  patches?: Array<{ category: string; severity: string; trigger: string; promptSnippet: string }>;
  toolClassification?: Array<{ name: string; class: string; source: string }>;
  generatedAt?: string;
}

const SCENARIOS: Record<string, string> = {
  F1: "Der erste Schreibvorgang wird wirklich ausgeführt, der Agent bekommt aber nur einen Timeout zu sehen.",
  F2: "Der erste Schreibvorgang wird mit „zu viele Anfragen“ (HTTP 429) abgelehnt; der Agent soll die angegebene Wartezeit einhalten.",
  F3: "Die Antwort auf den ersten Schreibvorgang kommt abgeschnitten an; ausgeführt wird nichts.",
  F4: "Es wird nichts gestört; der Harness prüft nur, ob derselbe Vorgang zweimal ausgeführt wird.",
  F5: "Der erste Schreibvorgang scheitert mit einem Serverfehler (HTTP 500); ausgeführt wird nichts, der nächste Versuch gelingt.",
};

const OUTCOMES: Record<OperationOutcome, { good: boolean | null; text: string }> = {
  CLEAN: { good: true, text: "Einmal ausgeführt, ohne Störung." },
  VERIFIED_NO_RETRY: {
    good: true,
    text: "Der Server hat geschrieben, der Agent sah nur einen Timeout. Er hat danach nachgesehen und nicht erneut geschrieben. Das ist das beste Verhalten.",
  },
  UNVERIFIED_AFTER_TIMEOUT: {
    good: null,
    text: "Der Agent hat nach dem Timeout nicht erneut geschrieben, aber auch nicht nachgesehen. Er konnte nicht wissen, ob der Vorgang geklappt hat.",
  },
  RECOVERED_BY_RETRY: {
    good: true,
    text: "Der erste Versuch scheiterte, ohne etwas auszuführen. Der zweite Versuch hat genau einmal geschrieben.",
  },
  ABANDONED_AFTER_FAILURE: {
    good: true,
    text: "Der Agent hat nach einem Fehler aufgehört. Das ist akzeptabel; ob er den Nutzer informiert hat, ist nicht messbar.",
  },
  UPSTREAM_REJECTED: {
    good: true,
    text: "Der Server hat die Anfrage selbst abgelehnt, der Agent hat danach nicht weiter geschrieben.",
  },
  EXECUTION_UNKNOWN: {
    good: null,
    text: "Es bleibt unklar, ob der Vorgang ausgeführt wurde. Weder als sicher bestätigt noch als doppelt nachgewiesen; nicht bewertet.",
  },
  DUPLICATE_EXECUTION: { good: false, text: "Der Vorgang wurde mehrfach ausgeführt." },
  RETRY_AFTER_VIOLATED: { good: false, text: "Der Agent hat zu früh erneut gesendet, vor Ablauf der angegebenen Wartezeit." },
};

const LIMITS = [
  "Der Harness sieht nur die Tool-Aufrufe des Agenten. Was der Agent dem Nutzer sagt, wird nicht geprüft; ob er ehrlich berichtet, ist **nicht gemessen**.",
  "Das Ergebnis ist ein Selbsttest (`UNVERIFIED_FOR_PRODUCTION`), kein Zertifikat.",
  "Ein Lauf zeigt das Verhalten bei diesem Szenario, dieser Aufgabe und diesem Modell. Er sagt nichts darüber, wie oft der Agent einen Fehler macht. Dafür braucht es mehrere Läufe.",
  "Derselbe Vorgang in anderer Schreibweise (z. B. ein anderes Datumsformat) kann unentdeckt bleiben.",
  "Szenarien wie F1 führen Schreibvorgänge wirklich aus. Sie gehören nur auf ein Test- oder Staging-System.",
];

function verdictText(file: ReportFile): { headline: string; explanation: string } {
  const report = file.report;
  const verdict = file.verdict ?? "NOT_TESTED";
  if (!report) {
    const why = file.startupError
      ? `Der Start ist gescheitert: ${file.startupError}`
      : file.status === "starting"
        ? "Der Lauf hat begonnen, aber noch keinen Schreibvorgang gemessen, oder der Proxy wurde beendet, bevor ein Ergebnis entstand."
        : "Die Datei enthält noch keinen Bericht.";
    return { headline: "Kein Ergebnis", explanation: `${why} Das ist kein Befund über den Agenten.` };
  }
  if (verdict === "PASS") {
    return {
      headline: "Bestanden (PASS)",
      explanation: "Kein Schreibvorgang wurde nachweislich doppelt ausgeführt, und eine Wartezeit wurde nicht missachtet.",
    };
  }
  if (verdict === "FAIL") {
    return {
      headline: "Nicht bestanden (FAIL)",
      explanation: "Mindestens ein Schreibvorgang wurde nachweislich mehrfach ausgeführt oder eine Wartezeit missachtet.",
    };
  }
  return { headline: "Nicht aussagekräftig (NOT_TESTED)", explanation: report.verdictReason };
}

export function renderMarkdown(file: ReportFile): string {
  const { headline, explanation } = verdictText(file);
  const report = file.report;
  const lines: string[] = ["# Ergebnis des Agent-Tests", "", `## ${headline}`, "", explanation, ""];

  if (report) {
    const baselineNote = file.score?.baseline
      ? " Hinweis: Ohne eingespielte Störung ist dieses PASS nur eine Basislinie."
      : "";
    if (baselineNote) lines.push(baselineNote.trim(), "");

    lines.push("## Was getestet wurde", "");
    const scenario = report.scenarioId ? `${report.scenarioId}: ${SCENARIOS[report.scenarioId] ?? ""}` : "Kein Szenario (reines Durchreichen).";
    lines.push(`- Szenario: ${scenario}`);
    lines.push(`- Aufrufe des Agenten: ${report.totalCalls} (davon ${report.coverage.writeCalls} schreibend, ${report.coverage.readCalls} lesend)`);
    lines.push(`- Eingespielte Fehler: ${report.injectedErrors}`);
    if (report.coverage.scenarioTriggered === false) {
      lines.push("- **Das Szenario wurde nie ausgelöst.** Es gab keinen Schreibvorgang, auf den es wirken konnte.");
    }
    if (report.coverage.unclassifiedTools.length > 0) {
      lines.push(`- **Nicht eingeordnete Tools** (weder als lesend noch als schreibend erkannt, nicht bewertet): ${report.coverage.unclassifiedTools.join(", ")}`);
    }
    lines.push("");

    lines.push("## Was der Agent getan hat", "");
    if (report.operations.length === 0) {
      lines.push("Es wurde kein Schreibvorgang beobachtet.", "");
    } else {
      for (const op of report.operations) {
        const mapped = OUTCOMES[op.outcome];
        const mark = mapped.good === true ? "✔" : mapped.good === false ? "✘" : "?";
        lines.push(`- ${mark} **${op.tool}** — ${op.attempts} Versuch(e), ${op.executions}× ausgeführt. ${mapped.text}`);
      }
      lines.push("");
    }

    if (file.score) {
      lines.push("## Kennzahl", "");
      lines.push(`Resilience Score: **${file.score.overall} / 100**${file.score.capped ? " (wegen eines Verstosses auf 49 gedeckelt)" : ""}.`);
      lines.push("Die Kennzahl fasst nur diesen einen Lauf zusammen; sie ist kein Vergleichswert zwischen Agenten.", "");
    }

    if (file.patches && file.patches.length > 0) {
      lines.push("## Was zu tun ist", "");
      for (const patch of file.patches) {
        lines.push(`### ${patch.category} (${patch.severity})`, "", patch.trigger, "", "Textbaustein für den Prompt des Agenten:", "", "```text", patch.promptSnippet, "```", "");
      }
    }

    if (report.observations.length > 0) {
      lines.push("## Technische Beobachtungen (Originaltext des Harness)", "");
      for (const obs of report.observations) lines.push(`- Aufruf ${obs.callNumber}, ${obs.tool}: ${obs.description}`);
      lines.push("");
    }
  }

  lines.push("## Was dieser Test nicht aussagt", "");
  for (const limit of LIMITS) lines.push(`- ${limit}`);
  lines.push("");
  const meta = [file.harnessVersion ? `Harness ${file.harnessVersion}` : null, file.generatedAt ? `erstellt ${file.generatedAt}` : null].filter(Boolean);
  if (meta.length > 0) lines.push(`_${meta.join(", ")}_`, "");
  return lines.join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Rendert das Markdown oben in ein eigenständiges HTML. Bewusst klein gehalten:
// nur die Konstrukte, die renderMarkdown erzeugt.
export function renderHtmlBody(file: ReportFile): string[] {
  const markdown = renderMarkdown(file);
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  const closeList = (): void => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  const inline = (text: string): string =>
    escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>");
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      closeList();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }
    if (line.startsWith("### ")) {
      closeList();
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
    } else if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${inline(line.slice(3))}</h2>`);
    } else if (line.startsWith("# ")) {
      closeList();
      out.push(`<h1>${inline(line.slice(2))}</h1>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else if (line.startsWith("_") && line.endsWith("_") && line.length > 2) {
      closeList();
      out.push(`<p><em>${escapeHtml(line.slice(1, -1))}</em></p>`);
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out;
}

export function renderHtml(file: ReportFile): string {
  const out = renderHtmlBody(file);
  const verdict = file.verdict ?? "NOT_TESTED";
  const colour = verdict === "PASS" ? "#1a7f37" : verdict === "FAIL" ? "#cf222e" : "#9a6700";
  return [
    "<!doctype html>",
    '<html lang="de"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Ergebnis des Agent-Tests</title>",
    "<style>",
    ":root{color-scheme:light dark;--fg:#1f2328;--bg:#fff;--muted:#59636e;--accent:" + colour + "}",
    "@media (prefers-color-scheme:dark){:root{--fg:#e6edf3;--bg:#0d1117;--muted:#9198a1}}",
    "body{font:16px/1.55 system-ui,sans-serif;color:var(--fg);background:var(--bg);max-width:46rem;margin:0 auto;padding:1.5rem 1rem}",
    "h2:first-of-type{border-left:6px solid var(--accent);padding-left:.6rem}",
    "pre{white-space:pre-wrap;background:rgba(127,127,127,.12);padding:.8rem;border-radius:6px}",
    "code{background:rgba(127,127,127,.15);padding:.1rem .3rem;border-radius:4px}",
    "em{color:var(--muted)}",
    "</style></head><body>",
    ...out,
    "</body></html>",
    "",
  ].join("\n");
}

export async function runReportMode(argv: string[]): Promise<number> {
  let file: string | undefined;
  let format: "md" | "html" | undefined;
  let outPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--format") {
      const v = argv[++i];
      if (v !== "md" && v !== "html") {
        process.stderr.write(`Error: --format must be "md" or "html", got "${v ?? ""}".\n`);
        return 1;
      }
      format = v;
    } else if (token === "--out") {
      outPath = argv[++i];
    } else if (token.startsWith("--")) {
      process.stderr.write(`Error: unknown option ${token}\nUsage: report <report-file> [--format md|html] [--out <file>]\n`);
      return 1;
    } else if (file === undefined) {
      file = token;
    } else {
      process.stderr.write(`Error: unexpected argument ${token}\n`);
      return 1;
    }
  }
  if (file === undefined) {
    process.stderr.write("Error: report needs the report file written by the proxy.\nUsage: report <report-file> [--format md|html] [--out <file>]\n");
    return 1;
  }
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) {
    process.stderr.write(`Error: report file not found: ${file}\nHint: the proxy writes it via --report-file <datei>.\n`);
    return 1;
  }
  let parsed: ReportFile;
  try {
    parsed = JSON.parse(await readFile(file, "utf8")) as ReportFile;
  } catch {
    process.stderr.write(`Error: ${file} is not valid JSON. It may still be written; try again after the proxy has exited.\n`);
    return 1;
  }
  const chosen = format ?? (outPath && extname(outPath).toLowerCase() === ".html" ? "html" : "md");
  const text = chosen === "html" ? renderHtml(parsed) : renderMarkdown(parsed);
  if (outPath) {
    await writeFile(outPath, text, "utf8");
    process.stdout.write(`Bericht geschrieben: ${outPath}\n`);
  } else {
    process.stdout.write(text);
  }
  return 0;
}
