import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/ui",
  timeout: 90000,
  expect: { timeout: 12000 },
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:5173",
    ...devices["iPhone 13"],
    defaultBrowserType: "chromium",
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "node tests/support/backend.mjs",
      url: "http://127.0.0.1:8787/health",
      timeout: 30000,
      reuseExistingServer: false,
    },
    {
      command: "node tests/support/serve-app.mjs",
      url: "http://127.0.0.1:5173",
      timeout: 60000,
      reuseExistingServer: false,
      env: {
        VITE_SUPABASE_URL: "http://127.0.0.1:8787",
        VITE_SUPABASE_ANON_KEY: "test-public-anon-key",
      },
    },
  ],
});
