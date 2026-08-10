import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Android shell configuration for the conversation-first web app.
 *
 * The Next.js API routes still run on the web server, so the shell points to
 * a configurable origin during development. Set CAPACITOR_SERVER_URL to a
 * deployed HTTPS URL for a distributable build, or to the host machine's
 * LAN address when using a physical device.
 */
const config: CapacitorConfig = {
  appId: "com.growthloop.agent",
  appName: "成长回路",
  webDir: "out",
  server: {
    url: process.env.CAPACITOR_SERVER_URL || "http://10.0.2.2:3000",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
