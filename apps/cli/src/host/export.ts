/**
 * `tasfer export` — write the spaces this host holds to a zip.
 *
 * The same archive the app's **Export all** produces, from a machine with no
 * app: a folder per space, a markdown file per page, and one `images/` folder
 * the pages link into. It is the portable copy — readable without Tasfer,
 * importable back into any space — as opposed to the data directory, which is
 * the exact one.
 *
 * The walk itself lives in `@/lib/spaceExport` so that the layout a host
 * writes and the layout a browser tab writes cannot drift; only the reads
 * differ, and both back onto the same engine.
 */

import { writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import JSZip from "jszip";

import { buildSpaceExport } from "@/lib/spaceExport";
import { CliError } from "../cli/args";
import { t } from "../cli/messages";
import { openHost, type HostOptions } from "./runtime";

export interface ExportOptions {
  /** Where to write the archive. A directory is not accepted; this is a file. */
  out?: string;
  /** Limit the export to one space, by id or by name. */
  space?: string;
}

/** `tasfer-export-2026-08-25.zip` — dated, because these accumulate. */
function defaultFileName(): string {
  return `tasfer-export-${new Date().toISOString().slice(0, 10)}.zip`;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export async function exportSpaces(
  hostOptions: HostOptions,
  { out, space }: ExportOptions,
): Promise<number> {
  const target = resolve(out ?? defaultFileName());
  const host = await openHost(hostOptions);

  try {
    const all = await host.engine.spaces.list();
    if (all.length === 0) throw new CliError("export.nothingToExport");

    const wanted = space
      ? all.filter((s) => s.id === space || s.name === space)
      : all;
    if (wanted.length === 0) {
      throw new CliError("export.unknownSpace", { space: space ?? "" });
    }

    console.log(
      t("export.collecting", {
        spaces: t("host.spaceCount", { count: wanted.length }),
      }),
    );

    // A count-up on one line while it works; a scrollback of progress lines in
    // a log file is not worth the noise, so this only draws to a terminal.
    const draw = process.stdout.isTTY
      ? ({ done, total }: { done: number; total: number }) => {
          process.stdout.write(`\r${t("export.progress", { done, total })}`);
        }
      : undefined;

    const entries = await buildSpaceExport({
      spaces: wanted.map((s) => ({ id: s.id, name: s.name })),
      source: {
        listPages: (spaceId, parentId) =>
          host.engine.pages.list(spaceId, parentId, { includeTasks: true }),
        getPage: (id) => host.engine.pages.get(id),
        // Nothing is replicating here, so an asset this host never received is
        // simply missing: the page keeps its original reference rather than
        // pointing at a file the archive does not carry.
        fetchAsset: (ref) => host.engine.assets.getBytes(ref),
      },
      onProgress: draw,
    });
    if (draw) process.stdout.write("\r\x1b[K");

    const zip = new JSZip();
    for (const entry of entries) zip.file(entry.path, entry.data);
    const archive = await zip.generateAsync({ type: "nodebuffer" });

    writeFileSync(target, archive);
    console.log(
      t("export.done", {
        path: target,
        pages: t("host.pageCount", {
          count: entries.filter((e) => e.path.endsWith(".md")).length,
        }),
        size: humanSize(archive.length),
      }),
    );
    return 0;
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new CliError("export.failed", {
      name: basename(target),
      reason: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await host.close();
  }
}
