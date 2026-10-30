import { verifyEd25519, signEd25519, defaultPublicKey, type SignDomain } from "./ed25519.js";
import type { LicenseClaims, LicenseVerdict } from "./types.js";

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export function signLicense(
  claims: LicenseClaims,
  seed: string,
  domain: SignDomain = "caudit-license-v1",
): string {
  // Der Harness gibt nur Codes mit Präfix CAUDIT- aus; `domain` dient den Tests, um falsch signierte Codes zu bauen.
  const payload = b64url(JSON.stringify(claims));
  const sig = signEd25519(domain, payload, seed);
  return `CAUDIT-${payload}.${sig}`;
}

export function verifyLicense(
  token: string | undefined | null,
  publicKey: string = defaultPublicKey(),
): LicenseVerdict {
  if (!token || typeof token !== "string" || token.trim() === "") {
    return {
      valid: false,
      reason: "Kein Lizenzschlüssel angegeben. Lizenzen erhältlich unter https://cuonztech.ch/agent-audit",
    };
  }

  const clean = token.trim();
  // Nur CAUDIT-Codes mit ihrer eigenen Signaturdomäne. Schlüssel anderer Produkte (zum Beispiel CPCG-)
  // berechtigen nicht zum Pro-Umfang und werden hier nicht akzeptiert.
  const prefix = "CAUDIT-";
  const domain: SignDomain = "caudit-license-v1";

  if (!clean.startsWith(prefix)) {
    const hint = clean.startsWith("CPCG-")
      ? "Ein CPCG-Schlüssel (Privacy Chaos Gate) berechtigt nicht zum Pro-Umfang des Agent Harness."
      : "Ungültiges Lizenzformat. Ein Lizenzschlüssel für den Agent Harness beginnt mit 'CAUDIT-'.";
    return { valid: false, reason: hint };
  }

  const body = clean.slice(prefix.length);
  const dot = body.lastIndexOf(".");
  if (dot <= 0) {
    return { valid: false, reason: "Lizenzsignatur fehlt oder ist beschädigt." };
  }

  const payload = body.slice(0, dot);
  const sig = body.slice(dot + 1);

  let claims: LicenseClaims;
  try {
    const json = Buffer.from(payload, "base64url").toString("utf-8");
    claims = JSON.parse(json) as LicenseClaims;
  } catch {
    return { valid: false, reason: "Lizenzdaten konnten nicht decodiert werden." };
  }

  // Signature verification (Ed25519)
  const isSigValid = verifyEd25519(domain, payload, sig, publicKey);

  if (!isSigValid) {
    return { valid: false, reason: "Kryptografische Signatur der Lizenz ist ungültig." };
  }

  if (!claims || typeof claims !== "object") {
    return { valid: false, reason: "Lizenzdaten konnten nicht decodiert werden." };
  }

  // Ablauf (Unix-Sekunden): `exp` ist zwingend. Ein Code ohne Ablaufdatum ist ungültig.
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return {
      valid: false,
      reason: "Lizenz ist ungültig: Ablaufdatum fehlt.",
    };
  }
  if (claims.exp < nowSec) {
    const expiredDate = new Date(claims.exp * 1000).toISOString().slice(0, 10);
    return {
      valid: false,
      claims,
      tier: claims.tier,
      reason: `Lizenz ist am ${expiredDate} abgelaufen. Verlängerung unter https://cuonztech.ch/agent-audit`,
    };
  }

  return {
    valid: true,
    claims,
    tier: claims.tier || "pro",
  };
}

export function resolveLicense(explicitKey?: string): LicenseVerdict {
  const token =
    explicitKey ||
    process.env.AGENT_AUDIT_LICENSE ||
    process.env.CUONZTECH_LICENSE_KEY;

  if (token) {
    return verifyLicense(token);
  }

  return {
    valid: false,
    reason: "Nicht lizenziert",
  };
}

export const PURCHASE_HINT =
  "CuonzTech Agent Audit Pro (Prüf-Dossier, geführte Oberfläche, Schema-Gutachten, Härtungsvorschläge, Kampagnen-Runner)" + "\n" +
  "Lizenz: https://cuonztech.ch/agent-harness.html#audit" + "\n" +
  "Aktivierung: --license <KEY> oder Umgebungsvariable AGENT_AUDIT_LICENSE=<KEY>";
