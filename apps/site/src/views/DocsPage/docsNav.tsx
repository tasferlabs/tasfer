import { type ComponentType, type ReactElement } from "react";
import { Icons } from "./docsIcons";
import {
  AppGettingStarted,
  AppPrivacy,
  AppSelfHosting,
  AppSyncRelay,
  AppTroubleshooting,
  EditorApiCommands,
  EditorApiEditor,
  EditorApiReact,
  EditorApiSchema,
  EditorCollaboration,
  EditorConcepts,
  EditorCustomNodes,
  EditorFirstEditor,
  EditorInstall,
  EditorQuickstart,
  EditorTheming,
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
          { route: "app/getting-started", title: "Getting started", titleKey: "docs.navModel.app.gettingStarted", Comp: AppGettingStarted, kw: "install build space desktop first document setup export markdown" },
          { route: "app/sync-relay", title: "Sync & relay setup", titleKey: "docs.navModel.app.syncRelay", Comp: AppSyncRelay, kw: "sync pair devices peer to peer encrypted relay" },
          { route: "app/self-hosting", title: "Self-hosting the relay", titleKey: "docs.navModel.app.selfHosting", Comp: AppSelfHosting, kw: "self host relay signaling cloudflare worker wrangler deploy turn config server" },
          { route: "app/privacy", title: "Privacy & data", titleKey: "docs.navModel.app.privacy", Comp: AppPrivacy, kw: "privacy telemetry tracking keys encryption data ledger" },
          { route: "app/troubleshooting", title: "Troubleshooting & FAQ", titleKey: "docs.navModel.app.troubleshooting", Comp: AppTroubleshooting, kw: "faq help fix problem backup export import account questions" },
        ],
      },
    ],
  },
  {
    id: "editor",
    label: "@tasfer/editor",
    icon: <Icons.Terminal />,
    mono: true,
    groups: [
      {
        label: "Getting started",
        labelKey: "docs.navModel.group.gettingStarted",
        items: [
          { route: "editor/install", title: "Installation", titleKey: "docs.navModel.editor.installation", Comp: EditorInstall, kw: "install npm pnpm yarn requirements mit license" },
          { route: "editor/quickstart", title: "Quick start", titleKey: "docs.navModel.editor.quickStart", Comp: EditorQuickstart, kw: "value state commands events mental model" },
          { route: "editor/concepts", title: "Core concepts", titleKey: "docs.navModel.editor.concepts", Comp: EditorConcepts, kw: "crdt canvas contenteditable document model" },
        ],
      },
      {
        label: "Guides",
        labelKey: "docs.navModel.group.guides",
        items: [
          { route: "editor/first-editor", title: "Your first editor", titleKey: "docs.navModel.editor.firstEditor", Comp: EditorFirstEditor, kw: "tutorial toolbar persistence collaboration build" },
          { route: "editor/collaboration", title: "Realtime collaboration", titleKey: "docs.navModel.editor.collaboration", Comp: EditorCollaboration, kw: "provider presence cursors offline merge webrtc relay" },
          { route: "editor/custom-nodes", title: "Custom nodes & marks", titleKey: "docs.navModel.editor.customNodes", Comp: EditorCustomNodes, kw: "schema node mark callout highlight extend define class register overlay slot strings nodeStrings localize" },
          { route: "editor/theming", title: "Theming the canvas", titleKey: "docs.navModel.editor.theming", Comp: EditorTheming, kw: "theme color font metrics dark mode tokens" },
        ],
      },
      {
        label: "API reference",
        labelKey: "docs.navModel.group.apiReference",
        items: [
          { route: "editor/api-editor", title: "Editor", titleKey: "docs.navModel.editor.apiEditor", Comp: EditorApiEditor, kw: "createeditor options methods state events instance" },
          { route: "editor/api-commands", title: "Changes & actions", titleKey: "docs.navModel.editor.apiCommands", Comp: EditorApiCommands, kw: "change run changeapi togglemark setblock insert dispatch action mutation undo redo transaction" },
          { route: "editor/api-schema", title: "Schema & nodes", titleKey: "docs.navModel.editor.apiSchema", Comp: EditorApiSchema, kw: "schema baseschema nodes marks content expression" },
          { route: "editor/api-react", title: "React bindings", titleKey: "docs.navModel.editor.apiReact", Comp: EditorApiReact, kw: "react useeditor editor component useeditorstate hook jsx tsx binding" },
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
