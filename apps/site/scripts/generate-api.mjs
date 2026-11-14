/**
 * Generates the data behind the API reference page (/docs/editor/reference)
 * from the packages' own source, so the reference cannot drift from the code
 * or skip an export:
 *
 *   src/views/DocsPage/reference/data/meta.json    the packages' version
 *   src/views/DocsPage/reference/data/index.json   version + package list
 *   src/views/DocsPage/reference/data/<pkg>.json   every export of one package
 *
 * Every public entry point of every published package is read (the `exports`
 * map of its package.json, minus the `./*` deep-import wildcard). For each
 * export it records the signature as written, the doc comment, and the members
 * of a class, interface or object type. Exports tagged `@internal` are left out.
 *
 * The output is committed. The site build only reads the JSON, so it needs
 * neither the packages nor a compiler, and a pull request that changes the
 * public API shows that change as a diff of these files.
 *
 *   node scripts/generate-api.mjs                  regenerate (npm run api)
 *   node scripts/generate-api.mjs --check          fail when stale (npm run api:check)
 *   node scripts/generate-api.mjs --init-baseline  restart the baseline (see below)
 *
 * Two rules are enforced on every run, and both only bite on new code:
 *
 *   1. An export must have a doc comment.
 *   2. An export added after the baseline must say when it arrived: `@since 0.3.0`.
 *
 * scripts/api-baseline.json is what "new" is measured against. It lists the
 * exports that existed when the rules were introduced (they need no `@since`)
 * and the ones that had no doc comment then (they are tolerated until someone
 * writes one). The second list only shrinks: a regenerate drops a name as soon
 * as it gets documented.
 *
 * Types are read through TypeScript 7's own API (`typescript/unstable/sync`).
 * It is marked unstable, which is why the result is committed rather than
 * produced at build time: a compiler upgrade that changes the API breaks this
 * script, never the site. Inferred types depend on each package's dependencies
 * being installed and on its siblings being built, so both are checked first.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { SyntaxKind as SK } from "typescript/unstable/ast";
import { API, SymbolFlags } from "typescript/unstable/sync";
import { unified } from "unified";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPO = resolve(ROOT, "../..");
const PACKAGES = join(REPO, "packages");
const OUT = join(ROOT, "src/views/DocsPage/reference/data");
const BASELINE = join(ROOT, "scripts/api-baseline.json");

const args = new Set(process.argv.slice(2));
const CHECK = args.has("--check");
const INIT_BASELINE = args.has("--init-baseline");

/** Packages a reader meets first, in that order; the rest follow in build order. */
const FRONT = ["editor", "react", "math", "code", "table"];

/** Order of the kind groups on the page. */
const KIND_ORDER = ["function", "class", "interface", "type", "const", "enum", "namespace"];

/** An inferred type longer than this is cut: it is a data table, not a signature. */
const MAX_INFERRED = 400;

/* ── what to read ───────────────────────────────────────────────────────── */

/**
 * The published packages. packages/build-all.sh is the list the release
 * workflow builds and publishes from, so it is read rather than repeated here.
 */
function publishedPackages() {
  const source = readFileSync(join(PACKAGES, "build-all.sh"), "utf8");
  const order = source.match(/^ORDER=\(([^)]*)\)/m);
  if (!order) {
    throw new Error(
      "generate-api: could not read ORDER=(…) out of packages/build-all.sh — its shape changed.",
    );
  }
  const built = order[1].trim().split(/\s+/);
  return [
    ...FRONT.filter((p) => built.includes(p)),
    ...built.filter((p) => !FRONT.includes(p)),
  ];
}

function packagesVersion() {
  const { packagesVersion: version } = JSON.parse(
    readFileSync(join(REPO, "version.json"), "utf8"),
  );
  if (!isVersion(version)) {
    throw new Error(`generate-api: version.json has no usable packagesVersion (${version}).`);
  }
  return version;
}

const isVersion = (v) => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);

/** The entry points a package documents: its `exports` keys, minus wildcards. */
function entriesOf(dir, pkg) {
  return Object.keys(pkg.exports ?? {})
    .filter((key) => !key.includes("*") && key !== "./package.json")
    .map((key) => {
      const rel = key === "." ? "index" : key.slice(2);
      const file = [".ts", ".tsx", "/index.ts", "/index.tsx"]
        .map((suffix) => join(dir, "src", rel + suffix))
        .find(existsSync);
      if (!file) {
        throw new Error(`generate-api: no source file for ${pkg.name} entry "${key}".`);
      }
      return { id: key === "." ? pkg.name : pkg.name + key.slice(1), file };
    });
}

/* ── doc comments ───────────────────────────────────────────────────────── */

const markdown = unified().use(remarkParse).use(remarkGfm);

const KEEP = new Set([
  "paragraph",
  "text",
  "inlineCode",
  "strong",
  "emphasis",
  "delete",
  "link",
  "list",
  "listItem",
  "code",
  "blockquote",
  "break",
  "heading",
  "table",
  "tableRow",
  "tableCell",
]);

function plainText(node) {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(plainText).join("");
}

/** mdast, cut down to the node types the page renders and stripped of
 *  positions. Anything else (raw HTML such as a bare `<T>`) becomes text. */
function lite(node) {
  if (!KEEP.has(node.type)) {
    const value = plainText(node);
    return value ? { type: "text", value } : null;
  }
  const out = { type: node.type };
  for (const key of ["value", "url", "lang", "depth"]) {
    if (node[key] != null) out[key] = node[key];
  }
  if (node.ordered) out.ordered = true;
  if (node.children) out.children = node.children.map(lite).filter(Boolean);
  return out;
}

function toMdast(text) {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const children = markdown.parse(trimmed).children.map(lite).filter(Boolean);
  return children.length ? children : undefined;
}

/**
 * `{@link Name}` → a markdown link the page resolves against the reference
 * (`ref:Name`), so a name mentioned in a comment is a click away. A member
 * reference (`Name.member`, `Name#member`) links to its owner.
 */
function resolveLinks(text) {
  return text.replace(
    /\{@link(?:code|plain)?\s+([^}|\s]+)\s*\|?\s*([^}]*)\}/g,
    (_, target, label) => {
      if (/^https?:\/\//.test(target)) return `[${label.trim() || target}](${target})`;
      const owner = target.split(/[.#]/)[0];
      const shown = label.trim() || `\`${target.replace("#", ".")}\``;
      return `[${shown}](ref:${owner})`;
    },
  );
}

function commentText(comment) {
  if (comment == null) return "";
  if (typeof comment === "string") return resolveLinks(comment);
  // Joined by hand: a link is taken as it was written (`{@link Name}`) and
  // resolved below. The compiler's own helper throws on some link targets.
  let out = "";
  for (const part of comment) {
    out += part.kind === SK.JSDocText ? part.text : part.getText();
  }
  return resolveLinks(out);
}

/** The doc comment directly above a declaration: its text and its tags. */
function readJsDoc(node) {
  // A `const` carries its comment on the statement, two levels up.
  const holder =
    node.kind === SK.VariableDeclaration && !node.jsDoc?.length
      ? node.parent?.parent
      : node;
  const blocks = holder?.jsDoc;
  const block = blocks?.[blocks.length - 1];
  if (!block) return { doc: "", tags: [] };
  const tags = (block.tags ?? []).map((tag) => {
    let text = commentText(tag.comment);
    if (tag.kind === SK.JSDocParameterTag && tag.name) {
      text = `${tag.name.getText()} ${text}`;
    }
    return { name: tag.tagName.text, text };
  });
  return { doc: commentText(block.comment).trim(), tags };
}

function exampleOf(text) {
  const fence = text.match(/```(\w*)\n([\s\S]*?)```/);
  if (!fence) return { lang: "ts", code: text.trim() };
  const title = text.slice(0, fence.index).trim();
  return {
    lang: fence[1] || "ts",
    code: fence[2].replace(/\s+$/, ""),
    ...(title ? { title } : {}),
  };
}

/** The first sentence of a comment, as the one-line summary of a row. */
function summaryOf(doc) {
  const first = doc.trim().split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim();
  const plain = first.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const sentence = plain.match(/^(.*?[.!?:])(?=\s+[A-Z`]|$)/);
  let out = (sentence ? sentence[1] : plain).replace(/:$/, ".");
  if (out.length > 220) out = out.slice(0, 217).replace(/\s+\S*$/, "") + "…";
  return out;
}

/** Fields a doc comment contributes to a row, export or member alike. */
function docFields({ doc, tags }, where, problems) {
  const out = {};
  let body = doc;
  for (const { name, text } of tags) {
    const value = text.trim();
    switch (name) {
      case "since": {
        const version = value.split(/\s+/)[0];
        if (!isVersion(version)) {
          problems.push(`${where}: "@since ${value}" is not a major.minor.patch version.`);
        } else {
          out.since = version;
        }
        break;
      }
      case "deprecated":
        out.deprecated = toMdast(value) ?? true;
        break;
      case "experimental":
      case "alpha":
      case "beta":
        out.experimental = true;
        break;
      case "example":
        if (value) (out.examples ??= []).push(exampleOf(value));
        break;
      case "param": {
        const param = value.match(/^(\S+)\s*(?:-\s*)?([\s\S]*)$/);
        const about = param && toMdast(param[2]);
        if (about) (out.params ??= []).push({ name: param[1], doc: about });
        break;
      }
      case "returns":
      case "return": {
        const about = toMdast(value);
        if (about) out.returns = about;
        break;
      }
      case "default":
      case "defaultValue":
        if (value) out.default = value.replace(/^`+|`+$/g, "");
        break;
      case "remarks":
        if (value) body = body ? `${body}\n\n${value}` : value;
        break;
      default:
        break;
    }
  }
  if (body) {
    out.summary = summaryOf(body);
    out.doc = toMdast(body);
  }
  return out;
}

/* ── signatures ─────────────────────────────────────────────────────────── */

/**
 * Source between two offsets of a node's file, with the indentation of the line
 * it starts on taken off every following line. So a member lifted out of a
 * class reads flush left, and a top-level union keeps its own indentation.
 */
function cut(node, from = node.getStart(), to = node.getEnd()) {
  const text = node.getSourceFile().text;
  const lineStart = text.lastIndexOf("\n", from - 1) + 1;
  const indent = text.slice(lineStart, from).match(/^[ \t]*/)[0].length;
  const [first, ...rest] = text.slice(from, to).replace(/\r\n/g, "\n").split("\n");
  return [
    first,
    ...rest.map((line) => line.slice(Math.min(indent, line.match(/^[ \t]*/)[0].length))),
  ].join("\n");
}

/** A declaration's head as a reader would write it: no `export`, no body. */
function head(text) {
  return text
    .trim()
    .replace(/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?/, "")
    .replace(/\s*[{=;,]\s*$/, "")
    .trim();
}

/** Where a class or interface body opens: the first `{` after its heritage. */
function bodyOpen(node) {
  const text = node.getSourceFile().text;
  let from = node.name ? node.name.getEnd() : node.getStart();
  for (const list of [node.typeParameters, node.heritageClauses]) {
    if (list?.length) from = Math.max(from, list[list.length - 1].getEnd());
  }
  const open = text.indexOf("{", from);
  return open < 0 ? node.getEnd() : open;
}

function inferredType(ctx, symbol) {
  const type = symbol && ctx.checker.getTypeOfSymbol(symbol);
  const text = type ? ctx.checker.typeToString(type) : "unknown";
  return text.length > MAX_INFERRED ? text.slice(0, MAX_INFERRED).trimEnd() + " …" : text;
}

const hasModifier = (node, kind) => (node.modifiers ?? []).some((m) => m.kind === kind);

/** One member of a class, interface or object type; null when it is not public. */
function describeMember(ctx, node, where) {
  if (hasModifier(node, SK.PrivateKeyword)) return null;
  if (node.name?.kind === SK.PrivateIdentifier) return null;
  const docs = readJsDoc(node);
  if (docs.tags.some((tag) => tag.name === "internal")) return null;

  const start = node.getStart();
  const untilBody = () =>
    head(cut(node, start, node.body ? node.body.getStart() : node.getEnd()));

  let kind;
  let name;
  let sig;
  switch (node.kind) {
    case SK.PropertySignature:
      kind = "property";
      name = node.name.getText();
      sig = head(cut(node));
      break;
    case SK.PropertyDeclaration: {
      kind = "property";
      name = node.name.getText();
      if (node.initializer) {
        sig = head(cut(node, start, node.initializer.getStart()));
        if (!node.type) {
          sig += `: ${inferredType(ctx, ctx.checker.getSymbolAtLocation(node.name))}`;
        }
      } else {
        sig = head(cut(node));
      }
      break;
    }
    case SK.MethodSignature:
    case SK.MethodDeclaration:
      kind = "method";
      name = node.name.getText();
      sig = untilBody();
      break;
    case SK.Constructor:
      kind = "constructor";
      name = "constructor";
      sig = untilBody();
      break;
    case SK.GetAccessor:
    case SK.SetAccessor:
      kind = "accessor";
      name = node.name.getText();
      sig = untilBody();
      break;
    case SK.CallSignature:
      kind = "call";
      name = "(call)";
      sig = head(cut(node));
      break;
    case SK.ConstructSignature:
      kind = "construct";
      name = "new";
      sig = head(cut(node));
      break;
    case SK.IndexSignature:
      kind = "index";
      name = "[index]";
      sig = head(cut(node));
      break;
    case SK.EnumMember:
      kind = "property";
      name = node.name.getText();
      sig = head(cut(node));
      break;
    default:
      return null;
  }

  return {
    name,
    kind,
    sig,
    ...(node.questionToken ? { optional: true } : {}),
    ...docFields(docs, `${where}.${name}`, ctx.problems),
  };
}

function describeMembers(ctx, nodes, where) {
  const out = [];
  const getters = new Set(
    (nodes ?? []).filter((n) => n.kind === SK.GetAccessor).map((n) => n.name.getText()),
  );
  for (const node of nodes ?? []) {
    // A getter already stands for the property; its setter adds nothing.
    if (node.kind === SK.SetAccessor && getters.has(node.name.getText())) continue;
    const member = describeMember(ctx, node, where);
    if (member) out.push(member);
  }
  return out;
}

/** The object-literal parts a type is built from: the `{ … }` operands of a
 *  top-level intersection or union, through any parentheses. */
function objectParts(type) {
  switch (type.kind) {
    case SK.TypeLiteral:
      return [type];
    case SK.ParenthesizedType:
      return objectParts(type.type);
    case SK.IntersectionType:
    case SK.UnionType:
      return [...type.types].flatMap(objectParts);
    default:
      return [];
  }
}

/** Kind, signature and members of one declaration; null for an unknown shape. */
function describeDeclaration(ctx, node, symbol, name) {
  const start = node.getStart();
  switch (node.kind) {
    case SK.FunctionDeclaration:
      return {
        kind: "function",
        sig: head(cut(node, start, node.body ? node.body.getStart() : node.getEnd())),
        overload: !node.body,
      };
    case SK.ClassDeclaration:
      return {
        kind: "class",
        sig: head(cut(node, start, bodyOpen(node))),
        members: describeMembers(ctx, node.members, name),
      };
    case SK.InterfaceDeclaration:
      return {
        kind: "interface",
        sig: head(cut(node, start, bodyOpen(node))),
        members: describeMembers(ctx, node.members, name),
      };
    case SK.TypeAliasDeclaration:
      if (node.type.kind === SK.TypeLiteral) {
        return {
          kind: "type",
          sig: head(cut(node, start, node.type.getStart())),
          members: describeMembers(ctx, node.type.members, name),
        };
      }
      {
        // `Base & { … }` or `{ … } | { … }`: the object parts are documented
        // member by member, like an interface. Their comments then live on the
        // members, so they are taken out of the signature.
        const members = objectParts(node.type).flatMap((part) =>
          describeMembers(ctx, part.members, name),
        );
        if (members.some((member) => member.doc)) {
          const seen = new Set();
          return {
            kind: "type",
            sig: head(cut(node))
              .replace(/[ \t]*\/\*\*[\s\S]*?\*\/[ \t]*\n?/g, "")
              .replace(/\n{2,}/g, "\n"),
            members: members.filter((member) => {
              // `blocks?: never` only rules a key out of one variant.
              if (/\?: never$/.test(member.sig)) return false;
              const key = `${member.name}\n${member.sig}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            }),
          };
        }
      }
      return { kind: "type", sig: head(cut(node)) };
    case SK.VariableDeclaration: {
      const init = node.initializer?.kind;
      const isFunction = init === SK.ArrowFunction || init === SK.FunctionExpression;
      const type = node.type ? cut(node.type).trim() : inferredType(ctx, symbol);
      return {
        kind: isFunction ? "function" : "const",
        sig: `const ${node.name.getText()}: ${type}`,
      };
    }
    case SK.EnumDeclaration:
      return {
        kind: "enum",
        sig: head(cut(node, start, bodyOpen(node))),
        members: describeMembers(ctx, node.members, name),
      };
    case SK.ModuleDeclaration:
      return { kind: "namespace", sig: `namespace ${node.name.getText()}` };
    default:
      return null;
  }
}

/* ── one export ─────────────────────────────────────────────────────────── */

const repoPath = (file) => relative(REPO, file).split("\\").join("/");

/** A file under the repo's own source: not a dependency, not a build output. */
function sourcePath(file) {
  const path = repoPath(file);
  if (path.startsWith("..") || path.includes("node_modules/") || path.includes("/dist/")) {
    return undefined;
  }
  return path;
}

function describeExport(ctx, exported) {
  const { checker } = ctx;
  const symbol =
    exported.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
  const name = exported.name;
  const nodes = symbol.declarations.map((handle) => handle.resolve()).filter(Boolean);
  if (!nodes.length) return null;

  const jsDocs = nodes.map(readJsDoc);
  if (jsDocs.some((docs) => docs.tags.some((tag) => tag.name === "internal"))) return null;

  let described = nodes
    .map((node) => describeDeclaration(ctx, node, symbol, name))
    .filter(Boolean);
  if (!described.length) return null;
  // Overloads: the implementation signature is not callable, so it is dropped.
  if (described.some((d) => d.overload)) described = described.filter((d) => d.overload !== false);

  const kind = KIND_ORDER.find((k) => described.some((d) => d.kind === k)) ?? described[0].kind;
  // `export { EditorApi as Editor }`: a reader imports `Editor`, so that is the
  // name the signature shows. The declared name is kept as an alias, so other
  // signatures that mention it still link here.
  const declared = symbol.name !== name && symbol.name !== "default" ? symbol.name : undefined;
  const rename = (sig) =>
    declared ? sig.replace(new RegExp(`\\b${declared}\\b`), name) : sig;
  const sigs = [...new Set(described.map((d) => rename(d.sig)))];
  const members = described.flatMap((d) => d.members ?? []);

  // The comment on the first declaration that has one; the checker's merged
  // text covers the rest (a comment inherited through an alias).
  let docs = jsDocs.find((d) => d.doc) ?? jsDocs[0];
  if (!docs.doc) {
    const inherited = symbol.getDocumentationComment(checker).trim();
    if (inherited) docs = { ...docs, doc: inherited };
  }

  const src = sourcePath(nodes[0].getSourceFile().fileName);

  return {
    id: symbol.id,
    row: {
      name,
      kind,
      sigs,
      ...docFields(docs, name, ctx.problems),
      ...(members.length ? { members } : {}),
      ...(src ? { src } : {}),
    },
    declared,
  };
}

/* ── one package ────────────────────────────────────────────────────────── */

function assertReady(slug, dir, pkg) {
  const needsDeps =
    Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies })
      .length > 0;
  if (needsDeps && !existsSync(join(dir, "node_modules"))) {
    throw new Error(
      `generate-api: packages/${slug} has no node_modules. Inferred types would differ ` +
        "from a full install, so run `npm ci` in every package first.",
    );
  }
  if (!existsSync(join(dir, "dist"))) {
    throw new Error(
      `generate-api: packages/${slug} is not built. Packages read their siblings' types ` +
        "from dist/, so run `bash packages/build-all.sh` first.",
    );
  }
}

function describePackage(api, slug, problems) {
  const dir = join(PACKAGES, slug);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assertReady(slug, dir, pkg);

  const config = join(dir, "tsconfig.json");
  const project = api.updateSnapshot({ openProjects: [config] }).getProject(config);
  if (!project) throw new Error(`generate-api: could not open ${repoPath(config)}.`);
  const ctx = { checker: project.checker, problems };

  /** name → row, across this package's entries; a name exported from two
   *  entries is one row that lists both. */
  const rows = new Map();
  /** declared name → exported name, for exports renamed on the way out. */
  const aliases = {};
  const entries = [];
  for (const entry of entriesOf(dir, pkg)) {
    const file = project.program.getSourceFile(entry.file);
    if (!file) throw new Error(`generate-api: ${repoPath(entry.file)} is not in its project.`);
    const module = project.checker.getSymbolAtLocation(file);
    const names = [];
    for (const exported of project.checker.getExportsOfModule(module)) {
      const described = describeExport(ctx, exported);
      if (!described) continue;
      let key = described.row.name;
      const seen = rows.get(key);
      if (seen && seen.id === described.id) {
        seen.row.from.push(entry.id);
        continue;
      }
      if (seen) {
        // Two entries use one name for different things (`MathNode` is a class
        // in @tasfer/math and a tree type in @tasfer/math/data). Both are
        // documented; the later one is addressed through its entry.
        key = `${entry.id.slice(pkg.name.length + 1)}/${key}`;
        described.row.anchor = key;
      }
      described.row.from = [entry.id];
      if (described.declared && !described.row.anchor) aliases[described.declared] = key;
      rows.set(key, described);
      names.push(key);
    }
    entries.push({ id: entry.id, names });
  }

  const byKindThenName = (a, b) =>
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
    a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
    (a.name < b.name ? -1 : 1);

  return {
    slug,
    name: pkg.name,
    description: pkg.description ?? "",
    // An alias never shadows a real export of the same name.
    aliases: Object.fromEntries(
      Object.entries(aliases)
        .filter(([declared]) => !rows.has(declared))
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    entries: entries.map((entry) => ({
      id: entry.id,
      symbols: entry.names.map((n) => rows.get(n).row).sort(byKindThenName),
    })),
  };
}

/* ── baseline rules ─────────────────────────────────────────────────────── */

function readBaseline() {
  if (!existsSync(BASELINE)) return null;
  return JSON.parse(readFileSync(BASELINE, "utf8"));
}

/** Applies the two rules and returns the baseline as it should now read. */
function applyRules(packages, baseline, version, problems) {
  const next = {
    version: baseline?.version ?? version,
    exports: {},
    undocumented: {},
  };
  for (const pkg of packages) {
    const rows = pkg.entries.flatMap((entry) => entry.symbols);
    const key = (row) => row.anchor ?? row.name;
    const names = rows.map(key).sort();
    const bare = rows.filter((row) => !row.doc).map(key).sort();

    if (!baseline || INIT_BASELINE) {
      next.exports[pkg.name] = names;
      if (bare.length) next.undocumented[pkg.name] = bare;
      continue;
    }

    const known = new Set(baseline.exports[pkg.name] ?? []);
    const tolerated = new Set(baseline.undocumented[pkg.name] ?? []);
    for (const row of rows) {
      if (!row.doc && !tolerated.has(key(row))) {
        problems.push(`${pkg.name}: "${key(row)}" has no doc comment.`);
      }
      if (!known.has(key(row)) && !row.since) {
        problems.push(
          `${pkg.name}: "${key(row)}" is a new export. Say when it arrives: add \`@since <version>\` to its doc comment.`,
        );
      }
    }
    // Exports that left the API drop out; documented ones leave the tolerated list.
    next.exports[pkg.name] = names.filter((n) => known.has(n));
    const stillBare = bare.filter((n) => tolerated.has(n));
    if (stillBare.length) next.undocumented[pkg.name] = stillBare;
  }
  if (INIT_BASELINE) next.version = version;
  return next;
}

/* ── output ─────────────────────────────────────────────────────────────── */

const serialize = (value) => JSON.stringify(value, null, 1) + "\n";

function main() {
  const version = packagesVersion();
  const problems = [];
  const api = new API({ cwd: REPO });
  let packages;
  try {
    packages = publishedPackages().map((slug) => describePackage(api, slug, problems));
  } finally {
    api.close();
  }

  const baseline = applyRules(packages, readBaseline(), version, problems);

  /** path → content, for everything this script owns. */
  const files = new Map();
  // On its own so the sidebar can show the version without loading the index.
  files.set(join(OUT, "meta.json"), serialize({ version }));
  files.set(
    join(OUT, "index.json"),
    serialize({
      version,
      packages: packages.map((pkg) => ({
        slug: pkg.slug,
        name: pkg.name,
        description: pkg.description,
        entries: pkg.entries.map((entry) => entry.id),
        // Every name the page can link to, so a mention of one package's type
        // inside another package's docs resolves without loading both.
        names: pkg.entries
          .flatMap((entry) => entry.symbols.filter((row) => !row.anchor).map((row) => row.name))
          .sort(),
        aliases: pkg.aliases,
      })),
    }),
  );
  for (const pkg of packages) {
    files.set(
      join(OUT, `${pkg.slug}.json`),
      serialize({ name: pkg.name, entries: pkg.entries }),
    );
  }
  files.set(BASELINE, serialize(baseline));

  const total = packages.reduce(
    (n, pkg) => n + pkg.entries.reduce((m, entry) => m + entry.symbols.length, 0),
    0,
  );
  const bare = Object.values(baseline.undocumented).reduce((n, list) => n + list.length, 0);

  const stale = [...files].filter(
    ([path, content]) => !existsSync(path) || readFileSync(path, "utf8") !== content,
  );
  const strays = existsSync(OUT)
    ? readdirSync(OUT)
        .map((name) => join(OUT, name))
        .filter((path) => !files.has(path))
    : [];
  if (CHECK) {
    for (const [path] of stale) problems.push(`${repoPath(path)} is out of date.`);
    for (const path of strays) problems.push(`${repoPath(path)} is no longer generated.`);
    if (stale.length || strays.length) {
      problems.push("Run `npm run api` in apps/site and commit the result.");
    }
  } else {
    // Only what changed is touched, so a running dev server reloads just that.
    mkdirSync(OUT, { recursive: true });
    for (const [path, content] of stale) writeFileSync(path, content);
    for (const path of strays) rmSync(path);
  }

  if (problems.length) {
    console.error(`generate-api: ${problems.length} problem(s)\n`);
    for (const problem of problems) console.error(`  • ${problem}`);
    process.exit(1);
  }
  console.log(
    `generate-api: ${total} exports across ${packages.length} packages at v${version}` +
      (bare ? `, ${bare} still without a doc comment` : "") +
      (CHECK ? " — up to date." : "."),
  );
}

main();
