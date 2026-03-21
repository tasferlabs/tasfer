import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import path from "path";

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@paralleldrive/cuid2"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    build: {
      rollupOptions: {
        input: path.join(__dirname, "src/renderer/index.html"),
      },
    },
  },
});
