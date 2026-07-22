import { defineConfig } from "electron-vite";
import path from "path";

// electron-vite v5 externalizes node/electron deps by default (build.externalizeDeps),
// so the explicit externalizeDepsPlugin() on main/preload is no longer needed.
export default defineConfig({
  main: {
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
