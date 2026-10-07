import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  // tsconfig keeps JSX for Next; the tests that render a component need it compiled.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // The app's mode is read when lib/api/mode loads, and the flows that judge expiry
    // load it. Tests run on the mock, as `next dev` does; one that needs another mode
    // mocks lib/api/mode or stubs the variable itself.
    env: { NEXT_PUBLIC_API_MODE: "mock" },
  },
})
