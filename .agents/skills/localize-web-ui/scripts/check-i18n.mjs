#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultAppRoot = resolve(scriptDir, "../../..");
const appRoot = resolve(process.argv[2] ?? defaultAppRoot);
const localesRoot = join(appRoot, "public/app/locales");
const sourceExtensions = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const pluralSuffix = /_(zero|one|two|few|many|other)$/;
const expectedPluralCategories = {
  en: new Set(new Intl.PluralRules("en").resolvedOptions().pluralCategories),
  ar: new Set(new Intl.PluralRules("ar").resolvedOptions().pluralCategories),
};

async function loadCatalog(locale) {
  const path = join(localesRoot, locale, "translation.json");
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`${path} must contain a JSON object`);
  }
  return parsed;
}

function variables(value) {
  if (typeof value !== "string") return [];
  return [...value.matchAll(/\{\{\s*(-?[\w.]+)(?:\s*,[^}]*)?\s*\}\}/g)]
    .map((match) => match[1])
    .sort();
}

function pluralGroups(catalog) {
  const groups = new Map();
  for (const [key, value] of Object.entries(catalog)) {
    const match = key.match(pluralSuffix);
    if (!match) continue;
    const base = key.slice(0, -match[0].length);
    const group = groups.get(base) ?? new Map();
    group.set(match[1], value);
    groups.set(base, group);
  }
  return groups;
}

function sameItems(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

async function sourceFiles(root) {
  const found = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".skills") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(path)));
    else if (sourceExtensions.has(extname(entry.name))) found.push(path);
  }
  return found;
}

function literalTranslationKeys(source) {
  const keys = new Set();
  const callPattern = /\b(?:t|i18next\.t)\s*\(\s*(["'`])([^"'`$]+)\1/g;
  for (const match of source.matchAll(callPattern)) keys.add(match[2]);
  return keys;
}

const errors = [];
const warnings = [];

try {
  const [en, ar] = await Promise.all([loadCatalog("en"), loadCatalog("ar")]);
  const catalogs = { en, ar };
  const groups = { en: pluralGroups(en), ar: pluralGroups(ar) };
  const pluralBases = new Set([...groups.en.keys(), ...groups.ar.keys()]);

  for (const locale of ["en", "ar"]) {
    const other = locale === "en" ? "ar" : "en";
    for (const key of Object.keys(catalogs[locale])) {
      if (key in catalogs[other] || key.match(pluralSuffix)) continue;
      errors.push(`${other} is missing key: ${key}`);
    }
  }

  for (const base of [...pluralBases].sort()) {
    for (const locale of ["en", "ar"]) {
      const group = groups[locale].get(base);
      if (!group) {
        errors.push(`${locale} is missing plural group: ${base}`);
        continue;
      }
      for (const category of expectedPluralCategories[locale]) {
        if (!group.has(category)) errors.push(`${locale} is missing plural key: ${base}_${category}`);
      }
    }

    const enVars = [...new Set([...(groups.en.get(base)?.values() ?? [])].flatMap(variables))].sort();
    const arVars = [...new Set([...(groups.ar.get(base)?.values() ?? [])].flatMap(variables))].sort();
    if (!sameItems(enVars, arVars)) {
      errors.push(`plural variables differ for ${base}: en=[${enVars}] ar=[${arVars}]`);
    }
  }

  for (const key of Object.keys(en).filter((key) => key in ar && !key.match(pluralSuffix)).sort()) {
    const enVars = variables(en[key]);
    const arVars = variables(ar[key]);
    if (!sameItems(enVars, arVars)) {
      errors.push(`variables differ for ${key}: en=[${enVars}] ar=[${arVars}]`);
    }
  }

  const usedKeys = new Set();
  for (const root of [join(appRoot, "src"), join(appRoot, "scripts")]) {
    for (const path of await sourceFiles(root)) {
      const source = await readFile(path, "utf8");
      for (const key of literalTranslationKeys(source)) usedKeys.add(key);
    }
  }
  for (const key of [...usedKeys].sort()) {
    if (!(key in en) && !groups.en.has(key)) errors.push(`source uses key missing from en: ${key}`);
  }

  const unused = Object.keys(en).filter((key) => !key.match(pluralSuffix) && !usedKeys.has(key));
  if (unused.length) warnings.push(`${unused.length} English keys were not found as literal t() calls (dynamic/native use may be valid)`);

  for (const warning of warnings) console.warn(`warning: ${warning}`);
  if (errors.length) {
    for (const error of errors) console.error(`error: ${error}`);
    console.error(`i18n check failed with ${errors.length} error(s)`);
    process.exitCode = 1;
  } else {
    console.log(`i18n check passed: ${Object.keys(en).length} English keys, ${Object.keys(ar).length} Arabic keys, ${usedKeys.size} literal source keys`);
  }
} catch (error) {
  console.error(`i18n check could not run: ${error.message}`);
  process.exitCode = 1;
}
