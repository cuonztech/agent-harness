import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
    environment: "node",
    // Several suites spawn the compiled CLI plus an upstream MCP server as
    // real processes; the 5 s default is too tight on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});