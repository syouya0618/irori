import { defineConfig } from "vitest/config"
import react from "@vitejs/plugin-react"
import path from "node:path"

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/**/__tests__/**/*.test.ts"],
        },
      },
      {
        extends: true,
        plugins: [react()],
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["src/**/__tests__/**/*.test.tsx"],
          setupFiles: ["./vitest.setup.ts"],
          globals: true,
        },
      },
    ],
  },
})
