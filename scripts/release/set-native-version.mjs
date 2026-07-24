#!/usr/bin/env node
// Stamp the app version onto the iOS and Android projects in one shot, so the
// mobile stores always ship the same version as the desktop release.
//
// Usage:
//   node scripts/release/set-native-version.mjs          use apps/desktop's version
//   node scripts/release/set-native-version.mjs 0.2.0    set an explicit version
//
// The version name defaults to apps/desktop/package.json (the version
// release-please last released as v<version>). iOS gets a monotonically
// increasing build number; Android derives versionCode from the semver.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const gradlePath = resolve(root, "apps/android/app/build.gradle");
const pbxPath = resolve(root, "apps/ios/App/App.xcodeproj/project.pbxproj");

let gradle = readFileSync(gradlePath, "utf8");
let pbx = readFileSync(pbxPath, "utf8");

const iosBuildMatch = pbx.match(/CURRENT_PROJECT_VERSION\s*=\s*(\d+);/);
if (!iosBuildMatch) {
  throw new Error("set-native-version: could not read the current iOS build number");
}
const iosBuild = parseInt(iosBuildMatch[1], 10);

const arg = process.argv[2];
let newName;
if (arg) {
  if (!/^\d+\.\d+\.\d+$/.test(arg)) {
    console.error(`set-native-version: invalid version "${arg}". Use X.Y.Z.`);
    process.exit(1);
  }
  newName = arg;
} else {
  const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
  newName = desktop.version;
}

const newBuild = iosBuild + 1;

const gradleVersionPattern = /def tasferVersionName\s*=\s*"[^"]+"/;
if (!gradleVersionPattern.test(gradle)) {
  throw new Error("set-native-version: could not find tasferVersionName in build.gradle");
}
gradle = gradle.replace(
  gradleVersionPattern,
  `def tasferVersionName = "${newName}"`,
);
const originalPbx = pbx;
pbx = pbx.replaceAll(/MARKETING_VERSION = [0-9.]+;/g, `MARKETING_VERSION = ${newName};`);
pbx = pbx.replaceAll(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${newBuild};`);
if (pbx === originalPbx) {
  throw new Error("set-native-version: could not update the iOS Xcode project");
}

writeFileSync(gradlePath, gradle);
writeFileSync(pbxPath, pbx);

console.log(`set-native-version: iOS + Android -> ${newName} (iOS build ${newBuild})`);
