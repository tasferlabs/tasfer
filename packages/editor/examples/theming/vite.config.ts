import { resolve } from "node:path";
import { defineConfig } from "vite";

// The @cypherkit/editor package ships raw TypeScript source — there is no build
// step. We consume it by aliasing the bare import to the package's `src` folder,
// exactly like apps/web does. From examples/theming, the package source is two
// levels up.
const EDITOR_SRC = resolve(__dirname, "../../src");

export default defineConfig({
  resolve: {
    alias: {
      "@cypherkit/editor": EDITOR_SRC,
    },
  },
  server: {
    port: 4300,
  },
});
