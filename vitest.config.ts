import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { provider: "v8", include: ["src/**"], exclude: ["src/cli.ts"] },
    projects: [
      { test: { name: "unit", include: ["tests/unit/**/*.test.ts"], environment: "node" } },
      { test: { name: "e2e", include: ["tests/e2e/**/*.test.ts"], environment: "node" } },
      {
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          testTimeout: 180_000,
          hookTimeout: 300_000,
        },
      },
    ],
  },
});
