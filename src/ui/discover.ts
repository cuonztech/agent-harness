// Read-only discovery of MCP servers the user has already configured on this
// machine, so step 3 of the UI does not make them hunt for file paths.
// Privacy: only name, command and args are ever taken from a config file.
// "env", "headers" and every other field are never read or returned.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface DiscoveredServer {
  name: string;
  source: string;
  command: string;
  args: string[];
}

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_SERVERS = 50;
const SELF_NAMES = new Set(["agent-harness", "cuonztech-agent-harness"]);

function desktopConfigPath(): string {
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
}

function candidateFiles(): Array<{ source: string; path: string }> {
  const files = [
    { source: "Claude Desktop", path: desktopConfigPath() },
    { source: "Cursor", path: join(homedir(), ".cursor", "mcp.json") },
    { source: "Cursor (Projekt)", path: resolve(".cursor", "mcp.json") },
    { source: "Claude Code (Projekt)", path: resolve(".mcp.json") },
  ];
  const custom = process.env.CUONZTECH_MCP_CONFIG_PATH;
  if (custom && custom.trim() !== "") files.push({ source: "Eigene Konfiguration", path: custom.trim() });
  return files;
}

function pointsAtHarness(name: string, command: string, args: string[]): boolean {
  if (SELF_NAMES.has(name.toLowerCase())) return true;
  return [command, ...args].some((part) => part.toLowerCase().includes("cuonztech-agent-harness"));
}

export function discoverMcpServers(): DiscoveredServer[] {
  const found: DiscoveredServer[] = [];
  const seen = new Set<string>();
  for (const { source, path } of candidateFiles()) {
    try {
      if (statSync(path).size > MAX_CONFIG_BYTES) continue;
      const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
      const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
      for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
        if (!entry || typeof entry !== "object") continue;
        const { command, args } = entry as { command?: unknown; args?: unknown };
        if (typeof command !== "string" || command.trim() === "") continue;
        const argList = Array.isArray(args) ? args.filter((a): a is string => typeof a === "string") : [];
        if (pointsAtHarness(name, command, argList)) continue;
        const key = JSON.stringify([name, command, argList]);
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ name, source, command, args: argList });
        if (found.length >= MAX_SERVERS) return found;
      }
    } catch {
      // Missing or unreadable file: not an error for discovery.
    }
  }
  return found;
}
