// Build the spelling catalogue: every Hunspell dictionary Tasfer offers.
//
// Tasfer does not host these files. A language's `.dic` and `.aff` are fetched
// straight from the npm package that publishes them, over a public CDN, the
// first time someone writes in that language. The alternative — mirroring them
// under public/ — is ~300 MB of build output that every deploy would upload
// and every native bundle would have to strip. What the repository holds is
// the metadata needed to *offer* a language, plus the licence notices, both
// committed:
//
//   src/spell/catalog.json                  the list Settings shows
//   scripts/spell-catalog-notices.json      notices, deduplicated
//
// The metadata must be committed because "Add languages" lists ninety
// languages before a byte is downloaded, offline and on every platform; only
// the dictionary itself needs the network, and only once per device.
//
// This script downloads each package once to measure it and to read its
// notice, then throws the bytes away. An entry already in catalog.json at the
// same version is skipped, so a second run costs nothing and a build never
// touches the network unless a version was bumped by hand.
//
// `en` and `ar` are not fetched here: they are vendored under
// public/app/spell/<id>/, ship inside every bundle and check spelling from a
// cold, offline install. Arabic has no npm package at all — Ayaspell was
// packaged by hand.
//
// Usage:
//   node scripts/gen-spell-catalog.mjs           # fill in what is missing
//   node scripts/gen-spell-catalog.mjs --force   # re-measure everything
//
// Set TASFER_SKIP_SPELL_CATALOG=1 to make this a no-op offline.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const vendoredDir = resolve(webRoot, "public/app/spell");
const catalogJson = resolve(webRoot, "src/spell/catalog.json");
const noticesJson = resolve(here, "spell-catalog-notices.json");

/**
 * Dictionaries vendored in the repository. Committed bytes under
 * public/app/spell/<id>/, so they are inside every bundle and check spelling
 * from a cold, offline install with no network at all.
 */
const VENDORED = [
  { id: "en", license: "MIT AND BSD" },
  { id: "ar", license: "LGPL-2.1" },
];

/**
 * The upstream set: github.com/wooorm/dictionaries, published one npm package
 * per locale as `dictionary-<id lowercased>`. Listed here rather than fetched
 * so a build is reproducible and a new locale is a reviewed diff — upstream
 * adding a language should not silently change what Tasfer offers.
 *
 * Arabic is absent upstream, which is why `ar` is vendored.
 */
const UPSTREAM = [
  "bg", "br", "ca", "ca-valencia", "cs", "cy", "da", "de", "de-AT", "de-CH",
  "el", "el-polyton", "en-AU", "en-CA", "en-GB", "en-ZA", "eo", "es", "es-AR",
  "es-BO", "es-CL", "es-CO", "es-CR", "es-CU", "es-DO", "es-EC", "es-GT",
  "es-HN", "es-MX", "es-NI", "es-PA", "es-PE", "es-PH", "es-PR", "es-PY",
  "es-SV", "es-US", "es-UY", "es-VE", "et", "eu", "fa", "fo", "fr", "fur",
  "fy", "ga", "gd", "gl", "he", "hr", "hu", "hy", "hyw", "ia", "ie", "is",
  "it", "ka", "ko", "la", "lb", "lt", "ltg", "lv", "mk", "mn", "nb", "nds",
  "ne", "nl", "nn", "oc", "pl", "pt", "pt-PT", "ro", "ru", "rw", "sk", "sl",
  "sr", "sr-Latn", "sv", "sv-FI", "tk", "tlh", "tlh-Latn", "tr", "uk", "vi",
];

const force = process.argv.includes("--force");

if (process.env.TASFER_SKIP_SPELL_CATALOG === "1") {
  console.log("[gen-spell-catalog] TASFER_SKIP_SPELL_CATALOG=1, skipping");
  process.exit(0);
}

/** Arabic-script code points, mirroring packages/spell/src/script.ts. */
function isArabicCodePoint(cp) {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x08a0 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

/**
 * Which engine bucket a dictionary answers for, read off its own entries
 * rather than a hand-kept table: the worker routes a token to the engines
 * whose `script` matches, so this must agree with `scriptOf` on real words.
 * Serbian ships in both Cyrillic and Latin, and a table would drift.
 */
function scriptOfDic(dic) {
  const lines = dic.split("\n").slice(1, 4000);
  let arab = 0;
  let latn = 0;
  let other = 0;
  for (const line of lines) {
    const word = line.split("/")[0].trim();
    if (!word) continue;
    for (const ch of word) {
      const cp = ch.codePointAt(0);
      if (!/\p{L}/u.test(ch)) continue;
      if (isArabicCodePoint(cp)) arab++;
      else if (/\p{Script=Latin}/u.test(ch)) latn++;
      else other++;
      break;
    }
  }
  if (arab > latn && arab > other) return "arab";
  if (latn >= other) return "latn";
  return "other";
}

/**
 * What the fetch actually costs. Brotli, not gzip: the CDN negotiates `br`
 * with every browser Tasfer targets, and the figure is shown to someone
 * deciding whether to add a language.
 */
function wireSize(...buffers) {
  return buffers.reduce((n, b) => n + brotliCompressSync(b).length, 0);
}

async function registry(pkg) {
  const res = await fetch(`https://registry.npmjs.org/${pkg}`);
  if (!res.ok) throw new Error(`${pkg}: registry said ${res.status}`);
  const json = await res.json();
  const version = json["dist-tags"]?.latest;
  const meta = json.versions?.[version];
  if (!meta) throw new Error(`${pkg}: no latest version`);
  return { version, license: meta.license, tarball: meta.dist.tarball };
}

/** Unpack an npm tarball into a scratch directory and return its package root. */
function unpack(tgz, id) {
  const dir = mkdtempSync(join(tmpdir(), `tasfer-spell-${id}-`));
  const file = join(dir, "package.tgz");
  writeFileSync(file, tgz);
  execFileSync("tar", ["-xzf", file, "-C", dir]);
  return { dir, pkg: join(dir, "package") };
}

/**
 * Measure one language and read its notice. The package is unpacked into a
 * scratch directory and deleted again: the app fetches these files from the
 * CDN, so there is nothing to keep.
 */
async function inspect(id) {
  const pkg = `dictionary-${id.toLowerCase()}`;
  const { version, license, tarball } = await registry(pkg);
  const res = await fetch(tarball);
  if (!res.ok) throw new Error(`${pkg}: tarball said ${res.status}`);
  const { dir, pkg: root } = unpack(Buffer.from(await res.arrayBuffer()), id);
  try {
    const aff = readFileSync(join(root, "index.aff"));
    const dic = readFileSync(join(root, "index.dic"));
    const notices = [];
    for (const name of readdirSync(root)) {
      if (!/^(licen[cs]e|copying|readme|authors)/i.test(name)) continue;
      const text = readFileSync(join(root, name), "utf8")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim();
      if (text) notices.push(text);
    }
    if (notices.length === 0) throw new Error(`${pkg}: no notice files`);
    return {
      entry: {
        kind: "catalog",
        id,
        pkg,
        version,
        license,
        script: scriptOfDic(dic.toString("utf8")),
        sizeBytes: aff.length + dic.length,
        wireSizeBytes: wireSize(aff, dic),
      },
      notices,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Measure a vendored dictionary from the files committed beside it. `cached`
 * short-circuits it: Arabic is 7 MB, and brotli-compressing it on every build
 * to rediscover a number already in the catalogue costs seconds for nothing.
 * The byte count comes from the directory entries, so an edited file is still
 * measured properly.
 */
function inspectVendored(id, license, cached) {
  const dir = join(vendoredDir, id);
  const affPath = join(dir, "index.aff.txt");
  const dicPath = join(dir, "index.dic.txt");
  if (!existsSync(dicPath)) {
    throw new Error(`[gen-spell-catalog] missing vendored dictionary ${dir}`);
  }
  const sizeBytes = statSync(affPath).size + statSync(dicPath).size;
  if (!force && cached?.sizeBytes === sizeBytes && cached.wireSizeBytes > 0) {
    return { ...cached, license };
  }
  const aff = readFileSync(affPath);
  const dic = readFileSync(dicPath);
  return {
    kind: "vendored",
    id,
    license,
    script: scriptOfDic(dic.toString("utf8")),
    sizeBytes: aff.length + dic.length,
    wireSizeBytes: wireSize(aff, dic),
  };
}

const previous = existsSync(catalogJson)
  ? JSON.parse(readFileSync(catalogJson, "utf8"))
  : { dictionaries: [] };
const known = new Map(previous.dictionaries.map((d) => [d.id, d]));
const previousNotices = existsSync(noticesJson)
  ? JSON.parse(readFileSync(noticesJson, "utf8"))
  : { texts: [], byId: {} };

const entries = [];
// Notice bodies are shared: most of these dictionaries carry the same GPL or
// MPL text, and storing it once per language would be megabytes of duplicate.
const texts = [];
const textIndex = new Map();
const byId = {};

function intern(text) {
  let at = textIndex.get(text);
  if (at === undefined) {
    at = texts.push(text) - 1;
    textIndex.set(text, at);
  }
  return at;
}

for (const { id, license } of VENDORED) {
  entries.push(inspectVendored(id, license, known.get(id)));
}

const failures = [];
let fetched = 0;
for (const id of UPSTREAM) {
  const cached = known.get(id);
  const cachedNotices = previousNotices.byId[id];
  // A version bump is the only thing that changes these numbers, and the
  // version is written down, so a warm catalogue needs no network at all.
  if (!force && cached?.version && cachedNotices) {
    entries.push(cached);
    byId[id] = cachedNotices.map((at) => intern(previousNotices.texts[at]));
    continue;
  }
  try {
    const { entry, notices } = await inspect(id);
    entries.push(entry);
    byId[id] = notices.map(intern);
    fetched++;
    process.stdout.write(`\r[gen-spell-catalog] measured ${fetched} `);
  } catch (err) {
    failures.push(`${id}: ${err.message}`);
  }
}

// Sorted by id so the committed files have a stable diff; Settings sorts by
// the display name in the reader's own language, which this cannot know.
entries.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

writeFileSync(
  catalogJson,
  `${JSON.stringify(
    {
      $comment:
        "Generated by scripts/gen-spell-catalog.mjs — do not edit by hand.",
      source: "https://github.com/wooorm/dictionaries (npm: dictionary-<id>)",
      dictionaries: entries,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  noticesJson,
  `${JSON.stringify(
    {
      $comment:
        "Licence notices for the catalogue dictionaries, deduplicated." +
        " Generated by scripts/gen-spell-catalog.mjs; read by" +
        " scripts/gen-third-party-licenses.mjs.",
      texts,
      byId,
    },
    null,
    2,
  )}\n`,
);

const wire = entries
  .filter((d) => d.kind === "catalog")
  .reduce((n, d) => n + d.wireSizeBytes, 0);
console.log(
  `\n[gen-spell-catalog] ${entries.length} dictionaries ` +
    `(${VENDORED.length} vendored, ${entries.length - VENDORED.length} from the CDN, ` +
    `${(wire / 1e6).toFixed(0)} MB of downloads across all of them), ` +
    `${texts.length} distinct notices, ${fetched} measured now`,
);
if (failures.length > 0) {
  console.error(`[gen-spell-catalog] ${failures.length} failed:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
