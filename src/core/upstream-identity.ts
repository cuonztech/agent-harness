// Welcher Upstream wurde geprüft? Nur der Dateiname des Programms und des Skripts (keine Pfade, keine Argumente mit
// Geheimnissen) und der SHA-256 der Tool-Liste. Gemeinsam genutzt vom Proxy-Report (`--report-file`) und vom Bench-Bericht.
import { basename } from "node:path";
import { canonicalJson, sha256Hex } from "./artifact-integrity.js";

export interface UpstreamIdentity {
  program: string;
  script: string | null;
  toolCount: number;
}

const INLINE_FLAGS = new Set(["-e", "--eval", "-p", "--print", "-c", "--command"]);
const SCRIPT_FILE = /^[\w@.+-]+\.(?:mjs|cjs|js|ts|mts|py|jar|exe|dll|sh|ps1|rb|go|php|cmd|bat)$/i;
const PACKAGE_RUNNERS = /^(?:npx|bunx|uvx|pipx|pnpx)(?:\.cmd|\.exe)?$/i;
const PACKAGE_NAME = /^@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?$/i;

/**
 * Der Name des Skripts, wenn eines erkennbar ist: das erste Argument ohne führendes «-» mit einer Skript-Endung (nur der
 * Dateiname), oder bei npx und ähnlichen der Paketname. Bei Inline-Code (`node -e "..."`) und wenn das erste Argument wie
 * ein Wert aussieht (kein Dateiname), steht null: Argumente können Geheimnisse tragen.
 */
export function scriptNameOf(program: string, args: string[]): string | null {
  if (args.some((a) => INLINE_FLAGS.has(a))) return null;
  const first = args.find((a) => !a.startsWith("-"));
  if (first === undefined) return null;
  const name = basename(first);
  if (name.length > 80) return null;
  if (SCRIPT_FILE.test(name)) return name;
  if (PACKAGE_RUNNERS.test(basename(program)) && PACKAGE_NAME.test(first) && first.length <= 80) return first;
  return null;
}

export interface ToolDefLike {
  name: string;
  description?: string | undefined;
  inputSchema?: unknown;
}

/** SHA-256 der Tool-Liste (nach Name sortiert: Name, Beschreibung, Schema), wie sie der Upstream meldet. */
export function toolListSha256(tools: ToolDefLike[]): string {
  const sorted = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null }));
  return sha256Hex(canonicalJson(sorted));
}

export function upstreamIdentity(command: string, args: string[], tools: ToolDefLike[]): { upstream: UpstreamIdentity; toolsSha256: string } {
  return { upstream: { program: basename(command), script: scriptNameOf(command, args), toolCount: tools.length }, toolsSha256: toolListSha256(tools) };
}
