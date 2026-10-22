import "./spec/helpers/vscodeStub.js";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./src/ui",
  testMatch: /.*\.playwright\.ts$/,
  timeout: 30000,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  use: {
    headless: true,
    browserName: "chromium",
  },
  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
