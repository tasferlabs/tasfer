"use client";

import { localizedMdx } from "../shared/LocalizedMdx";

import AppGettingStartedEn from "./pages/app/getting-started.mdx";
import AppMarkdownEn from "./pages/app/markdown.mdx";
import AppPrivacyEn from "./pages/app/privacy.mdx";
import AppSelfHostingEn from "./pages/app/self-hosting.mdx";
import AppSyncRelayEn from "./pages/app/sync-relay.mdx";
import AppTroubleshootingEn from "./pages/app/troubleshooting.mdx";
import EditorRoadmapEn from "./pages/editor/roadmap.mdx";

import AppGettingStartedAr from "./pages/ar/app/getting-started.mdx";
import AppMarkdownAr from "./pages/ar/app/markdown.mdx";
import AppPrivacyAr from "./pages/ar/app/privacy.mdx";
import AppSelfHostingAr from "./pages/ar/app/self-hosting.mdx";
import AppSyncRelayAr from "./pages/ar/app/sync-relay.mdx";
import AppTroubleshootingAr from "./pages/ar/app/troubleshooting.mdx";
import EditorRoadmapAr from "./pages/ar/editor/roadmap.mdx";

export const AppGettingStarted = localizedMdx(
  AppGettingStartedEn,
  AppGettingStartedAr,
);
export const AppMarkdown = localizedMdx(AppMarkdownEn, AppMarkdownAr);
export const AppPrivacy = localizedMdx(AppPrivacyEn, AppPrivacyAr);
export const AppSelfHosting = localizedMdx(AppSelfHostingEn, AppSelfHostingAr);
export const AppSyncRelay = localizedMdx(AppSyncRelayEn, AppSyncRelayAr);
export const AppTroubleshooting = localizedMdx(
  AppTroubleshootingEn,
  AppTroubleshootingAr,
);
export const EditorRoadmap = localizedMdx(EditorRoadmapEn, EditorRoadmapAr);
