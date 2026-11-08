import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8765",
    channel: "chrome",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "uv run python -m tests.serve_app",
    cwd: "..",
    url: "http://127.0.0.1:8765/api/settings",
    reuseExistingServer: false,
  },
});
