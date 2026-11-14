// Gemeinsame Hilfen der Befehlszeile für report, campaign und ui (proxy hat einen eigenen, strengen Parser).

// Lizenzcodes (CAUDIT-..., CPCG-...) dürfen nie in Meldungen, Befehlen oder Konfigurationen auftauchen.
// Gezeigt werden höchstens die ersten 8 Zeichen.
const LICENSE_CODE = /\b(?:CAUDIT|CPCG)-[A-Za-z0-9_\-.=+/]{2,}/g;
const LICENSE_MARKER = /\b(?:CAUDIT|CPCG)-/;

/** Höchstens die ersten 8 Zeichen eines Lizenzcodes, der Rest als Auslassung. */
export function maskLicenseKey(key: string): string {
  const compact = key.replace(/\s+/g, "");
  return compact.length <= 8 ? `${compact}…` : `${compact.slice(0, 8)}…`;
}

/** Ersetzt jeden Lizenzcode in einem Text durch seine ersten 8 Zeichen und «…». */
export function redactSecrets(text: string): string {
  return text.replace(LICENSE_CODE, (code) => maskLicenseKey(code));
}

/**
 * Ein einzelnes Argument der Befehlszeile für eine Meldung: Enthält es einen Lizenzcode (auch mit Zeilenumbruch
 * oder Leerzeichen darin), wird alles ab dem Präfix durch die ersten 8 Zeichen und «…» ersetzt.
 */
export function redactArgument(token: string): string {
  const at = token.search(LICENSE_MARKER);
  return at === -1 ? token : `${token.slice(0, at)}${maskLicenseKey(token.slice(at))}`;
}

/**
 * `--flag=wert` wird zu `--flag wert`, für die angegebenen Optionen mit Wert. Der Wert ist alles nach dem ersten `=`.
 * Andere Token bleiben unverändert (eine unbekannte Option meldet der Parser selbst, ohne den Wert zu nennen).
 */
export function expandEqualsForm(argv: string[], valueOptions: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const token of argv) {
    const eq = token.startsWith("--") ? token.indexOf("=") : -1;
    if (eq > 2 && valueOptions.has(token.slice(0, eq))) out.push(token.slice(0, eq), token.slice(eq + 1));
    else out.push(token);
  }
  return out;
}

/** Ein Argument für «unbekannte Option» / «unerwartetes Argument»: ein angehängter Wert und jeder Lizenzcode bleiben draussen. */
export function optionName(token: string): string {
  const eq = token.startsWith("--") ? token.indexOf("=") : -1;
  return eq > 2 ? `${token.slice(0, eq)}=<Wert>` : redactArgument(token);
}
