import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Deliberately separate from the normal Chromium regression command. This
// checks actual Firefox/WebKit engines; WebKit is not a claim of Safari QA.
export default defineConfig({
  ...base,
  // Chromium uses --mute-audio. Other engines must not create a real chime;
  // the sound-specific regression replaces Web Audio with a silent fake.
  use: { ...base.use, storageState: { cookies: [], origins: [{ origin: "http://localhost:5174", localStorage: [{ name: "vivic.reminders.sound.v1", value: "0" }] }] } },
  projects: [
    { name: "firefox", use: { browserName: "firefox", launchOptions: { args: [], firefoxUserPrefs: { "media.volume_scale": "0.0" } } } },
    { name: "webkit", use: { browserName: "webkit", launchOptions: { args: [] } } },
  ],
});
