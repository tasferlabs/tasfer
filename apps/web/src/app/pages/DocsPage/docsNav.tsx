import { type ComponentType, type ReactElement } from "react";
import { Icons } from "./docsIcons";
import {
  AppGettingStarted,
  AppSyncRelay,
  AppSelfHosting,
  AppPrivacy,
  AppTroubleshooting,
} from "./pages/appPages";
import {
  EditorInstall,
  EditorQuickstart,
  EditorConcepts,
  EditorFirstEditor,
  EditorCollaboration,
  EditorCustomNodes,
  EditorTheming,
} from "./pages/editorPages";
import {
  EditorApiEditor,
  EditorApiCommands,
  EditorApiSchema,
  EditorApiPlugins,
} from "./pages/editorApiPages";

/* ============================================================
   Documentation navigation model — ported from docs-shell.jsx.
   `route` is the path under /docs (e.g. "app/getting-started").
   Components are referenced directly (no global lookup).
   ============================================================ */

export interface NavItem {
  route: string;
  title: string;
  Comp: ComponentType;
  kw: string;
}
export interface NavGroup {
  label: string | null;
  items: NavItem[];
}
export interface NavSection {
  id: string;
  label: string;
  icon: ReactElement;
  mono?: boolean;
  groups: NavGroup[];
}

export const NAV: NavSection[] = [
  {
    id: "app",
    label: "Cypher App",
    icon: <Icons.Shield />,
    groups: [
      {
        label: null,
        items: [
          { route: "app/getting-started", title: "Getting started", Comp: AppGettingStarted, kw: "install build space desktop first document setup export markdown" },
          { route: "app/sync-relay", title: "Sync & relay setup", Comp: AppSyncRelay, kw: "sync pair devices peer to peer encrypted relay" },
          { route: "app/self-hosting", title: "Self-hosting the relay", Comp: AppSelfHosting, kw: "self host relay docker container tls config server" },
          { route: "app/privacy", title: "Privacy & data", Comp: AppPrivacy, kw: "privacy telemetry tracking keys encryption data ledger" },
          { route: "app/troubleshooting", title: "Troubleshooting & FAQ", Comp: AppTroubleshooting, kw: "faq help fix problem reset account questions" },
        ],
      },
    ],
  },
  {
    id: "editor",
    label: "@cypherkit/editor",
    icon: <Icons.Terminal />,
    mono: true,
    groups: [
      {
        label: "Getting started",
        items: [
          { route: "editor/install", title: "Installation", Comp: EditorInstall, kw: "install npm pnpm yarn requirements mit license" },
          { route: "editor/quickstart", title: "Quick start", Comp: EditorQuickstart, kw: "value state commands events mental model" },
          { route: "editor/concepts", title: "Core concepts", Comp: EditorConcepts, kw: "crdt canvas contenteditable document model" },
        ],
      },
      {
        label: "Guides",
        items: [
          { route: "editor/first-editor", title: "Your first editor", Comp: EditorFirstEditor, kw: "tutorial toolbar persistence collaboration build" },
          { route: "editor/collaboration", title: "Realtime collaboration", Comp: EditorCollaboration, kw: "provider presence cursors offline merge webrtc relay" },
          { route: "editor/custom-nodes", title: "Custom nodes & marks", Comp: EditorCustomNodes, kw: "schema node mark callout highlight extend define" },
          { route: "editor/theming", title: "Theming the canvas", Comp: EditorTheming, kw: "theme color font metrics dark mode tokens" },
        ],
      },
      {
        label: "API reference",
        items: [
          { route: "editor/api-editor", title: "Editor", Comp: EditorApiEditor, kw: "createeditor options methods state events instance" },
          { route: "editor/api-commands", title: "Commands", Comp: EditorApiCommands, kw: "command chain togglemark dispatch transaction" },
          { route: "editor/api-schema", title: "Schema & nodes", Comp: EditorApiSchema, kw: "schema baseschema nodes marks content expression" },
          { route: "editor/api-plugins", title: "Plugins", Comp: EditorApiPlugins, kw: "plugin keymap input rules decorations extend" },
        ],
      },
    ],
  },
];

export interface PageMeta extends NavItem {
  section: string;
  sectionId: string;
  group: string | null;
  eyebrow: string;
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
        sectionId: section.id,
        group: group.label,
        eyebrow: group.label || section.label,
      };
      FLAT.push(meta);
      PAGE[item.route] = meta;
    });
  });
});
