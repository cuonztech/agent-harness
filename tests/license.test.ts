import { describe, it, expect } from "vitest";
import {
  generateLicenseKeyPair,
  signLicense,
  verifyLicense,
  resolveLicense,
  type LicenseClaims,
} from "../src/license/index.js";
import { startUi } from "../src/ui/server.js";

describe("CuonzTech Agent Audit — Ed25519 Lizenzsystem", () => {
  it("signiert und verifiziert eine gültige Pro-Lizenz", () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    const claims = {
      sub: "H-3f9a1c0b7d42",
      tier: "pro" as const,
      customer: "Muster AG",
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 Stunde gültig
    };

    const token = signLicense(claims, seed);
    expect(token.startsWith("CAUDIT-")).toBe(true);

    const verdict = verifyLicense(token, publicKey);
    expect(verdict.valid).toBe(true);
    expect(verdict.tier).toBe("pro");
    expect(verdict.claims?.sub).toBe("H-3f9a1c0b7d42");
    expect(verdict.claims?.customer).toBe("Muster AG");
  });

  it("erkennt abgelaufene Lizenzen", () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    const claims = {
      sub: "kunde@beispiel.de",
      tier: "single_audit" as const,
      exp: Math.floor(Date.now() / 1000) - 60, // vor 1 Minute abgelaufen
    };

    const token = signLicense(claims, seed);
    const verdict = verifyLicense(token, publicKey);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("abgelaufen");
  });

  it("lehnt manipulierte Signaturen oder Payloads ab", () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    const claims = {
      sub: "kunde@beispiel.de",
      tier: "pro" as const,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    const token = signLicense(claims, seed);
    // Verändere ein Zeichen im Payload
    const parts = token.split(".");
    const tampered = parts[0] + "X." + parts[1];

    const verdict = verifyLicense(tampered, publicKey);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("Signatur");
  });

  it("lehnt ungültige Präfixe und Tokens ohne Signatur ab", () => {
    expect(verifyLicense("INVALID-XYZ").valid).toBe(false);
    expect(verifyLicense("CAUDIT-ohne-punkt").valid).toBe(false);
    expect(verifyLicense("").valid).toBe(false);
  });

  it("lehnt CPCG-Schlüssel ab (berechtigen nicht zum Pro-Umfang)", () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    const claims = {
      sub: "H-3f9a1c0b7d42",
      tier: "pro" as const,
      exp: Math.floor(Date.now() / 1000) + 3600,
    };

    // Ein echter CPCG-Schlüssel: Präfix CPCG-, Signaturdomäne cpcg-license-v1.
    const caudit = signLicense(claims, seed, "cpcg-license-v1");
    const cpcg = `CPCG-${caudit.slice("CAUDIT-".length)}`;
    const verdict = verifyLicense(cpcg, publicKey);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("CPCG");

    // Auch mit umgeschriebenem Präfix gilt er nicht: die Signaturdomäne passt nicht zu CAUDIT-.
    const relabelled = verifyLicense(caudit, publicKey);
    expect(relabelled.valid).toBe(false);
    expect(relabelled.reason).toContain("Signatur");
  });

  it("verlangt exp: ein Code ohne Ablaufdatum ist ungültig", () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    const noExp = signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro" } as unknown as LicenseClaims, seed);
    const verdict = verifyLicense(noExp, publicKey);
    expect(verdict.valid).toBe(false);
    expect(verdict.reason).toContain("Ablaufdatum fehlt");

    const nonNumeric = signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro", exp: "9999999999" } as unknown as LicenseClaims, seed);
    expect(verifyLicense(nonNumeric, publicKey).valid).toBe(false);

    const expZero = signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro", exp: 0 }, seed);
    expect(verifyLicense(expZero, publicKey).valid).toBe(false);
  });

  it("akzeptiert die neue Form (sub H-<12 hex>, ohne eml) und die alte (E-Mail im sub)", () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const fresh = verifyLicense(signLicense({ sub: "H-3f9a1c0b7d42", tier: "pro", exp }, seed), publicKey);
    expect(fresh.valid).toBe(true);
    expect(fresh.claims?.sub).toMatch(/^H-[0-9a-f]{12}$/);
    expect(fresh.claims?.eml).toBeUndefined();
    const legacy = verifyLicense(
      signLicense({ sub: "kunde@beispiel.de", eml: "kunde@beispiel.de", tier: "pro", exp }, seed),
      publicKey,
    );
    expect(legacy.valid).toBe(true);
  });

  it("liest keine Umgebungsvariable von CPCG (CPCG_LICENSE_KEY wird ignoriert)", () => {
    const saved = {
      a: process.env.AGENT_AUDIT_LICENSE,
      b: process.env.CUONZTECH_LICENSE_KEY,
      c: process.env.CPCG_LICENSE_KEY,
    };
    try {
      delete process.env.AGENT_AUDIT_LICENSE;
      delete process.env.CUONZTECH_LICENSE_KEY;
      process.env.CPCG_LICENSE_KEY = "CPCG-irgendwas.sig";
      const verdict = resolveLicense();
      expect(verdict.valid).toBe(false);
      expect(verdict.reason).toBe("Nicht lizenziert");
    } finally {
      for (const [k, v] of [["AGENT_AUDIT_LICENSE", saved.a], ["CUONZTECH_LICENSE_KEY", saved.b], ["CPCG_LICENSE_KEY", saved.c]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("startUi bindet Lizenz in /api/info ein und validiert /api/license", async () => {
    const { seed, publicKey } = generateLicenseKeyPair();
    process.env.AGENT_AUDIT_LICENSE_PUBLIC_KEY = publicKey;

    const claims = {
      sub: "ui-tester@beispiel.de",
      tier: "agency" as const,
      exp: Math.floor(Date.now() / 1000) + 7200,
    };
    const token = signLicense(claims, seed);

    const ui = await startUi({ open: false, licenseKey: token });
    try {
      const url = new URL(ui.url);
      const tokenParam = url.searchParams.get("t");

      // GET /api/info
      const infoRes = await fetch(`${url.origin}/api/info?t=${tokenParam}`);
      expect(infoRes.status).toBe(200);
      const info = (await infoRes.json()) as { license: { valid: boolean; tier: string } };
      expect(info.license.valid).toBe(true);
      expect(info.license.tier).toBe("agency");

      // POST /api/license mit ungültigem Schlüssel
      const checkRes = await fetch(`${url.origin}/api/license?t=${tokenParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "CAUDIT-ungueltig.sig" }),
      });
      const checkResult = (await checkRes.json()) as { valid: boolean };
      expect(checkResult.valid).toBe(false);
    } finally {
      await ui.close();
      delete process.env.AGENT_AUDIT_LICENSE_PUBLIC_KEY;
    }
  });
});
