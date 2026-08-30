import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/server/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: "forks",
    maxWorkers: 1,
  },
});
