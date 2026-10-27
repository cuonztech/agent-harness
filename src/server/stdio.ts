import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { GuardedStdioServerTransport } from "../proxy/guarded-stdio.js";

interface Connectable {
  connect(transport: Transport): Promise<void>;
}

// With `guard`, calls that cannot be forwarded unchanged (see
// proxy/guarded-stdio.ts) are refused; `guard` receives a log line for each.
export async function startStdio(
  server: Connectable,
  guard?: { log: (line: string) => void },
): Promise<void> {
  const transport = guard
    ? new GuardedStdioServerTransport(process.stdin, process.stdout, guard.log)
    : new StdioServerTransport();
  await server.connect(transport);
}
