import { type ComponentType, type ReactElement } from "react";
import { Icons } from "./docsIcons";
import {
  AppGettingStarted,
  AppPrivacy,
  AppSelfHosting,
  AppSyncRelay,
  AppTroubleshooting,
  EditorRoadmap,
} from "./localizedDocs";

/* ============================================================
   Documentation navigation model — ported from docs-shell.jsx.
   `route` is the path under /docs (e.g. "app/getting-started").
   Each article is an MDX file under ./pages/<section>/<slug>.mdx,
   imported directly as a component (no global lookup).
   ============================================================ */

export interface NavItem {
  route: string;
  title: string;
  titleKey: string;
  Comp: ComponentType;
  kw: string;
}
export interface NavGroup {
  label: string | null;
  labelKey?: string;
  items: NavItem[];
}
export interface NavSection {
  id: string;
  label: string;
  labelKey?: string;
  icon: ReactElement;
  mono?: boolean;
  groups: NavGroup[];
}

export const NAV: NavSection[] = [
  {
    id: "app",
    label: "Tasfer App",
    labelKey: "docs.navModel.section.app",
    icon: <Icons.Shield />,
    groups: [
      {
        label: null,
        items: [
          {
            route: "app/getting-started",
            title: "Getting started",
            titleKey: "docs.navModel.app.gettingStarted",
            Comp: AppGettingStarted,
            kw: "install build space desktop first document setup export markdown",
          },
          {
            route: "app/sync-relay",
            title: "Sync & relay setup",
            titleKey: "docs.navModel.app.syncRelay",
            Comp: AppSyncRelay,
            kw: "sync pair devices peer to peer encrypted relay",
          },
          {
            route: "app/privacy",
            title: "Privacy & data",
            titleKey: "docs.navModel.app.privacy",
            Comp: AppPrivacy,
            kw: "privacy telemetry tracking keys encryption data ledger",
          },
          {
            route: "app/troubleshooting",
            title: "Troubleshooting & FAQ",
            titleKey: "docs.navModel.app.troubleshooting",
            Comp: AppTroubleshooting,
            kw: "faq help fix problem backup export import account questions",
          },
          {
            route: "app/self-hosting",
            title: "Self-hosting the relay",
            titleKey: "docs.navModel.app.selfHosting",
            Comp: AppSelfHosting,
            kw: "self host relay signaling cloudflare worker wrangler deploy turn config server",
          },
        ],
      },
    ],
  },
  {
    id: "editor",
    label: "Tasfer Editor SDK",
    labelKey: "docs.navModel.section.editor",
    icon: <Icons.Terminal />,
    mono: true,
    groups: [
      {
        label: null,
        items: [
          {
            route: "editor/roadmap",
            title: "Editor SDK roadmap",
            titleKey: "docs.navModel.editor.roadmap",
            Comp: EditorRoadmap,
            kw: "sdk roadmap package mit license future availability updates",
          },
        ],
      },
    ],
  },
];

export interface PageMeta extends NavItem {
  section: string;
  sectionKey?: string;
  sectionId: string;
  group: string | null;
  groupKey?: string;
}

/** Flat ordered list of pages (for the pager) + a route→meta lookup. */
export const FLAT: PageMeta[] = [];
export const PAGE: Record<string, PageMeta> = {};

NAV.forEach((section) => {
  section.groups.forEach((group) => {
    group.items.forEach((item) => {
      const meta: PageMeta = {
        ...item,
        section: section.label,
        sectionKey: section.labelKey,
        sectionId: section.id,
        group: group.label,
        groupKey: group.labelKey,
      };
      FLAT.push(meta);
      PAGE[item.route] = meta;
    });
  });
});
