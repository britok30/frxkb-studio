import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    globals: false,
    include: ["**/*.{test,spec}.ts"],
    exclude: ["**/node_modules/**", "**/.next/**"],
    clearMocks: true,
    restoreMocks: true,
  },
});
