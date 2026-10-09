import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

interface Connectable {
  connect(transport: Transport): Promise<void>;
}

export async function startStdio(server: Connectable): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}