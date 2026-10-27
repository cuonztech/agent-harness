// Aufrufe, die nicht unverändert weitergegeben werden können (Ganzzahl über
// 2^53, Argument "__proto__"), werden abgelehnt statt still verfälscht
// ausgeführt. Einheit (Rohzeilen-Prüfung) und echter Proxy-Prozess.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { findUnforwardable } from "../src/proxy/guarded-stdio.js";

describe("findUnforwardable", () => {
  it.each([
    ['{"a":9007199254740993}', 1],
    ['{"a":-9007199254740993}', 1],
    ['{"a":123456789012345678901234567890}', 1],
    ['{"a":{"b":[1,9007199254740993]}}', 1],
    ['{"__proto__":{"x":1}}', 1],
    ['{"a":{"\u005f_proto__":1}}', 1],
    ['{"a":9007199254740993,"__proto__":1}', 2],
  ])("flags %s (%i reason(s))", (json, count) => {
    expect(findUnforwardable(json)).toHaveLength(count);
  });

  it.each([
    '{"a":9007199254740992}',
    '{"a":-9007199254740991}',
    '{"a":1.5,"b":1e3,"c":0.1}',
    '{"a":"9007199254740993"}',
    '{"text":"__proto__ and 9007199254740993 inside a string"}',
    '{"a":"x \\" 9007199254740993 \\" y"}',
    '{"a":{"proto":1,"b":[1,2,3]}}',
  ])("lets %s pass", (json) => {
    expect(findUnforwardable(json)).toEqual([]);
  });
});

function rpc(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

// Talks to the real proxy in raw lines, so the exact text of a call is under
// the test's control (an MCP client would already have serialized it).
async function session(lines: string[]): Promise<Array<Record<string, any>>> {
  const child = spawn(
    process.execPath,
    ["dist/index.js", "proxy", "--upstream-command", process.execPath, "--upstream-arg", "tests/fixtures/upstream-fixture-server.mjs"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const answers: Array<Record<string, any>> = [];
  let out = "";
  child.stdout.on("data", (d) => {
    out += d.toString();
    let i: number;
    while ((i = out.indexOf("\n")) !== -1) {
      const line = out.slice(0, i);
      out = out.slice(i + 1);
      if (line.trim()) answers.push(JSON.parse(line));
    }
  });
  const waitFor = async (id: number): Promise<void> => {
    for (let n = 0; n < 200 && !answers.some((a) => a.id === id); n++) await new Promise((r) => setTimeout(r, 50));
    if (!answers.some((a) => a.id === id)) throw new Error(`no answer for id ${id}`);
  };
  try {
    child.stdin.write(rpc(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } }) + "\n");
    await waitFor(1);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    let id = 10;
    for (const line of lines) {
      const numbered = line.replace("__ID__", String(id));
      child.stdin.write(numbered + "\n");
      await waitFor(id);
      id++;
    }
  } finally {
    child.kill();
  }
  return answers;
}

const call = (args: string): string =>
  `{"jsonrpc":"2.0","id":__ID__,"method":"tools/call","params":{"name":"create_booking","arguments":${args}}}`;
const ledger = `{"jsonrpc":"2.0","id":__ID__,"method":"tools/call","params":{"name":"get_ledger","arguments":{}}}`;

describe("proxy refuses calls it cannot forward unchanged", () => {
  it("answers a call with a huge integer with a clear error and does not execute it", async () => {
    const answers = await session([call('{"guest":"A","room":9007199254740993}'), ledger]);
    const refused = answers.find((a) => a.id === 10)!;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("2^53");
    expect(refused.result.content[0].text).toContain("strings");
    const ledgerText = answers.find((a) => a.id === 11)!.result.content[0].text as string;
    expect(ledgerText).not.toContain("9007199254740");
    expect(ledgerText).not.toContain('"A"');
  }, 30_000);

  it("refuses an argument named __proto__ the same way", async () => {
    const answers = await session([call('{"guest":"A","__proto__":{"room":1}}')]);
    const refused = answers.find((a) => a.id === 10)!;
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0].text).toContain("__proto__");
  }, 30_000);

  it("lets the same values through as strings, and ordinary calls", async () => {
    const answers = await session([call('{"guest":"B","room":"9007199254740993"}'), call('{"guest":"C","room":12}')]);
    expect(answers.find((a) => a.id === 10)!.result.isError).not.toBe(true);
    expect(answers.find((a) => a.id === 11)!.result.isError).not.toBe(true);
  }, 30_000);
});
