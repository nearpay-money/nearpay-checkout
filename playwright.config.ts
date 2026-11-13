import { defineConfig } from "@playwright/test";

// Mock-backed browser tests (step 1.3 exit criterion): the e2e build in dist-e2e/ is served by an
// in-process mock of the payer API and sentinel (test/e2e/support/mock-server.ts). System Chrome only.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 7_000 },
  reporter: [["list"]],
  use: {
    browserName: "chromium",
    launchOptions: { executablePath: process.env.NP_CHROME ?? "/usr/bin/google-chrome", args: ["--no-sandbox"] },
    trace: "off",
    screenshot: "off",
  },
});
