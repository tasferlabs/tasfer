import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "md.cypher.app",
  appName: "Cypher",
  webDir: "dist",
  server: {
    // For development, uncomment and set your dev server URL:
    url: "http://192.168.68.55:4000",
    cleartext: true,
    // hostname: "cypher.md",
    // androidScheme: "https",
    allowNavigation: ["cypher.md"],
  },
  ios: {
    backgroundColor: "#0a0a0a",
    contentInset: "never",
    preferredContentMode: "mobile",
    scheme: "https",
    path: "../ios",
  },
  android: {
    backgroundColor: "#0a0a0a",
    path: "../android",
  },
  plugins: {
    CapacitorHttp: {
      enabled: false,
    },
  },
};

export default config;
