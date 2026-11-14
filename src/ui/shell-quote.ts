// Zitierung für den Befehl `claude mcp add …`, den die Oberfläche zum Einfügen in ein Terminal ausgibt (E3d, Befund B6).
// Die Argumente kommen aus der Oberfläche und können aus fremden `.mcp.json`- oder Claude-Desktop-Konfigurationen stammen; sie
// dürfen in keiner Shell ausgeführt werden. Darum werden sie wörtlich zitiert: in einfache Anführungszeichen, in denen weder Bash
// noch PowerShell etwas auflöst (kein `$(…)`, kein Backtick, kein `%`, kein `;`, `&`, `|`, `<`, `>`).
//
// - POSIX (Bash, zsh, sh): `'…'`; ein einfaches Anführungszeichen im Argument wird zu `'\''`.
// - Windows: Der Befehl ist für PowerShell oder Git Bash gedacht. Dort verhalten sich einfache Anführungszeichen gleich, ein
//   eingebettetes `'` aber verschieden (`''` in PowerShell, `'\''` in Bash), und `%` wird von `cmd.exe` auch in Anführungszeichen
//   aufgelöst. Wo das nicht sicher geht, wird das Argument abgelehnt, mit klarer Meldung. Ein doppeltes Anführungszeichen (JSON bei
//   --effect-probe-args) bleibt erlaubt: In einfachen Anführungszeichen ist es in Bash, Git Bash und PowerShell 7.3 und neuer wörtlich;
//   Windows PowerShell 5.1 verliert es beim Aufruf von Programmen (siehe README: PowerShell 7 oder Git Bash nutzen).
// - Zeilenumbruch und andere Steuerzeichen werden überall abgelehnt (ein eingefügter Befehl liefe zeilenweise).
export class ShellQuoteError extends Error {}

export type QuotePlatform = "posix" | "windows";

const SAFE = /^[A-Za-z0-9_@+=:,./-]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function shown(arg: string): string {
  const text = arg.length > 60 ? `${arg.slice(0, 60)}…` : arg;
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
}

export function quoteShellArg(arg: string, platform: QuotePlatform = process.platform === "win32" ? "windows" : "posix"): string {
  if (CONTROL.test(arg)) {
    throw new ShellQuoteError(
      `Das Argument «${shown(arg)}» enthält einen Zeilenumbruch oder ein Steuerzeichen und lässt sich nicht sicher in einen Terminal-Befehl setzen. Bitte entfernen (oder die Konfiguration als JSON für Claude Desktop übernehmen).`,
    );
  }
  if (platform === "windows") {
    const bad = arg.match(/['%]/);
    if (bad) {
      throw new ShellQuoteError(
        `Das Argument «${shown(arg)}» enthält das Zeichen ${bad[0]}, das sich unter Windows nicht für PowerShell, Git Bash und cmd.exe zugleich sicher zitieren lässt. Bitte entfernen (oder die Konfiguration als JSON für Claude Desktop übernehmen).`,
      );
    }
  }
  if (SAFE.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
