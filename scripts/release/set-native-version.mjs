#!/usr/bin/env node
// Stamp the app version onto the iOS and Android projects in one shot, so the
// mobile stores always ship the same version as the desktop release.
//
// Usage:
//   node scripts/release/set-native-version.mjs          use apps/desktop's version
//   node scripts/release/set-native-version.mjs 0.2.0    set an explicit version
//
// The version name defaults to apps/desktop/package.json (the version
// release-please last released as v<version>). The build number (iOS
// CURRENT_PROJECT_VERSION / Android versionCode) is a single monotonic integer
// = max(iOS, Android) + 1, which also self-heals any drift between the two.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gradlePath = resolve(root, "apps/android/app/build.gradle");
const pbxPath = resolve(root, "apps/ios/App/App.xcodeproj/project.pbxproj");

let gradle = readFileSync(gradlePath, "utf8");
let pbx = readFileSync(pbxPath, "utf8");

const androidCode = parseInt(gradle.match(/versionCode\s+(\d+)/)?.[1] ?? "0", 10);
const iosBuild = parseInt(pbx.match(/CURRENT_PROJECT_VERSION\s*=\s*(\d+);/)?.[1] ?? "0", 10);

const arg = process.argv[2];
let newName;
if (arg) {
  if (!/^\d+\.\d+(\.\d+)?$/.test(arg)) {
    console.error(`set-native-version: invalid version "${arg}". Use X.Y[.Z].`);
    process.exit(1);
  }
  newName = arg;
} else {
  const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
  newName = desktop.version;
}

const newBuild = Math.max(androidCode, iosBuild) + 1;

gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${newBuild}`);
gradle = gradle.replace(/versionName\s+"[^"]+"/, `versionName "${newName}"`);
pbx = pbx.replaceAll(/MARKETING_VERSION = [0-9.]+;/g, `MARKETING_VERSION = ${newName};`);
pbx = pbx.replaceAll(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${newBuild};`);

writeFileSync(gradlePath, gradle);
writeFileSync(pbxPath, pbx);

console.log(`set-native-version: iOS + Android -> ${newName} (build ${newBuild})`);
