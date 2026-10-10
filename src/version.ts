// Single source of truth for the package version used in every MCP server
// identity string (stdio server, proxy gateway, proxy's own upstream client).
// Previously each spot hardcoded its own version literal and drifted out of
// sync with package.json (0.3.2) — server.ts said 0.3.0, interceptor.ts said
// 0.2.0. Read from package.json at runtime (not a static JSON import) so it
// works regardless of the Node version's import-attribute support.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

export const VERSION: string = pkg.version;
