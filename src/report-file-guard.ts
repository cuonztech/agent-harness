// The proxy writes its report to --report-file at startup and after every call,
// replacing whatever is there. A mistyped path must not turn into the loss of
// an unrelated file (the upstream's own script, a config, a spreadsheet): an
// existing file is only replaced if it is empty or an earlier harness report.
import { readFileSync, statSync } from "node:fs";

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
