// Stdio transport for the proxy that looks at the RAW line of every
// tools/call before it is parsed. Two things cannot be forwarded unchanged
// once the MCP SDK has parsed a request, and neither can be noticed afterwards:
//   - an integer beyond 2^53 is rounded by JSON.parse,
//   - an argument key "__proto__" is dropped by the SDK's schema parsing.
// Forwarding the altered call would execute a DIFFERENT write at the upstream
// and let two distinct operations look identical (false FAIL). The proxy
// therefore refuses such a call with a clear error; the agent can pass the
// value as a string. The call never reaches the upstream and is not scored.
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

const MAX_BUFFER = 10 * 1024 * 1024;

// Reasons why a raw JSON text cannot pass through a parse/serialize round trip.
export function findUnforwardable(json: string): string[] {
  const reasons = new Set<string>();
  const n = json.length;
  let i = 0;
  while (i < n) {
    const c = json[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && json[j] !== '"') j += json[j] === "\\" ? 2 : 1;
      let k = j + 1;
      while (k < n && /\s/.test(json[k]!)) k++;
      if (json[k] === ":") {
        let key: unknown;
        try {
          key = JSON.parse(json.slice(i, j + 1));
        } catch {
          key = undefined;
        }
        if (key === "__proto__") reasons.add('an argument named "__proto__"');
      }
      i = j + 1;
    } else if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) {
      let j = i + 1;
      while (j < n && /[0-9.eE+-]/.test(json[j]!)) j++;
      const token = json.slice(i, j);
      if (/^-?\d+$/.test(token)) {
        const value = Number(token);
        let exact = Number.isFinite(value);
        if (exact) {
          try {
            exact = BigInt(value) === BigInt(token);
          } catch {
            exact = false;
          }
        }
        if (!exact) reasons.add("an integer beyond 2^53 (9007199254740992)");
      }
      i = j;
    } else {
      i++;
    }
  }
  return [...reasons];
}

export class GuardedStdioServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private buffer: Buffer | undefined;
  private started = false;

  constructor(
    private readonly stdin: NodeJS.ReadableStream = process.stdin,
    private readonly stdout: NodeJS.WritableStream = process.stdout,
    private readonly notify: (line: string) => void = () => undefined,
  ) {}

  private readonly ondata = (chunk: Buffer): void => {
    try {
      const size = (this.buffer?.length ?? 0) + chunk.length;
      if (size > MAX_BUFFER) {
        this.buffer = undefined;
        throw new Error(`stdin message exceeded maximum size of ${MAX_BUFFER} bytes`);
      }
      this.buffer = this.buffer ? Buffer.concat([this.buffer, chunk]) : chunk;
      this.drain();
    } catch (error) {
      this.onerror?.(error as Error);
      void this.close();
    }
  };

  private readonly onstdinerror = (error: Error): void => {
    this.onerror?.(error);
  };

  async start(): Promise<void> {
    if (this.started) throw new Error("GuardedStdioServerTransport already started!");
    this.started = true;
    this.stdin.on("data", this.ondata);
    this.stdin.on("error", this.onstdinerror);
  }

  private drain(): void {
    for (;;) {
      if (!this.buffer) return;
      const index = this.buffer.indexOf("\n");
      if (index === -1) return;
      const line = this.buffer.toString("utf8", 0, index).replace(/\r$/, "");
      this.buffer = this.buffer.subarray(index + 1);
      try {
        const parsed = JSON.parse(line) as { id?: unknown; method?: unknown };
        if (parsed && parsed.method === "tools/call" && (typeof parsed.id === "string" || typeof parsed.id === "number")) {
          const reasons = findUnforwardable(line);
          if (reasons.length > 0) {
            this.notify(
              `Refused a tools/call (id ${String(parsed.id)}): it contains ${reasons.join(" and ")}, which cannot be forwarded unchanged.`,
            );
            void this.send({
              jsonrpc: "2.0",
              id: parsed.id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text:
                      `The test harness did not forward this call: it contains ${reasons.join(" and ")}. ` +
                      "JSON processing would have changed the value, so a different operation than the one you meant would have been executed. " +
                      "Send such values as strings and call again.",
                  },
                ],
              },
            });
            continue;
          }
        }
        this.onmessage?.(JSONRPCMessageSchema.parse(parsed));
      } catch (error) {
        this.onerror?.(error as Error);
      }
    }
  }

  async close(): Promise<void> {
    this.stdin.off("data", this.ondata);
    this.stdin.off("error", this.onstdinerror);
    if (this.stdin.listenerCount("data") === 0) this.stdin.pause();
    this.buffer = undefined;
    this.onclose?.();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.stdout.write(JSON.stringify(message) + "\n")) resolve();
      else this.stdout.once("drain", resolve);
    });
  }
}
