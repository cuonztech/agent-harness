// Test-Schlüssel-Override für die Lizenzprüfung. NUR in einem Source-Checkout erreichbar: Dieser Ordner (tests/)
// gehört nicht zum veröffentlichten npm-Paket, und die Lizenzprüfung (src/license/ed25519.ts) sucht die Datei nur
// relativ zum eigenen Ort. Im installierten Paket gilt immer der eingebettete öffentliche Schlüssel; eine
// Umgebungsvariable allein ändert daran nichts mehr (bis 0.11.0 reichte AGENT_AUDIT_LICENSE_PUBLIC_KEY zusammen
// mit dem mitgelieferten signLicense(), um sich selbst einen Pro-Code zu signieren).
//
// Die Tests signieren mit einem frisch erzeugten Schlüsselpaar und übergeben den öffentlichen Teil über
// AGENT_AUDIT_LICENSE_PUBLIC_KEY (siehe tests/setup/pro-license.ts). In CI wird der Override zusätzlich nur mit
// AGENT_AUDIT_ALLOW_TEST_KEY=1 angenommen.
"use strict";

function isOn(value) {
  return value !== undefined && value !== "" && !/^(0|false|no)$/i.test(value);
}

let warned = false;

module.exports = function testPublicKey(env) {
  const override = env.AGENT_AUDIT_LICENSE_PUBLIC_KEY;
  if (!override) return null;
  if ((isOn(env.CI) || isOn(env.GITHUB_ACTIONS)) && env.AGENT_AUDIT_ALLOW_TEST_KEY !== "1") {
    if (!warned) {
      warned = true;
      console.warn("Lizenz-Schlüssel-Override wird in CI ignoriert (eingebetteter Schlüssel gilt).");
    }
    return null;
  }
  return override;
};
