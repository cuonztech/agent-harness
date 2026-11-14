// Verständliche Meldungen für Dateisystemfehler (E3f, Befund C2): «Fatal: Error: ENOTDIR …» wird zu einem Satz mit Ursache und Ausweg.
// Gilt für Pfade, die der Nutzer angibt (--out, Berichtsdatei): Ein Teil des Pfads ist eine Datei, ein Ordner statt einer Datei, fehlt oder
// ist nicht beschreibbar. Nichts davon ist ein Programmfehler.
import { dirname, resolve } from "node:path";
import { statSync } from "node:fs";

export type FsLang = "de" | "en";

const SAYS: Record<string, { de: (p: string) => string; en: (p: string) => string }> = {
  ENOTDIR: {
    de: (p) => `Ein Teil des Pfads ist eine Datei, kein Ordner${p ? ` (${p})` : ""}. Wähle einen Ordner, der existiert oder angelegt werden kann.`,
    en: (p) => `A part of the path is a file, not a folder${p ? ` (${p})` : ""}. Choose a folder that exists or can be created.`,
  },
  EISDIR: {
    de: (p) => `${p || "Der Pfad"} ist ein Ordner, keine Datei. Gib einen Dateinamen an.`,
    en: (p) => `${p || "The path"} is a folder, not a file. Give a file name.`,
  },
  ENOENT: {
    de: (p) => `${p || "Der Pfad"} gibt es nicht (ein Ordner im Pfad fehlt).`,
    en: (p) => `${p || "The path"} does not exist (a folder in the path is missing).`,
  },
  EACCES: {
    de: (p) => `Kein Zugriff auf ${p || "den Pfad"}. Prüfe die Rechte oder wähle einen anderen Ort.`,
    en: (p) => `No permission for ${p || "the path"}. Check the rights or choose another place.`,
  },
  EPERM: {
    de: (p) => `Kein Zugriff auf ${p || "den Pfad"}. Prüfe die Rechte oder wähle einen anderen Ort.`,
    en: (p) => `No permission for ${p || "the path"}. Check the rights or choose another place.`,
  },
};

/** Der Satz zu einem bekannten Dateisystemfehler, sonst null (dann bleibt es bei der bisherigen Meldung). */
export function describeFsError(err: unknown, lang: FsLang = "en"): string | null {
  if (err === null || typeof err !== "object") return null;
  const code = (err as NodeJS.ErrnoException).code;
  if (typeof code !== "string" || !(code in SAYS)) return null;
  const rawPath = (err as NodeJS.ErrnoException).path;
  const path = typeof rawPath === "string" ? rawPath.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?") : "";
  return SAYS[code]![lang](path);
}

/** Liegt ein Teil des Pfads unter einer Datei (der erste vorhandene Vorfahre ist keine Ordner)? Dann der Pfad dieser Datei, sonst null. */
export function fileInPathAbove(target: string): string | null {
  let current = resolve(target);
  for (let i = 0; i < 64; i++) {
    let info;
    try {
      info = statSync(current, { throwIfNoEntry: false });
    } catch {
      return null;
    }
    if (info !== undefined) return info.isDirectory() ? null : current === resolve(target) ? null : current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}
