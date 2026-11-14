// 0.12.0, Stufe E3d (Pro-Gate, Befund B6): Der Befehl `claude mcp add …` der Oberfläche setzte Argumente in doppelte Anführungszeichen,
// ohne `$()`, Backtick und `%` zu schützen. Jetzt werden Argumente wörtlich zitiert (einfache Anführungszeichen); was sich nicht
// sicher zitieren lässt, wird mit klarer Meldung abgelehnt. Geprüft wird mit echten Shells (Bash, PowerShell), soweit vorhanden.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { quoteShellArg, ShellQuoteError } from "../src/ui/shell-quote.js";

function have(command: string, args: string[]): boolean {
  try {
    return spawnSync(command, args, { encoding: "utf8", timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
}
const HAVE_BASH = have("bash", ["-c", "true"]);
// PowerShell 7.3 und neuer reicht doppelte Anführungszeichen aus einfachen Anführungszeichen wörtlich an Programme weiter.
const HAVE_PWSH = have("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "if ($PSVersionTable.PSVersion -ge [version]'7.3') { exit 0 } else { exit 1 }"]);

// Alles, was eine Shell auflösen oder ausführen könnte. Die Dateien PWN* dürfen nie entstehen.
const EVIL_COMMON = [
  "$(touch PWN1)",
  "`touch PWN2`",
  "$HOME",
  "${IFS}x",
  "a;touch PWN3",
  "a&touch PWN4",
  "a|touch PWN5",
  "a<b>PWN6",
  ">PWN7",
  "a b",
  "~",
  "*",
  "!!",
  "--flag=$(touch PWN8)",
  "C:\\Users\\Mein Name\\server.mjs",
  "ein-Umlaut-ä-ö-ü",
  "-n",
  "",
  "$(echo pwned)",
  "`id`",
  "x#y",
  "a\\b",
  "(subshell)",
  "{a,b}",
  "a=b",
];
// Nur wo einfache Anführungszeichen, doppelte und Prozentzeichen zitierbar sind (POSIX).
const EVIL_POSIX_ONLY = ["it's", "'; touch PWN9; '", "%PATH%", "a'b'c", "'", "%", "%COMSPEC% /c calc"];
// Doppelte Anführungszeichen (auch als JSON bei --effect-probe-args) sind in Bash, Git Bash und PowerShell 7.3+ in einfachen wörtlich.
const EVIL_DOUBLE_QUOTES = ['say "hi"', '"', '"; touch PWN10; "', '{"status":"open"}', '$(touch PWN11)"'];

async function receiver(): Promise<{ dir: string; script: string }> {
  const dir = await mkdtemp(join(tmpdir(), "shellquote-"));
  const script = join(dir, "recv.mjs");
  await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));", "utf8");
  return { dir, script };
}

describe("E3d: quoteShellArg, Ablehnung", () => {
  it("ein Zeilenumbruch oder ein Steuerzeichen wird überall abgelehnt, mit klarer Meldung", () => {
    for (const platform of ["posix", "windows"] as const) {
      for (const arg of ["a\nb", "a\r\nb", "a\u0000b", "a\u001bb", "a\u2028b", "x\ny; touch PWN"]) {
        expect(() => quoteShellArg(arg, platform), JSON.stringify(arg)).toThrow(ShellQuoteError);
      }
    }
    try {
      quoteShellArg("line1\nline2", "posix");
    } catch (err) {
      expect((err as Error).message).toContain("Zeilenumbruch");
      expect((err as Error).message).not.toContain("\n");
    }
  });
  it("unter Windows werden ' und % abgelehnt (nicht für PowerShell, Git Bash und cmd.exe zugleich sicher zitierbar), \" bleibt erlaubt (JSON)", () => {
    expect(quoteShellArg('{"status":"open"}', "windows")).toBe(`'{"status":"open"}'`);
    for (const arg of ["it's", "%PATH%", "a%b"]) {
      expect(() => quoteShellArg(arg, "windows"), arg).toThrow(/Windows/);
    }
  });
  it("unter POSIX sind diese Zeichen zitierbar", () => {
    expect(quoteShellArg("it's", "posix")).toBe("'it'\\''s'");
    expect(quoteShellArg("%PATH%", "posix")).toBe("'%PATH%'");
    expect(quoteShellArg('a"b', "posix")).toBe("'a\"b'");
  });
  it("sichere Argumente bleiben unverändert lesbar, alles andere wird zitiert (auch Backslash und Tilde)", () => {
    expect(quoteShellArg("--scenario", "posix")).toBe("--scenario");
    expect(quoteShellArg("mutate_*,crash_now", "posix")).toBe("'mutate_*,crash_now'");
    expect(quoteShellArg("TESTSYSTEM_DATA=/tmp/x.json", "posix")).toBe("TESTSYSTEM_DATA=/tmp/x.json");
    expect(quoteShellArg("C:\\a\\b.mjs", "windows")).toBe("'C:\\a\\b.mjs'");
    expect(quoteShellArg("", "posix")).toBe("''");
    expect(quoteShellArg("~", "posix")).toBe("'~'");
  });
});

describe.skipIf(!HAVE_BASH)("E3d: Bash führt nichts aus und liest jedes Argument wörtlich", () => {
  it("bösartige Argumente kommen unverändert beim Programm an, und es entsteht keine Datei", async () => {
    const { dir, script } = await receiver();
    const args = [...EVIL_COMMON, ...EVIL_POSIX_ONLY, ...EVIL_DOUBLE_QUOTES];
    const line = `node ${JSON.stringify(script.replace(/\\/g, "/"))} ${args.map((a) => quoteShellArg(a, "posix")).join(" ")}`;
    const r = spawnSync("bash", ["-c", line], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith("PWN"))).toEqual([]);
    expect(files.sort()).toEqual(["recv.mjs"]);
  }, 40_000);
});

describe.skipIf(!HAVE_PWSH)("E3d: PowerShell führt nichts aus und liest jedes Argument wörtlich", () => {
  it("bösartige Argumente kommen unverändert beim Programm an, und es entsteht keine Datei", async () => {
    const { dir, script } = await receiver();
    const args = [...EVIL_COMMON.filter((a) => a !== ""), ...EVIL_DOUBLE_QUOTES];
    const line = `& node '${script.replace(/'/g, "''")}' ${args.map((a) => quoteShellArg(a, "windows")).join(" ")}`;
    const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", line], { cwd: dir, encoding: "utf8", timeout: 40_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(args);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith("PWN"))).toEqual([]);
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------------------------
// Oberfläche: /api/config mit bösartigen Eingaben
// ------------------------------------------------------------------------------------------------------------------

let child: ChildProcess;
let base: string;
let token: string;
let workDir: string;
const BUNDLED = join(process.cwd(), "examples", "testsystem", "server.mjs");

function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  return fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-harness-token": token, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
}

describe("E3d: /api/config", () => {
  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ui-quote-"));
    child = spawn(process.execPath, ["dist/index.js", "ui", "--no-open"], { env: { ...process.env, CUONZTECH_HARNESS_DIR: workDir } });
    const line = await new Promise<string>((ok, fail) => {
      let out = "";
      child.stdout!.on("data", (d) => {
        out += d.toString();
        const m = out.match(/Oberfläche: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/);
        if (m) ok(m[1]!);
      });
      child.on("exit", () => fail(new Error("ui exited early: " + out)));
      setTimeout(() => fail(new Error("ui did not start: " + out)), 15_000);
    });
    const url = new URL(line);
    base = url.origin;
    token = url.searchParams.get("t")!;
  }, 30_000);
  afterAll(() => {
    child?.kill();
  });

  it("Argumente mit $(), Backtick, %, Semikolon, & | < > stehen im Befehl wörtlich in einfachen Anführungszeichen", async () => {
    const posixSafe = process.platform === "win32" ? ["$(echo pwned)", "`id`", "a;b", "a&b", "a|b", "a<b>c", "$HOME", 'say "hi"', '{"status":"open"}'] : ["$(echo pwned)", "`id`", "%PATH%", "a;b", "a&b", "a|b", "a<b>c", "$HOME", 'say "hi"', '{"status":"open"}'];
    const { status, json } = await api("/api/config", { command: "node", args: [BUNDLED, ...posixSafe], confirmedTestsystem: true });
    expect(status).toBe(200);
    for (const arg of posixSafe) {
      expect(json.claudeCode, arg).toContain(`'${arg}'`);
      // nie in doppelten Anführungszeichen (dort löst Bash $() und Backtick auf)
      expect(json.claudeCode, arg).not.toContain(`"${arg}"`);
    }
    // Die JSON-Fassung für Claude Desktop trägt die Argumente unverändert (kein Shell-Weg).
    const desktop = JSON.parse(json.claudeDesktop) as { mcpServers: Record<string, { args: string[] }> };
    for (const arg of posixSafe) expect(desktop.mcpServers["agent-harness"]!.args).toContain(arg);
  });

  it("Programm und Tool-Listen werden ebenso zitiert", async () => {
    const { status, json } = await api("/api/config", { command: "node", args: [BUNDLED], writeTools: "a;b,$(x)", readTools: "`y`", confirmedTestsystem: true });
    expect(status).toBe(200);
    expect(json.claudeCode).toContain("'a;b,$(x)'");
    expect(json.claudeCode).toContain("'`y`'");
  });

  it("ein Zeilenumbruch im Argument wird mit klarer Meldung abgelehnt, und es entsteht keine Sitzung und kein Ordner", async () => {
    const before = await readdir(workDir);
    const { status, json } = await api("/api/config", { command: "node", args: [BUNDLED, "a\nrm -rf x"], confirmedTestsystem: true });
    expect(status).toBe(400);
    expect(json.error).toContain("Der Befehl für Claude Code wurde nicht erzeugt");
    expect(json.error).toContain("Zeilenumbruch");
    expect(json.claudeCode).toBeUndefined();
    expect(await readdir(workDir)).toEqual(before);
  });

  it.skipIf(process.platform !== "win32")("unter Windows werden ' und % abgelehnt", async () => {
    for (const arg of ["it's", "%PATH%"]) {
      const { status, json } = await api("/api/config", { command: "node", args: [BUNDLED, arg], confirmedTestsystem: true });
      expect(status, arg).toBe(400);
      expect(json.error).toContain("Windows");
    }
  });

  it("der erzeugte Befehl ist in Bash ausführbar und liefert die Argumente wörtlich (Probe ohne Claude)", async () => {
    if (!HAVE_BASH) return;
    const { dir, script } = await receiver();
    const evil = ["$(touch PWN1)", "`touch PWN2`", "a;touch PWN3"];
    const { json } = await api("/api/config", { command: "node", args: [BUNDLED, ...evil], confirmedTestsystem: true });
    // Den Befehl ab `--` nehmen und das Programm durch den Empfänger ersetzen: nur die Argumente prüfen.
    const tail: string = json.claudeCode.slice(json.claudeCode.indexOf(" -- ") + 4);
    const idx = tail.indexOf("--upstream-arg");
    const rest = tail.slice(idx);
    const r = spawnSync("bash", ["-c", `node ${JSON.stringify(script.replace(/\\/g, "/"))} ${rest}`], { cwd: dir, encoding: "utf8", timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const got = JSON.parse(r.stdout) as string[];
    for (const e of evil) expect(got).toContain(e);
    expect(existsSync(join(dir, "PWN1"))).toBe(false);
    expect(existsSync(join(dir, "PWN2"))).toBe(false);
    expect(existsSync(join(dir, "PWN3"))).toBe(false);
  }, 40_000);
});
