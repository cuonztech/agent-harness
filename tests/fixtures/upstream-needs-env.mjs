#!/usr/bin/env node
// Upstream, der ohne Umgebungsvariable nicht startet (wie ein Server, der einen API-Schluessel
// aus der Umgebung braucht). Danach der Fixture-Upstream.
if (process.env.HARNESS_NEEDS_ENV !== "1") {
  process.stderr.write("HARNESS_NEEDS_ENV fehlt: der Server braucht diese Umgebungsvariable.\n");
  process.exit(2);
}
await import("./upstream-fixture-server.mjs");
