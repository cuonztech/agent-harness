// Die bestehende Suite läuft als Kunde MIT gültiger Pro-Lizenz: Sie prüft die vollen Funktionen
// (Dossier, Oberfläche, Kampagne, Textbausteine, Schema-Befunde). Das gesperrte Verhalten ohne Lizenz
// prüft tests/license-gate.test.ts und baut seine Umgebung selbst.
//
// Die Test-Lizenz wird mit einem frisch erzeugten Schlüsselpaar signiert und über den Test-Schlüssel-Override
// geprüft (AGENT_AUDIT_LICENSE_PUBLIC_KEY, in CI zusätzlich AGENT_AUDIT_ALLOW_TEST_KEY=1). Der Signierschlüssel
// des Lizenzdienstes kommt nirgends vor. Kindprozesse erben diese Umgebung.
import { generateLicenseKeyPair, signLicense } from "../../src/license/index.js";

const { seed, publicKey } = generateLicenseKeyPair();

process.env.AGENT_AUDIT_LICENSE_PUBLIC_KEY = publicKey;
process.env.AGENT_AUDIT_ALLOW_TEST_KEY = "1";
process.env.AGENT_AUDIT_LICENSE = signLicense(
  { sub: "H-0123456789ab", tier: "pro", exp: Math.floor(Date.now() / 1000) + 24 * 3600 },
  seed,
);
