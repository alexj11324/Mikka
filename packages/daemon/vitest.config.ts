import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    environment: "node",
    // Parallel files all create git worktrees; 20s is tight on a small machine.
    testTimeout: 45_000,
  },
})
