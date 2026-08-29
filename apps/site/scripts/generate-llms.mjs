/**
 * Generates the machine-readable mirror of the documentation, so a model that
 * lands on a docs URL can read the article without parsing the app shell out of
 * the HTML:
 *
 *   public/llms.txt                 index of every article (llmstxt.org)
 *   public/llms-full.txt            every article, concatenated
 *   public/<lang>/docs/<route>.md   one article as plain markdown
 *   public/docs/<route>.md          the same file, unprefixed (default locale)
 *
 * The paths are chosen so that appending ".md" to any documentation URL returns
 * its source: /en/docs/app/markdown/ → /en/docs/app/markdown.md. Next copies
 * public/ into the export verbatim, and a path with a file extension is exempt
 * from the trailingSlash redirect, so both forms resolve.
 *
 * The articles are MDX with real components in them, so this is a mdast
 * transform rather than a copy: every component the docs use is rewritten to the
 * plain-markdown construct that carries the same meaning. Variant switchers
 * (package manager, framework, generic tabs) are the one place where the
 * markdown says *more* than the page — a reader picks one tab, but the file
 * carries every branch, labelled, because a model has no tab to click.
 *
 * Run by `npm run build`; also runnable on its own:
 *
 *   node scripts/generate-llms.mjs
 *
 * Output is derived and gitignored. Two couplings are asserted at generation
 * time and fail the build loudly rather than silently emitting a thinner file:
 * the nav is read out of docsNav.tsx (the typed source of truth stays there),
 * and an unrecognised component name throws.
 */

import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { unified } from "unified";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC = join(ROOT, "public");
const PAGES = join(ROOT, "src/views/DocsPage/pages");

/** Mirrors SITE_ORIGIN in src/lib/seo.ts. */
const SITE_ORIGIN = "https://www.tasfer.app";
const SITE_NAME = "Tasfer";

/* Constants an article may pass to a component as an identifier rather than a
 * literal. Resolved to the value the production build inlines (see
 * src/lib/appUrl.ts — on Vercel the editor is a microfrontend under /app).
 * Anything else unresolvable throws, so a new one can't quietly vanish. */
const KNOWN_IDENTIFIERS = { APP_OPEN_URL: "/app/page" };

/** Mirrors the commands InstallTabs renders (docsComponents.tsx). */
const INSTALL_COMMANDS = (pkg, dev) => [
  `npm install${dev ? " --save-dev" : ""} ${pkg}`,
  `pnpm add${dev ? " -D" : ""} ${pkg}`,
  `yarn add${dev ? " -D" : ""} ${pkg}`,
  `bun add${dev ? " -D" : ""} ${pkg}`,
];

const FRAMEWORK_LABELS = { js: "JavaScript", react: "React" };
const CALLOUT_LABELS = { note: "Note", warn: "Warning", tip: "Tip" };

/* ── reading the site's own sources ─────────────────────────────────────── */

/**
 * The documentation nav lives in docsNav.tsx, which imports JSX icons and every
 * MDX article — not something a plain Node script can import. The literals it
 * declares are uniform, so they are read out of the source instead, in file
 * order (which is nav order). Every article must appear exactly once; the count
 * is checked against the MDX on disk below.
 */
async function readNav() {
  const source = await readFile(
    join(ROOT, "src/views/DocsPage/docsNav.tsx"),
    "utf8",
  );

  const sections = new Map();
  const sectionRe =
    /id:\s*"([^"]+)",\s*\n\s*label:\s*"[^"]*",\s*\n\s*labelKey:\s*"([^"]+)"/g;
  for (const m of source.matchAll(sectionRe)) sections.set(m[1], m[2]);

  const itemRe =
    /route:\s*"([^"]+)",\s*\n\s*title:\s*"(?:[^"\\]|\\.)*",\s*\n\s*titleKey:\s*"([^"]+)",\s*\n\s*descKey:\s*"([^"]+)",/g;
  const items = [...source.matchAll(itemRe)].map((m) => ({
    route: m[1],
    titleKey: m[2],
    descKey: m[3],
    sectionId: m[1].split("/")[0],
  }));

  if (!items.length || !sections.size) {
    throw new Error(
      "generate-llms: could not read the nav out of docsNav.tsx — its shape changed.",
    );
  }
  for (const item of items) {
    if (!sections.has(item.sectionId)) {
      throw new Error(
        `generate-llms: no nav section for "${item.sectionId}" (route ${item.route}).`,
      );
    }
  }
  return { items, sectionLabelKeys: sections };
}

/** The locales the site actually exports, read from SUPPORTED_LNGS. */
async function readLocales() {
  const source = await readFile(join(ROOT, "src/lib/i18n/locales.ts"), "utf8");
  const list = source.match(/SUPPORTED_LNGS\s*=\s*\[([^\]]*)\]/);
  const fallback = source.match(/DEFAULT_LNG:\s*Lng\s*=\s*"([^"]+)"/);
  if (!list || !fallback) {
    throw new Error("generate-llms: could not read the locales out of locales.ts.");
  }
  const langs = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  return { langs, defaultLang: fallback[1] };
}

/** Every .mdx under pages/, as routes, so a page missing from the nav is caught. */
async function readArticleRoutes(dir, prefix = "") {
  const routes = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      routes.push(...(await readArticleRoutes(join(dir, entry.name), `${prefix}${entry.name}/`)));
    } else if (entry.name.endsWith(".mdx")) {
      routes.push(prefix + entry.name.replace(/\.mdx$/, ""));
    }
  }
  return routes;
}

/* ── mdast helpers ──────────────────────────────────────────────────────── */

const text = (value) => ({ type: "text", value });
const paragraph = (children) => ({ type: "paragraph", children });
const strong = (children) => ({ type: "strong", children });
const label = (value) => paragraph([strong([text(value)])]);
const inlineCode = (value) => ({ type: "inlineCode", value });

function evaluate(expression, scope) {
  const names = Object.keys(scope);
  const fn = new Function(...names, `"use strict"; return (${expression});`);
  return fn(...names.map((name) => scope[name]));
}

/** An attribute's value: a string literal, `true` for a bare flag, or the
 *  evaluated expression for `attr={...}`. Returns undefined when absent. */
function attribute(node, name, scope) {
  const found = node.attributes?.find(
    (a) => a.type === "mdxJsxAttribute" && a.name === name,
  );
  if (!found) return undefined;
  if (found.value == null) return true;
  if (typeof found.value === "string") return found.value;
  try {
    return evaluate(found.value.value, scope);
  } catch {
    // JSX-valued attributes (icon={<Icons.X />}) are decoration; they carry no
    // meaning in a text mirror and are dropped by their component's handler.
    return undefined;
  }
}

/** Plain text of a subtree — for attributes and cells that must be a string. */
function plainText(node) {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (node.value != null && typeof node.value === "string") return node.value;
  return node.children ? node.children.map(plainText).join("") : "";
}

/** Wraps loose phrasing in a paragraph so a flow position stays valid. */
function asFlow(nodes) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length) out.push(paragraph(run));
    run = [];
  };
  for (const node of nodes) {
    const phrasing =
      node.type === "text" ||
      node.type === "strong" ||
      node.type === "emphasis" ||
      node.type === "inlineCode" ||
      node.type === "link" ||
      node.type === "delete" ||
      node.type === "break" ||
      node.type === "image";
    if (phrasing) {
      if (node.type === "text" && !node.value.trim()) continue;
      run.push(node);
    } else {
      flush();
      out.push(node);
    }
  }
  flush();
  return out;
}

/** Fenced code blocks in document order, for the tab components. */
const fencesOf = (nodes) => nodes.filter((n) => n.type === "code");

/* ── the MDX → markdown transform ───────────────────────────────────────── */

const HTML_INLINE = new Set(["span", "b", "i", "u", "small", "abbr", "kbd", "sup", "sub"]);
const DROP = new Set(["br", "hr", "img"]);

function convertAll(nodes, ctx) {
  return nodes.flatMap((node) => convert(node, ctx));
}

function convert(node, ctx) {
  switch (node.type) {
    // `import` / `export` statements: the exported data is scope for the
    // expressions below, the statements themselves are not content.
    case "mdxjsEsm":
      return [];

    case "mdxFlowExpression":
    case "mdxTextExpression": {
      const value = node.value.trim();
      if (value.startsWith("/*") || value.startsWith("//")) return [];
      // A bare identifier or a template value inside prose: render what it is.
      try {
        return [text(String(evaluate(value, ctx.scope)))];
      } catch {
        return [];
      }
    }

    case "mdxJsxFlowElement":
    case "mdxJsxTextElement":
      return convertJsx(node, ctx);

    default:
      if (Array.isArray(node.children)) {
        node.children = convertAll(node.children, ctx);
      }
      return [node];
  }
}

function convertJsx(node, ctx) {
  const name = node.name;
  const children = () => convertAll(node.children ?? [], ctx);
  const attr = (key) => attribute(node, key, ctx.scope);

  // Fragments (<>…</>) and decorative icons.
  if (name === null) return children();
  if (name.startsWith("Icons.") || DROP.has(name)) return [];

  switch (name) {
    /* ── headings ── */
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return [{ type: "heading", depth: Number(name[1]), children: children() }];

    /* ── prose wrappers ── */
    case "Lede":
    case "div":
    case "p":
      return asFlow(children());

    case "CardGrid":
    case "Steps":
      return [
        {
          type: "list",
          ordered: name === "Steps",
          spread: false,
          children: children(),
        },
      ];

    case "LicenseCard":
      return [{ type: "blockquote", children: asFlow(children()) }];

    /* ── callout ── */
    case "Callout": {
      const kind = attr("kind") ?? "note";
      const title = attr("title");
      const head = CALLOUT_LABELS[kind] ?? CALLOUT_LABELS.note;
      return [
        {
          type: "blockquote",
          children: [
            paragraph([strong([text(title ? `${head}: ${title}` : head)])]),
            ...asFlow(children()),
          ],
        },
      ];
    }

    /* ── cards & steps ── */
    case "Card": {
      const to = attr("to") ?? "";
      // Mirrors Card: an absolute URL is external, a leading "/" is an in-app
      // path, and a bare slug is a docs route.
      const href = /^https?:\/\//.test(to) || to.startsWith("/") ? to : `/docs/${to}`;
      const title = String(attr("title") ?? "");
      const desc = String(attr("desc") ?? "");
      const link = { type: "link", url: href, children: [text(title)] };
      return [
        {
          type: "listItem",
          spread: false,
          children: [paragraph(desc ? [link, text(` — ${desc}`)] : [link])],
        },
      ];
    }

    case "Step": {
      const title = attr("title");
      const body = asFlow(children());
      return [
        {
          type: "listItem",
          spread: false,
          children: title ? [label(String(title)), ...body] : body,
        },
      ];
    }

    /* ── variant switchers ──
       The page shows one branch; the markdown carries them all, labelled, so a
       model reading the file sees every package manager and both frameworks. */
    case "InstallTabs": {
      const pkg = String(attr("pkg") ?? "");
      return [
        {
          type: "code",
          lang: "bash",
          value: INSTALL_COMMANDS(pkg, attr("dev") === true).join("\n"),
        },
      ];
    }

    case "FrameworkTabs": {
      const fences = fencesOf(children());
      if (!fences.length) return [];
      const [js, react] = fences;
      if (!react) return [js];
      return [label(FRAMEWORK_LABELS.js), js, label(FRAMEWORK_LABELS.react), react];
    }

    case "ForFramework": {
      const fw = attr("fw");
      return [label(FRAMEWORK_LABELS[fw] ?? String(fw)), ...asFlow(children())];
    }

    case "Tabs": {
      const labels = attr("labels") ?? [];
      return fencesOf(children()).flatMap((fence, i) => [
        label(String(labels[i] ?? `Option ${i + 1}`)),
        fence,
      ]);
    }

    case "ForTab": {
      const group = String(attr("group") ?? "");
      const index = Number(attr("index") ?? 0);
      const name = ctx.tabLabels.get(group)?.[index] ?? `Option ${index + 1}`;
      return [label(String(name)), ...asFlow(children())];
    }

    /* ── tables ── */
    case "PropsTable": {
      const rows = attr("rows") ?? [];
      const cols = attr("cols") ?? ["Prop", "Type", "Description"];
      const withType = cols.length > 2;
      const header = cols.map((c) => [text(String(c))]);
      const body = rows.map((row) => {
        const nameCell = [inlineCode(String(row.name))];
        if (row.required) nameCell.push(text(" (required)"));
        const cells = [nameCell];
        if (withType) cells.push([inlineCode(String(row.type ?? ""))]);
        cells.push([text(String(row.desc ?? ""))]);
        return cells;
      });
      return [table([header, ...body])];
    }

    case "table":
      return [convertHtmlTable(node, ctx)].flat();

    /* ── inline html ── */
    case "code":
      return [inlineCode(plainText(node))];
    case "strong":
      return [strong(children())];
    case "em":
      return [{ type: "emphasis", children: children() }];
    case "a":
      return [{ type: "link", url: String(attr("href") ?? ""), children: children() }];

    default:
      if (HTML_INLINE.has(name)) return children();
      // Anything else is a component this script does not know how to say in
      // markdown. Fail rather than drop a section of an article on the floor.
      throw new Error(
        `generate-llms: no markdown mapping for <${name}> (in ${ctx.route}).`,
      );
  }
}

function table(rows) {
  return {
    type: "table",
    align: [],
    children: rows.map((cells) => ({
      type: "tableRow",
      children: cells.map((cell) => ({ type: "tableCell", children: cell })),
    })),
  };
}

/**
 * A hand-written <table> in an article — always a data array mapped to rows.
 * The row template is markup, so the cells come from the data itself: the
 * expression's leading identifier is evaluated against the article's exports
 * and each entry becomes a row. A table with no <thead> (the FAQ) has no
 * headings to carry, so it becomes a definition-style list instead.
 */
function convertHtmlTable(node, ctx) {
  const rows = [];
  let header = null;

  const walk = (n) => {
    if (n.type === "mdxJsxFlowElement" || n.type === "mdxJsxTextElement") {
      if (n.name === "tr") {
        const cells = (n.children ?? [])
          .filter((c) => c.name === "td" || c.name === "th")
          .map((c) => convertAll(c.children ?? [], ctx));
        const isHeader = (n.children ?? []).some((c) => c.name === "th");
        if (isHeader && !header) header = cells;
        else rows.push(cells);
        return;
      }
      for (const child of n.children ?? []) walk(child);
      return;
    }
    if (n.type === "mdxFlowExpression") {
      const source = n.value.match(/^\s*([A-Za-z_$][\w$]*)\s*\.map\b/);
      if (!source) return;
      const data = ctx.scope[source[1]];
      if (!Array.isArray(data)) {
        throw new Error(
          `generate-llms: <table> maps over "${source[1]}", which is not article data (in ${ctx.route}).`,
        );
      }
      for (const entry of data) {
        rows.push((Array.isArray(entry) ? entry : [entry]).map((c) => [text(String(c))]));
      }
    }
  };
  walk(node);

  if (!rows.length) return [];
  if (header) return table([header, ...rows]);
  return {
    type: "list",
    ordered: false,
    spread: false,
    children: rows.map(([first, ...rest]) => ({
      type: "listItem",
      spread: false,
      children: [paragraph([strong(first), text(` — ${plainText(rest)}`)])],
    })),
  };
}

/**
 * Locale-neutral in-site links point at pages; in the markdown mirror they
 * point at the markdown, so a model that follows one keeps reading source
 * rather than HTML. External and /app links are left alone beyond absolutising.
 */
function absolutizeLinks(tree, lang) {
  const walk = (node) => {
    if (node.type === "link" && node.url.startsWith("/")) {
      const [path, hash] = node.url.split("#");
      const clean = path.replace(/\/$/, "");
      if (clean.startsWith("/docs/") && clean.split("/").length === 4) {
        node.url = `${SITE_ORIGIN}/${lang}${clean}.md${hash ? `#${hash}` : ""}`;
      } else if (clean.startsWith("/app")) {
        // The editor is a client-routed SPA under /app; its paths are not
        // trailing-slashed pages.
        node.url = `${SITE_ORIGIN}${clean}${hash ? `#${hash}` : ""}`;
      } else {
        node.url = `${SITE_ORIGIN}/${lang}${clean}/${hash ? `#${hash}` : ""}`;
      }
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
}

/**
 * The data an article exports for its own markup (`export const faqs = [...]`),
 * evaluated so the table handler can read it. Imports are stripped first: they
 * name components, which a text mirror never renders. A declaration that isn't
 * plain data simply doesn't make it into the scope.
 */
function articleScope(tree) {
  const scope = { ...KNOWN_IDENTIFIERS };
  for (const node of tree.children) {
    if (node.type !== "mdxjsEsm" || !node.value.includes("export const")) continue;
    const names = [...node.value.matchAll(/export\s+const\s+([A-Za-z_$][\w$]*)/g)].map(
      (m) => m[1],
    );
    // Anchored to the start of a line so neither rewrite can reach inside a
    // string literal — the data is prose, and it says "export" a lot.
    const source = node.value
      .replace(/^import\s+[\s\S]*?\s+from\s+(["'])[^"']*\1;?/gm, "")
      .replace(/^export\s+/gm, "");
    try {
      Object.assign(
        scope,
        new Function(`"use strict"; ${source}; return { ${names.join(", ")} };`)(),
      );
    } catch {
      /* not plain data — the markup that needs it will fail loudly instead */
    }
  }
  return scope;
}

/**
 * <ForTab> can precede the <Tabs> whose labels name it, so the labels are
 * collected in one pass before anything is converted.
 */
function collectTabLabels(tree, scope) {
  const labels = new Map();
  const walk = (node) => {
    if (node.name === "Tabs") {
      const group = attribute(node, "group", scope);
      const list = attribute(node, "labels", scope);
      if (group && Array.isArray(list)) labels.set(String(group), list);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return labels;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMdx);
const serializer = unified()
  .use(remarkStringify, { bullet: "-", rule: "-", fences: true, emphasis: "*" })
  .use(remarkGfm);

async function articleMarkdown(file, route, lang) {
  const tree = parser.parse(await readFile(file, "utf8"));
  const scope = articleScope(tree);
  const ctx = { route, scope, tabLabels: collectTabLabels(tree, scope) };
  tree.children = convertAll(tree.children, ctx);
  absolutizeLinks(tree, lang);
  return serializer.stringify(tree).trim();
}

/* ── output ─────────────────────────────────────────────────────────────── */

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

const yaml = (value) => JSON.stringify(String(value));

function articleFile(page, lang, body) {
  return [
    "---",
    `title: ${yaml(page.title)}`,
    `description: ${yaml(page.description)}`,
    `section: ${yaml(page.section)}`,
    `source: ${SITE_ORIGIN}/${lang}/docs/${page.route}/`,
    "---",
    "",
    `# ${page.title}`,
    "",
    body,
    "",
  ].join("\n");
}

/**
 * llms.txt, per llmstxt.org: an H1, a blockquote summary, then one H2 per
 * documentation section listing its articles as links to their markdown.
 */
function llmsIndex(pages, dictionary, lang) {
  const lines = [
    `# ${SITE_NAME}`,
    "",
    `> ${dictionary["metadata.description"]}`,
    "",
    "Every documentation page is available as plain markdown at its own URL with",
    "`.md` appended (`/docs/app/markdown/` → `/docs/app/markdown.md`), and all of",
    `them concatenated at ${SITE_ORIGIN}/llms-full.txt.`,
    "",
    "Pages that document more than one variant — package manager, framework —",
    "carry every variant in the markdown. The HTML pages take the same choices as",
    "query parameters: `?pm=npm|pnpm|yarn|bun`, `?framework=js|react`, and",
    "`?tab.<group>=<index>` for a page's own switchers.",
    "",
  ];
  let section = null;
  for (const page of pages) {
    if (page.section !== section) {
      if (section) lines.push("");
      section = page.section;
      lines.push(`## ${section}`, "");
    }
    lines.push(
      `- [${page.title}](${SITE_ORIGIN}/${lang}/docs/${page.route}.md): ${page.description}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

async function main() {
  const [{ items, sectionLabelKeys }, { langs, defaultLang }] = await Promise.all([
    readNav(),
    readLocales(),
  ]);

  // Everything under pages/ — the default locale's articles at the top level,
  // each translation under its own <lang>/ directory.
  const onDisk = await readArticleRoutes(PAGES);
  const missing = onDisk
    .filter((route) => sectionLabelKeys.has(route.split("/")[0]))
    .filter((route) => !items.some((item) => item.route === route));
  if (missing.length) {
    throw new Error(
      `generate-llms: article(s) not in the docs nav: ${missing.join(", ")}.`,
    );
  }

  // Everything this script owns, cleared first so a removed page can't linger.
  await Promise.all([
    rm(join(PUBLIC, "docs"), { recursive: true, force: true }),
    rm(join(PUBLIC, "llms.txt"), { force: true }),
    rm(join(PUBLIC, "llms-full.txt"), { force: true }),
    ...langs.map((lang) => rm(join(PUBLIC, lang), { recursive: true, force: true })),
  ]);

  for (const lang of langs) {
    const dictionary = JSON.parse(
      await readFile(join(ROOT, `src/lib/i18n/${lang}.json`), "utf8"),
    );
    const pages = [];

    for (const item of items) {
      // A locale keeps its translated article under pages/<lang>/, and falls
      // back to the English one where there is no translation (the SDK section).
      const source = onDisk.includes(`${lang}/${item.route}`)
        ? join(PAGES, lang, `${item.route}.mdx`)
        : join(PAGES, `${item.route}.mdx`);

      const page = {
        route: item.route,
        title: dictionary[item.titleKey],
        description: dictionary[item.descKey],
        section: dictionary[sectionLabelKeys.get(item.sectionId)],
      };
      if (!page.title || !page.description) {
        throw new Error(
          `generate-llms: ${lang} is missing a title or description for ${item.route}.`,
        );
      }

      const body = await articleMarkdown(source, item.route, lang);
      const file = articleFile(page, lang, body);
      await write(join(PUBLIC, lang, "docs", `${item.route}.md`), file);
      if (lang === defaultLang) {
        await write(join(PUBLIC, "docs", `${item.route}.md`), file);
      }
      pages.push({ ...page, body: file });
    }

    const index = llmsIndex(pages, dictionary, lang);
    const full = [
      `# ${SITE_NAME} documentation`,
      "",
      `> ${dictionary["metadata.description"]}`,
      "",
      ...pages.map((page) => page.body),
    ].join("\n");

    await write(join(PUBLIC, lang, "llms.txt"), index);
    await write(join(PUBLIC, lang, "llms-full.txt"), full);
    if (lang === defaultLang) {
      await write(join(PUBLIC, "llms.txt"), index);
      await write(join(PUBLIC, "llms-full.txt"), full);
    }
  }

  console.log(
    `generate-llms: ${items.length} article(s) × ${langs.length} locale(s) → public/`,
  );
}

await main();
