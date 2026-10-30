// The proxy writes its report to --report-file at startup and after every call,
// replacing whatever is there. A mistyped path must not turn into the loss of
// an unrelated file (the upstream's own script, a config, a spreadsheet): an
// existing file is only replaced if it is empty or an earlier harness report.
import { existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const MAX_REPORT_BYTES = 8 * 1024 * 1024;

export function isReplaceableReportFile(path: string): boolean {
  try {
    const info = statSync(path, { throwIfNoEntry: false });
    if (!info || !info.isFile()) return true; // nothing there, or rejected by other checks
    if (info.size === 0) return true;
    if (info.size > MAX_REPORT_BYTES) return false;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as { harnessVersion?: unknown }).harnessVersion === "string"
    );
  } catch {
    return false;
  }
}

export function notReplaceableMessage(flag: string, path: string): string {
  return (
    `${flag} "${path}" already exists and is not an earlier harness report. ` +
    "Refusing to overwrite it. Choose another file name (for example harness-report.json), " +
    "or remove the file yourself if you really want it gone."
  );
}

// Windows device names: writing to "NUL" or "CON" as a relative path can
// create a real file of that name (or block on a device).
// Checked for every path segment ("C:\\NUL\\x.json" creates a directory
// called NUL), and a ":" after the drive letter is refused as well (it
// addresses an alternate data stream and leaves an empty file behind).
export function isReservedFileName(path: string): boolean {
  if (process.platform !== "win32") return false;
  // "\\?\C:\dir\file" is an ordinary long-path spelling.
  const withoutDrive = path.replace(/^\\\\\?\\/, "").replace(/^[a-zA-Z]:/, "");
  if (withoutDrive.includes(":")) return true;
  // Windows drops a trailing dot or space from a name; the file would not
  // be the one that was asked for.
  if (/[. ]$/.test(withoutDrive)) return true;
  return withoutDrive
    .split(/[\\/]+/)
    .some((segment) => /^(nul|con|prn|aux|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment));
}

export interface ArchiveCheckResult {
  shouldArchive: boolean;
  verdict?: string;
  callsCount: number;
}

export function inspectReportForArchive(parsed: unknown): ArchiveCheckResult {
  if (parsed === null || typeof parsed !== "object") {
    return { shouldArchive: false, callsCount: 0 };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.harnessVersion !== "string") {
    return { shouldArchive: false, callsCount: 0 };
  }
  // Startup placeholders or errors from earlier runs never get archived,
  // preventing runaway file proliferation on repeated reconnects.
  if (obj.status === "starting" || typeof obj.startupError === "string") {
    return { shouldArchive: false, callsCount: 0 };
  }
  const reportObj = obj.report as Record<string, unknown> | undefined;
  const calls = Array.isArray(reportObj?.calls) ? reportObj!.calls : [];
  const forensics = obj.call_forensics as Record<string, unknown> | undefined;
  const timeline = Array.isArray(forensics?.timeline) ? forensics!.timeline : [];
  const callsCount = Math.max(calls.length, timeline.length);

  const verdict = typeof obj.verdict === "string" ? obj.verdict : undefined;

  // We archive if there is at least one recorded call or an evaluated verdict (PASS / FAIL)
  const shouldArchive = callsCount > 0 || verdict === "PASS" || verdict === "FAIL";
  return {
    shouldArchive,
    verdict,
    callsCount,
  };
}

export function computeArchiveReportPath(filePath: string, now: Date = new Date()): string {
  const dir = dirname(filePath);
  const ext = extname(filePath);
  const name = basename(filePath, ext);
  // ISO timestamp with colon replaced by '-' for Windows filesystem compatibility:
  // e.g. 2026-10-30T17-25-00.123Z
  const safeTimestamp = now.toISOString().replace(/:/g, "-");
  let candidate = join(dir, `${name}.${safeTimestamp}${ext || ".json"}`);
  let counter = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${name}.${safeTimestamp}.${counter}${ext || ".json"}`);
    counter++;
  }
  return candidate;
}

export interface ArchivedReportInfo {
  archivedPath: string;
  verdict?: string;
  callsCount: number;
  archivedAt: string;
}

export function archivePreviousReportSync(filePath: string, now: Date = new Date()): ArchivedReportInfo | null {
  const info = statSync(filePath, { throwIfNoEntry: false });
  if (!info || !info.isFile()) return null;
  if (info.size === 0 || info.size > MAX_REPORT_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }

  const check = inspectReportForArchive(parsed);
  if (!check.shouldArchive) return null;

  const archivePath = computeArchiveReportPath(filePath, now);
  try {
    renameSync(filePath, archivePath);
  } catch (err) {
    throw new Error(
      `could not archive previous report file "${filePath}" to "${archivePath}": ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    archivedPath: archivePath,
    verdict: check.verdict,
    callsCount: check.callsCount,
    archivedAt: now.toISOString(),
  };
}

