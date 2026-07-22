// Compile the apps/web Tailwind v4 stylesheet to a static CSS file for the
// design-sync bundle (cfg.cssEntry). Tailwind v4 generates utilities on demand
// by scanning source files, so the shadcn components' classes only exist once
// compiled. Output: apps/web/.design-sync.compiled.css — utilities + @theme
// tokens + :root/.dark vars + brand @font-face + a real --font-sans value.
//
// Run from repo root: node .design-sync/compile-css.mjs
// Re-run after authoring previews (their layout classes must be scanned too).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const APP = resolve(REPO, "apps/web");

// Resolve Tailwind v4 from apps/web/node_modules (ESM resolves bare imports
// relative to this file's location, not cwd, so point at the app explicitly).
const appRequire = createRequire(resolve(APP, "package.json"));
const { compile } = await import(pathToFileURL(appRequire.resolve("@tailwindcss/node")));
const { Scanner } = await import(pathToFileURL(appRequire.resolve("@tailwindcss/oxide")));
const INPUT = resolve(APP, "styles.css");
const OUT = resolve(APP, ".design-sync.compiled.css");

// Brand faces the app loads via @fontsource at runtime; the design context has
// no bundler, so ship real @font-face pointing at the fontsource woff2 (urls
// relative to apps/web — the converter copies them into fonts/ and rewrites).
const FS = "./node_modules/@fontsource";
const face = (family, pkg, subset, weight) =>
  `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;` +
  `src:url(${FS}/${pkg}/files/${pkg}-${subset}-${weight}-normal.woff2) format('woff2');}`;
const FONT_FACES = [
  ...[400, 500, 600, 700].map((w) => face("Poppins", "poppins", "latin", w)),
  ...[400, 500, 600, 700].map((w) => face("Space Grotesk", "space-grotesk", "latin", w)),
  ...[400, 700].map((w) => face("Libre Baskerville", "libre-baskerville", "latin", w)),
  ...[400, 600].map((w) => face("Noto Sans Arabic", "noto-sans-arabic", "arabic", w)),
].join("\n");

// styles.css leaves --font-sans self-referential (the app sets body faces via
// JS); define the brand body face so `font-sans` utilities resolve in designs.
const FONT_SANS =
  `:root{--font-sans:'Poppins','Noto Sans Arabic',-apple-system,BlinkMacSystemFont,` +
  `'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;}`;

const input = readFileSync(INPUT, "utf8");
const compiler = await compile(input, { base: APP, onDependency() {} });

// The low-level compile() only returns @source-declared roots; styles.css has
// none, so scan the app source explicitly, plus the authored preview .tsx
// (dot-dir, skipped by auto-detection) so preview classes ship too.
const sources = [
  ...compiler.sources,
  { base: resolve(APP, "src"), pattern: "**/*.{ts,tsx,js,jsx}", negated: false },
  { base: resolve(REPO, ".design-sync/previews"), pattern: "**/*.tsx", negated: false },
];
const scanner = new Scanner({ sources });
const candidates = scanner.scan();
const utilities = compiler.build(candidates);

writeFileSync(OUT, `${FONT_FACES}\n${FONT_SANS}\n${utilities}\n`);
console.error(
  `compiled ${OUT} — ${candidates.length} candidates, ${(utilities.length / 1024).toFixed(0)} KB`,
);
