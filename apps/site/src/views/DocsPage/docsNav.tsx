import { type ComponentType, type ReactElement } from "react";
import { Icons } from "./docsIcons";
import AppGettingStarted from "./pages/app/getting-started.mdx";
import AppSyncRelay from "./pages/app/sync-relay.mdx";
import AppSelfHosting from "./pages/app/self-hosting.mdx";
import AppPrivacy from "./pages/app/privacy.mdx";
import AppTroubleshooting from "./pages/app/troubleshooting.mdx";
import EditorInstall from "./pages/editor/install.mdx";
import EditorQuickstart from "./pages/editor/quickstart.mdx";
import EditorConcepts from "./pages/editor/concepts.mdx";
import EditorFirstEditor from "./pages/editor/first-editor.mdx";
import EditorCollaboration from "./pages/editor/collaboration.mdx";
import EditorCustomNodes from "./pages/editor/custom-nodes.mdx";
import EditorTheming from "./pages/editor/theming.mdx";
import EditorApiEditor from "./pages/editor/api-editor.mdx";
import EditorApiCommands from "./pages/editor/api-commands.mdx";
import EditorApiSchema from "./pages/editor/api-schema.mdx";
import EditorApiReact from "./pages/editor/api-react.mdx";

/* ============================================================
   Documentation navigation model — ported from docs-shell.jsx.
   `route` is the path under /docs (e.g. "app/getting-started").
   Each article is an MDX file under ./pages/<section>/<slug>.mdx,
   imported directly as a component (no global lookup).
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
    label: "Tasfer App",
    icon: <Icons.Shield />,
    groups: [
      {
        label: null,
        items: [
          { route: "app/getting-started", title: "Getting started", Comp: AppGettingStarted, kw: "install build space desktop first document setup export markdown" },
          { route: "app/sync-relay", title: "Sync & relay setup", Comp: AppSyncRelay, kw: "sync pair devices peer to peer encrypted relay" },
          { route: "app/self-hosting", title: "Self-hosting the relay", Comp: AppSelfHosting, kw: "self host relay signaling cloudflare worker wrangler deploy turn config server" },
          { route: "app/privacy", title: "Privacy & data", Comp: AppPrivacy, kw: "privacy telemetry tracking keys encryption data ledger" },
          { route: "app/troubleshooting", title: "Troubleshooting & FAQ", Comp: AppTroubleshooting, kw: "faq help fix problem backup export import account questions" },
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
          { route: "editor/custom-nodes", title: "Custom nodes & marks", Comp: EditorCustomNodes, kw: "schema node mark callout highlight extend define class register overlay slot strings nodeStrings localize" },
          { route: "editor/theming", title: "Theming the canvas", Comp: EditorTheming, kw: "theme color font metrics dark mode tokens" },
        ],
      },
      {
        label: "API reference",
        items: [
          { route: "editor/api-editor", title: "Editor", Comp: EditorApiEditor, kw: "createeditor options methods state events instance" },
          { route: "editor/api-commands", title: "Changes & actions", Comp: EditorApiCommands, kw: "change run changeapi togglemark setblock insert dispatch action mutation undo redo transaction" },
          { route: "editor/api-schema", title: "Schema & nodes", Comp: EditorApiSchema, kw: "schema baseschema nodes marks content expression" },
          { route: "editor/api-react", title: "React bindings", Comp: EditorApiReact, kw: "react useeditor editor component useeditorstate hook jsx tsx binding" },
        ],
      },
    ],
  },
];

export interface PageMeta extends NavItem {
  section: string;
  sectionId: string;
  group: string | null;
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
      };
      FLAT.push(meta);
      PAGE[item.route] = meta;
    });
  });
});
