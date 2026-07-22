// Generates apps/web/public/THIRD-PARTY-LICENSES.txt — the aggregated
// attribution notices for every third-party component bundled into the deployed
// Tasfer app. The app is AGPL, but the permissive (MIT/BSD/ISC/…) dependencies
// it bundles still require their copyright + license notices to be reproduced in
// distributions; this file satisfies that obligation in one place.
//
// What it covers: the production dependency trees of apps/web AND of the
// @tasfer/* packages it bundles from source via Vite aliases (editor, tex,
// react) — because those are compiled into the same bundle, their runtime deps
// (e.g. lowlight, defuddle) ship too but do NOT appear in apps/web's own tree.
// It also embeds @tasfer/tex's NOTICE, since the KaTeX material it vendors is
// shipped as source (a devDependency of tex, so it never shows up in a
// --omit=dev dependency walk).
//
// Run via `npm run gen:licenses` (also wired into `prebuild`). Over-inclusion is
// intentional and harmless: attributing a dependency that doesn't reach the
// browser is safe; omitting one that does is not.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const repoRoot = resolve(webRoot, "..", "..");

// Roots whose production dependency trees are bundled into the shipped app.
const ROOTS = [
  webRoot,
  join(repoRoot, "packages", "editor"),
  join(repoRoot, "packages", "tex"),
  join(repoRoot, "packages", "react"),
];

const OUT = join(webRoot, "public", "THIRD-PARTY-LICENSES.txt");

// First-party scopes/packages — our own code, not third-party attribution.
const FIRST_PARTY = /^(@tasfer\/|@tasfer\/|@tasfer-examples\/|tasfer(-|$))/;

// Type declarations and the TypeScript compiler can appear in `npm ls` through
// peer dependency edges even with `--omit=dev`; none are shipped in the app.
const TYPE_ONLY = /^(@types\/|typescript$)/;

/** Run `npm ls` for a root, returning the parsed tree (or null on failure). */
function npmTree(cwd) {
  let out;
  try {
    // `shell: true` is required on Windows, where npm is a `npm.cmd` shim that
    // Node refuses to spawn directly (EINVAL) since the CVE-2024-27980 fix; the
    // shell also resolves it via PATHEXT. The args are fixed literals with no
    // shell metacharacters, so there is nothing to quote or inject.
    out = execFileSync(
      "npm",
      ["ls", "--omit=dev", "--all", "--long", "--json"],
      { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, shell: true },
    );
  } catch (err) {
    // `npm ls` exits non-zero on peer/optional warnings but still prints JSON.
    out = err.stdout;
  }
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Collect every unique third-party package across all roots. */
function collect() {
  const pkgs = new Map(); // name@version -> { name, version, path, license }
  for (const root of ROOTS) {
    // If a root isn't installed there's nothing to read — skip it. But if it IS
    // installed and the tree still won't parse, fail closed rather than
    // overwrite the committed file with a silently-incomplete list.
    if (!existsSync(join(root, "node_modules"))) {
      console.warn(`warn: ${root} has no node_modules — skipping`);
      continue;
    }
    const tree = npmTree(root);
    if (!tree) {
      throw new Error(`could not read dependency tree for installed root ${root}`);
    }
    const walk = (deps) => {
      if (!deps) return;
      for (const [name, info] of Object.entries(deps)) {
        if (TYPE_ONLY.test(name)) continue;
        if (info.version && !FIRST_PARTY.test(name)) {
          const key = `${name}@${info.version}`;
          if (!pkgs.has(key)) {
            pkgs.set(key, {
              name,
              version: info.version,
              path: info.path,
              license: normalizeLicense(info.license),
            });
          }
        }
        walk(info.dependencies);
      }
    };
    walk(tree.dependencies);
  }
  return [...pkgs.values()].sort(
    (a, b) =>
      a.name.localeCompare(b.name, "en") || a.version.localeCompare(b.version),
  );
}

function normalizeLicense(license) {
  if (!license) return "UNKNOWN";
  if (typeof license === "string") return license;
  if (license.type) return license.type; // legacy { type, url }
  return "UNKNOWN";
}

/** Read the license/notice text bundled with a package, if any. */
function licenseText(pkg) {
  if (!pkg.path || !existsSync(pkg.path)) return null;
  let entries;
  try {
    entries = readdirSync(pkg.path);
  } catch {
    return null;
  }
  const files = entries
    .filter((f) => /^(licen[sc]e|copying|notice)/i.test(f))
    .sort();
  if (files.length === 0) return null;
  const chunks = [];
  for (const f of files) {
    try {
      const text = readFileSync(join(pkg.path, f), "utf8")
        .replace(/\r\n?/g, "\n")
        .replace(/[ \t]+$/gm, "")
        .trim();
      if (text) chunks.push(text);
    } catch {
      /* unreadable — skip */
    }
  }
  return chunks.length ? chunks.join("\n\n") : null;
}

function vendoredNotices() {
  // KaTeX ships as vendored source inside @tasfer/tex (a devDependency there,
  // so it is invisible to a production dependency walk) but is bundled into the
  // app — pull its NOTICE in verbatim.
  const texNotice = join(repoRoot, "packages", "tex", "NOTICE");
  if (!existsSync(texNotice)) return [];
  return [
    {
      heading: "@tasfer/tex — bundled KaTeX material",
      body: readFileSync(texNotice, "utf8").trim(),
    },
  ];
}

function build() {
  const pkgs = collect();
  const sep = "=".repeat(78);
  const lines = [];

  lines.push("THIRD-PARTY LICENSES");
  lines.push("");
  lines.push(
    "Tasfer itself is licensed under the GNU AGPL-3.0-or-later (see LICENSE).",
  );
  lines.push(
    "The app bundles the third-party components listed below, each under its own",
  );
  lines.push(
    "license. Their copyright and permission notices are reproduced here as those",
  );
  lines.push(
    "licenses require. This file is generated — do not edit by hand; run",
  );
  lines.push("`npm run gen:licenses` from apps/web to regenerate it.");
  lines.push("");

  for (const v of vendoredNotices()) {
    lines.push(sep);
    lines.push(v.heading);
    lines.push(sep);
    lines.push("");
    lines.push(v.body);
    lines.push("");
  }

  let withText = 0;
  for (const pkg of pkgs) {
    lines.push(sep);
    lines.push(`${pkg.name}@${pkg.version}  (${pkg.license})`);
    lines.push(sep);
    lines.push("");
    const text = licenseText(pkg);
    if (text) {
      withText++;
      lines.push(text);
    } else {
      lines.push(
        `Licensed under ${pkg.license}. No license text file was bundled with` +
          ` this package; see the SPDX identifier above for the full terms.`,
      );
    }
    lines.push("");
  }

  writeFileSync(OUT, lines.join("\n"), "utf8");
  console.log(
    `Wrote ${OUT}\n  ${pkgs.length} third-party packages` +
      ` (${withText} with bundled license text, ${pkgs.length - withText} by SPDX id)`,
  );
}

build();
