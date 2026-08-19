import { defineConfig } from "electron-vite";
import { readFileSync } from "fs";
import path from "path";

// The app version lives only in /version.json at the monorepo root. Packaged
// builds also get it through electron-builder's extraMetadata (see
// scripts/package.mjs); this define is what makes `npm run dev` report the same
// version, since the unpackaged package.json carries none.
const appVersion: string = JSON.parse(
  readFileSync(path.join(__dirname, "../../version.json"), "utf-8"),
).appVersion;

// electron-vite v5 externalizes node/electron deps by default (build.externalizeDeps),
// so the explicit externalizeDepsPlugin() on main/preload is no longer needed.
export default defineConfig({
  main: {
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
    },
    build: {
      lib: {
        entry: path.join(__dirname, "src/main/index.ts"),
      },
    },
  },
  preload: {
    build: {
      lib: {
        entry: path.join(__dirname, "src/preload/index.ts"),
      },
    },
  },
  renderer: {
    build: {
      rollupOptions: {
        input: path.join(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
