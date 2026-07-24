#!/usr/bin/env node
// Generates the App Store screenshots from a deterministic local Tasfer run.
// It never uses the production/beta site or a personal browser profile.

import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const require = createRequire(join(repo, "brand", "package.json"));
const sharp = require("sharp");

const webRoot = join(repo, "apps", "web");
const sourceDir = join(webRoot, "public", "screenshots");
const outputDir = join(repo, "fastlane", "screenshots", "en-US");
const seedScript = join(webRoot, "scripts", "seed-shoot.mjs");
const rawDir = "/tmp/tasfer-app-store-raw";
const baseUrl = process.env.URL || "http://localhost:4000";
const skipCapture = process.argv.includes("--skip-capture");

const escapeXml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const run = (command, args, options = {}) =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) resolveRun();
      else rejectRun(new Error(`${command} exited with code ${code}`));
    });
  });

const isServerReady = async () => {
  try {
    const response = await fetch(baseUrl, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
};

const waitForServer = async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isServerReady()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Tasfer did not become available at ${baseUrl}`);
};

if (!skipCapture) {
  if (!(await isServerReady())) {
    await waitForServer();
  }

  await run(process.execPath, [seedScript, "--out", rawDir, "--publish"], {
    cwd: webRoot,
    env: { ...process.env, URL: baseUrl },
  });
}

try {
  const sourceNames = {
    lightRoadmap: "mobile-light-roadmap.png",
    lightMeetings: "mobile-light-meetings.png",
    darkPhysics: "mobile-dark-physics.png",
    darkRoadmap: "mobile-dark-roadmap.png",
    sidebar: "mobile-sidebar.png",
  };
  const sources = Object.fromEntries(
    await Promise.all(
      Object.entries(sourceNames).map(async ([name, file]) => [
        name,
        (await readFile(join(sourceDir, file))).toString("base64"),
      ]),
    ),
  );

  const shots = [
    {
      file: "01-notes-stay-yours.png",
      source: "lightRoadmap",
      background: ["#f5f3ea", "#dce9dd"],
      ink: "#172118",
      eyebrow: "TASFER",
      title: ["Notes that", "stay yours."],
      subtitle: "Local-first by design.",
      imageY: 610,
      imageWidth: 980,
    },
    {
      file: "02-plan-write-finish.png",
      source: "lightMeetings",
      background: ["#e8edf8", "#d9e2f5"],
      ink: "#172138",
      eyebrow: "ONE CALM CANVAS",
      title: ["Plan. Write.", "Finish."],
      subtitle: "Tasks, notes, and ideas together.",
      imageY: 650,
      imageWidth: 980,
    },
    {
      file: "03-beautiful-math.png",
      source: "darkPhysics",
      background: ["#181b24", "#08090c"],
      ink: "#f7f6f1",
      eyebrow: "MATH, WITHOUT FRICTION",
      title: ["Beautiful math,", "inline."],
      subtitle: "From quick equations to deep work.",
      imageY: 620,
      imageWidth: 980,
      screenBackground: "#08090b",
    },
    {
      file: "04-focus-your-way.png",
      source: "darkRoadmap",
      background: ["#1b2020", "#090b0b"],
      ink: "#f5f7f3",
      eyebrow: "MADE FOR FOCUS",
      title: ["Your work.", "Your way."],
      subtitle: "A private space with no clutter.",
      imageY: 680,
      imageWidth: 980,
      screenBackground: "#08090b",
    },
    {
      file: "05-tune-it-to-you.png",
      source: "sidebar",
      background: ["#edf3ee", "#d9e8df"],
      ink: "#172118",
      eyebrow: "STAY ORGANISED",
      title: ["Every page.", "In reach."],
      subtitle: "A sidebar for your whole workspace.",
      imageY: 640,
      imageWidth: 980,
    },
  ];

  await mkdir(outputDir, { recursive: true });

  for (const shot of shots) {
    const metadata = await sharp(
      Buffer.from(sources[shot.source], "base64"),
    ).metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error(`Unable to read ${shot.source} screenshot dimensions`);
    }

    const imageHeight = Math.round(
      (shot.imageWidth * metadata.height) / metadata.width,
    );
    const imageX = Math.round((1290 - shot.imageWidth) / 2);
    const windowX = 105;
    const windowY = 590;
    const windowWidth = 1080;
    const windowHeight = 2120;
    const shadowY = windowY + 24;
    const screenBackground = shot.screenBackground || "#ffffff";

    const svg = `
      <svg width="1290" height="2796" viewBox="0 0 1290 2796" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="${shot.background[0]}"/>
            <stop offset="1" stop-color="${shot.background[1]}"/>
          </linearGradient>
          <clipPath id="screen"><rect x="${windowX}" y="${windowY}" width="${windowWidth}" height="${windowHeight}" rx="76"/></clipPath>
          <filter id="shadow" x="-30%" y="-30%" width="160%" height="170%">
            <feDropShadow dx="0" dy="26" stdDeviation="28" flood-color="#000000" flood-opacity="0.24"/>
          </filter>
        </defs>
        <rect width="1290" height="2796" fill="url(#bg)"/>
        <circle cx="1120" cy="160" r="280" fill="#70b878" opacity="0.12"/>
        <circle cx="110" cy="2680" r="330" fill="#6d73d9" opacity="0.08"/>
        <text x="105" y="110" fill="${shot.ink}" opacity="0.62" font-family="Helvetica Neue, Arial, sans-serif" font-size="30" font-weight="700" letter-spacing="7">${escapeXml(shot.eyebrow)}</text>
        <text x="105" y="242" fill="${shot.ink}" font-family="Helvetica Neue, Arial, sans-serif" font-size="98" font-weight="700" letter-spacing="-3">
          <tspan x="105" dy="0">${escapeXml(shot.title[0])}</tspan>
          <tspan x="105" dy="106">${escapeXml(shot.title[1])}</tspan>
        </text>
        <text x="105" y="500" fill="${shot.ink}" opacity="0.72" font-family="Helvetica Neue, Arial, sans-serif" font-size="42" font-weight="500">${escapeXml(shot.subtitle)}</text>
        <rect x="${windowX}" y="${shadowY}" width="${windowWidth}" height="${windowHeight - 24}" rx="76" fill="#000" opacity="0.22" filter="url(#shadow)"/>
        <g clip-path="url(#screen)">
          <rect x="${windowX}" y="${windowY}" width="${windowWidth}" height="${windowHeight}" fill="${screenBackground}"/>
          <image href="data:image/png;base64,${sources[shot.source]}" x="${imageX}" y="${shot.imageY}" width="${shot.imageWidth}" height="${imageHeight}" preserveAspectRatio="none"/>
        </g>
        <rect x="${windowX + 1}" y="${windowY + 1}" width="${windowWidth - 2}" height="${windowHeight - 2}" rx="75" fill="none" stroke="${shot.ink}" stroke-opacity="0.13" stroke-width="2"/>
      </svg>`;

    const output = join(outputDir, shot.file);
    await sharp(Buffer.from(svg))
      .flatten({ background: shot.background[0] })
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toColorspace("srgb")
      .toFile(output);

    const outputMetadata = await sharp(output).metadata();
    if (
      outputMetadata.width !== 1290 ||
      outputMetadata.height !== 2796 ||
      outputMetadata.hasAlpha
    ) {
      throw new Error(`${shot.file} is not an opaque 1290x2796 PNG`);
    }
    console.log("generated", output);
  }
} finally {
}
