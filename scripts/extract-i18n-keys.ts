import { readdir, readFile } from "fs/promises";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "../apps/web/src");

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield path;
  }
}

// Pattern 1: t("key"), t('key'), i18next.t("key"), i18next.t('key')
const T_CALL = /(?:^|[^a-zA-Z_.])t\(\s*["']([^"']+)["']/g;
// Pattern 2: t`key` (tagged template literal)
const T_TAGGED = /(?:^|[^a-zA-Z_.])t`([^`]+)`/g;

function addKey(keys: Map<string, string[]>, key: string, rel: string) {
  if (!keys.has(key)) keys.set(key, []);
  if (!keys.get(key)!.includes(rel)) keys.get(key)!.push(rel);
}

async function main() {
  const keys = new Map<string, string[]>();

  for await (const file of walk(SRC_DIR)) {
    const content = await readFile(file, "utf-8");
    const rel = relative(SRC_DIR, file);

    let match: RegExpExecArray | null;

    T_CALL.lastIndex = 0;
    while ((match = T_CALL.exec(content)) !== null) {
      addKey(keys, match[1], rel);
    }

    T_TAGGED.lastIndex = 0;
    while ((match = T_TAGGED.exec(content)) !== null) {
      addKey(keys, match[1], rel);
    }
  }

  const sorted = [...keys.entries()].sort(([a], [b]) => a.localeCompare(b));

  console.log(`Found ${sorted.length} unique translation keys:\n`);
  for (const [key, files] of sorted) {
    console.log(`  "${key}"`);
    for (const f of files) console.log(`    <- ${f}`);
  }

  // Output JSON mapping
  console.log("\n--- JSON (copy for translation file) ---\n");
  const json: Record<string, string> = {};
  for (const [key] of sorted) json[key] = key;
  console.log(JSON.stringify(json, null, 2));
}

main();
