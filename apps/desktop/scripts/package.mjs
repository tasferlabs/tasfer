#!/usr/bin/env node
// Run electron-builder with the app version from /version.json.
//
// package.json keeps a `version` because npm and electron-builder both require
// one, but it is not what ships: `extraMetadata.version` overwrites it inside
// the packaged app, so the build — and the app-update.yml feed electron-updater
// reads — always carries the central version. Passing it here rather than in a
// shell substitution keeps `npm run package:win` working on Windows too.
//
// Extra flags are forwarded:  npm run package -- --mac --publish always
import { spawnSync } from "node:child_process";
import { appVersion } from "../../../scripts/release/app-version.mjs";

const result = spawnSync(
  "npx",
  ["electron-builder", `--config.extraMetadata.version=${appVersion()}`, ...process.argv.slice(2)],
  { stdio: "inherit", shell: process.platform === "win32" },
);

process.exit(result.status ?? 1);
