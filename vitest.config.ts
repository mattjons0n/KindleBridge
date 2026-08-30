import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    environment: "node",
    include: ["tests/{client,kindle,mtp,usb,server,integration,deployment}/**/*.test.ts"],
    setupFiles: ["./tests/client/setup.ts"],
    restoreMocks: true,
    clearMocks: true,
    environmentOptions: {
      jsdom: {
        url: "http://127.0.0.1:5173/",
      },
    },
  },
});
