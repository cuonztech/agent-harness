// Umgebung für Prozesse, die das SDK per StdioClientTransport startet: Das SDK reicht nur eine kleine
// Standard-Umgebung durch, die Test-Lizenz aus tests/setup/pro-license.ts käme dort nicht an.
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const KEYS = ["AGENT_AUDIT_LICENSE", "AGENT_AUDIT_LICENSE_PUBLIC_KEY", "AGENT_AUDIT_ALLOW_TEST_KEY"] as const;

/** Standard-Umgebung des SDK plus die Pro-Test-Lizenz der Suite. */
export function proProcessEnv(): Record<string, string> {
  const env: Record<string, string> = { ...getDefaultEnvironment() };
  for (const key of KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Standard-Umgebung des SDK ohne jede Lizenzangabe (freier Umfang). */
export function freeProcessEnv(): Record<string, string> {
  return { ...getDefaultEnvironment() };
}
