// Allow CSS side-effect and dynamic imports (e.g. the @fontsource faces loaded
// lazily in src/lib/fonts.ts) to typecheck. Webpack still processes the actual
// CSS; this only satisfies the type checker.
declare module "*.css";
