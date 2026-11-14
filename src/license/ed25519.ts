import crypto from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LICENSE_PUBLIC_KEY } from "./publicKey.js";

export type SignDomain = "caudit-license-v1" | "caudit-grant-v1" | "cpcg-license-v1" | "cpcg-grant-v1";

const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function rawKey(b64: string, what: string): Buffer {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new Error(`${what}: erwartet 32 Byte (base64), erhalten ${raw.length}`);
  return raw;
}

export function generateLicenseKeyPair(): { seed: string; publicKey: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    seed: privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("base64"),
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
  };
}

export function signEd25519(domain: SignDomain, payload: string, seedB64: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, rawKey(seedB64, "LICENSE_SIGNING_SEED")]),
    format: "der",
    type: "pkcs8",
  });
  return crypto.sign(null, Buffer.from(`${domain}.${payload}`), key).toString("base64url");
}

// Test-Schlüssel-Override: nur in einem Source-Checkout. Die Datei liegt in tests/support/ und gehört nicht zum
// veröffentlichten Paket (siehe "files" in package.json); im installierten Paket gibt es sie nicht, und eine
// Umgebungsvariable allein (AGENT_AUDIT_LICENSE_PUBLIC_KEY) ändert den Schlüssel nicht mehr. Bis 0.11.0 konnte sich
// jeder mit dieser Variable und dem mitgelieferten signLicense() einen Pro-Code selbst signieren.
function testKeyOverride(env: NodeJS.ProcessEnv): string | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url)); // dist/license oder src/license
    const candidate = join(here, "..", "..", "tests", "support", "license-test-key.cjs");
    if (!existsSync(candidate)) return null;
    const hook = createRequire(import.meta.url)(candidate) as (e: NodeJS.ProcessEnv) => string | null;
    return typeof hook === "function" ? hook(env) : null;
  } catch {
    return null;
  }
}

export function defaultPublicKey(env: NodeJS.ProcessEnv = process.env): string {
  return testKeyOverride(env) ?? LICENSE_PUBLIC_KEY;
}

export function verifyEd25519(
  domain: SignDomain,
  payload: string,
  sigB64url: string,
  publicKeyB64: string = defaultPublicKey(),
): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, rawKey(publicKeyB64, "Public Key")]),
      format: "der",
      type: "spki",
    });
    const sig = Buffer.from(sigB64url, "base64url");
    return crypto.verify(null, Buffer.from(`${domain}.${payload}`), key, sig);
  } catch {
    return false;
  }
}
