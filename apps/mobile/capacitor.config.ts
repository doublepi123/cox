import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "dev.doublepi.cox.mobile",
  appName: "Cox Mobile",
  webDir: "dist",
  ios: { limitsNavigationsToAppBoundDomains: false },
};

export default config;
