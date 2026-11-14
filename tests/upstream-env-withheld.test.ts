import { describe, expect, it } from "vitest";
import { upstreamBaseEnv } from "../src/proxy/interceptor.js";

describe("Lizenzvariablen gehen nicht an den Upstream (Befund B3b)", () => {
  it("entfernt alle Lizenzvariablen, behält die übrige Umgebung", () => {
    const env = upstreamBaseEnv({
      PATH: "/bin",
      HOME: "/home/x",
      AGENT_AUDIT_LICENSE: "CAUDIT-geheim",
      CUONZTECH_LICENSE_KEY: "CAUDIT-geheim",
      CPCG_LICENSE_KEY: "CAUDIT-geheim",
      AGENT_AUDIT_LICENSE_PUBLIC_KEY: "x",
      AGENT_AUDIT_ALLOW_TEST_KEY: "1",
      MY_API_TOKEN: "abc",
    });
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/x", MY_API_TOKEN: "abc" });
    expect(JSON.stringify(env)).not.toContain("CAUDIT");
  });
});
