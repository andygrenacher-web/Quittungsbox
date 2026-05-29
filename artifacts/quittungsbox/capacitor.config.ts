import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId:   "ch.quittungsbox.app",
  appName: "Quittungsbox",
  webDir:  "dist",

  android: {
    buildOptions: {},
    webContentsDebuggingEnabled: false,
  },

  plugins: {
    Camera: {
      presentationStyle: "fullscreen",
    },
    Filesystem: {},
    Preferences: {},
  },
};

export default config;
