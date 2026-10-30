import crypto from "node:crypto";
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

function isCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  const on = (v: string | undefined): boolean => v !== undefined && v !== "" && !/^(0|false|no)$/i.test(v);
  return on(env.CI) || on(env.GITHUB_ACTIONS);
}

let warnedKeyOverride = false;

export function defaultPublicKey(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.AGENT_AUDIT_LICENSE_PUBLIC_KEY;
  if (!override) return LICENSE_PUBLIC_KEY;
  if (isCiEnvironment(env) && env.AGENT_AUDIT_ALLOW_TEST_KEY !== "1") {
    if (!warnedKeyOverride) {
      warnedKeyOverride = true;
      console.warn("⚠ Lizenz-Schlüssel-Override wird in CI ignoriert (eingebetteter Schlüssel gilt).");
    }
    return LICENSE_PUBLIC_KEY;
  }
  return override;
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
