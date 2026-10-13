import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // CI runners (3 Node versions in parallel, spawned dashboards) push CPU-heavy
    // cases past the 5 s default; a hang still fails at 15 s.
    testTimeout: 15_000,
    // Never let the suite write into the developer's real overdrive session
    // log; test/sessionlog.test.ts re-enables it against a temp dir.
    env: { OVERDRIVE_SESSION_LOG: "0", OVERDRIVE_FLAIR: "0" },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
    },
  },
});
