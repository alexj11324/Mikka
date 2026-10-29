import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: process.env.MIKKA_SANDBOX_ACCEPTANCE === "1"
      ? ["test/sandbox-runtime.acceptance.ts", "test/run-sandbox-launcher.test.ts", "test/codex-official-synthetic.acceptance.ts", "test/claude-official-synthetic.acceptance.ts"]
      : ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    env: { MIKKA_TEST_MODE: "1" },
    // Parallel files all create git worktrees; 20s is tight on a small machine.
    testTimeout: 45_000,
  },
})
