import React from "react";
import { Outlet, useLocation, useMatch, useNavigate } from "react-router-dom";
import { ActionCenter } from "../components/ActionCenter";
import { AddSpaceDialog } from "../components/AddSpaceDialog";
import { BottomToolDock } from "../components/BottomToolDock";
import { ConfirmationDialogProvider } from "../components/ConfirmationDialog";
import { EditGroupDialog } from "../components/EditGroupDialog";
import { ImportDialogProvider } from "../components/ImportDialogProvider";
import { InviteMembersDialog } from "../components/InviteMembersDialog";
import { DatabaseLockedScreen } from "../components/DatabaseLockedScreen";
import { NoSpacesScreen } from "../components/NoSpacesScreen";
import { OnboardingScreen } from "../components/OnboardingScreen";
import { UnsavedChangesDialogProvider } from "../components/UnsavedChangesDialog";
import { WordCountOverlay } from "../components/WordCountOverlay";
import { ActionCenterProvider } from "../contexts/ActionCenterContext";
import {
  ActiveEditorProvider,
  useActiveEditor,
} from "../contexts/ActiveEditorContext";
import { PageSettingsProvider } from "../contexts/PageSettingsContext";
import { PeerVersionProvider } from "../contexts/PeerVersionContext";
import { SidebarPanelProvider } from "../contexts/SidebarPanelContext";
import { OwnPrefsProvider } from "../contexts/OwnPrefsContext";
import { SpellProvider } from "@/spell/SpellProvider";
import { useGetArchivedSpaces } from "../api/spaces.api";
import { SpaceProvider, useSpaces } from "../contexts/SpaceContext";
import { SyncActivityProvider } from "../contexts/SyncActivityContext";
import { PageSelectionProvider } from "../contexts/PageSelectionContext";
import { TreeExpandProvider } from "../contexts/TreeExpandContext";
import { useFileDropImport } from "../hooks/useFileDropImport";
import { useP2PPageEventsWithQueryClient } from "../hooks/useP2PPageEvents";
import useLocalStorage from "../hooks/useLocalStorage";
import useMobileLayout from "../hooks/useMobileLayout";
import { useDevToolsEnabled } from "@/lib/devTools";
import { isApplePlatform } from "@tasfer/editor";
import { setHasWorkspace } from "@/lib/workspaceMarker";
import { FileDropChrome } from "./FileDropChrome";
import { FloatingSidebar } from "./FloatingSidebar";
import style from "./Layout.module.css";
import { MockWorkspaceBackdrop } from "./MockWorkspaceBackdrop";
import { ResizableSidebar } from "./ResizableSidebar";
import { readTreeRows, visibleTreeRows } from "./components/treeKeyboard";
import { TopActionBar } from "./TopActionBar";
import { TopActionBarSlotProvider } from "./TopActionBarSlot";

const DevToolbar = React.lazy(() =>
  import("../components/DevToolbar").then((module) => ({
    default: module.DevToolbar,
  })),
);

export default function Layout() {
  // Dev-only smoke test for the error boundary: visit any page with `?boom` to
  // trigger a render error and see the RouteErrorBoundary. No-op in production.
  const { search } = useLocation();
  if (import.meta.env.DEV && new URLSearchParams(search).has("boom")) {
    throw new Error(
      "Test error triggered via ?boom (RouteErrorBoundary smoke test)",
    );
  }

  return (
    <TopActionBarSlotProvider>
      <SpaceProvider>
        <SyncActivityProvider>
          <OwnPrefsProvider>
            <SpellProvider>
              <TreeExpandProvider>
                <PageSelectionProvider>
                  <SidebarPanelProvider>
                    <PageSettingsProvider>
                      <ActiveEditorProvider>
                        <ConfirmationDialogProvider>
                          <UnsavedChangesDialogProvider>
                            <ImportDialogProvider>
                              <PeerVersionProvider>
                                <ActionCenterProvider>
                                  <LayoutInner />
                                </ActionCenterProvider>
                              </PeerVersionProvider>
                            </ImportDialogProvider>
                          </UnsavedChangesDialogProvider>
                        </ConfirmationDialogProvider>
                      </ActiveEditorProvider>
                    </PageSettingsProvider>
                  </SidebarPanelProvider>
                </PageSelectionProvider>
              </TreeExpandProvider>
            </SpellProvider>
          </OwnPrefsProvider>
        </SyncActivityProvider>
      </SpaceProvider>
    </TopActionBarSlotProvider>
  );
}

function LayoutInner() {
  const [resizableOpen, setResizableOpen] = useLocalStorage(
    "resizable-sidebar-open",
    true,
  );
  const [floatingOpen, setFloatingOpen] = useLocalStorage(
    "floating-sidebar-open",
    false,
  );
  const [showAddSpace, setShowAddSpace] = React.useState(false);
  const [groupSettingsId, setGroupSettingsId] = React.useState<string | null>(
    null,
  );
  const [inviteMembersId, setInviteMembersId] = React.useState<string | null>(
    null,
  );
  const { isMobile } = useMobileLayout();
  const devToolsEnabled = useDevToolsEnabled();
  const { spaces, isLoading: spacesLoading, loadError } = useSpaces();
  const fileDrop = useFileDropImport();

  // Mounted here, above every route and both sidebars, because this is the only
  // thing listening for changes a peer made — a space adopted from another of
  // this person's devices, a page added by a co-member. It used to live in
  // SidebarContent, which unmounts whenever the sidebar is closed: with it shut,
  // the engine applied the ops and nothing invalidated the queries, so the
  // sidebar showed the state it had at open time until the app was reloaded.
  useP2PPageEventsWithQueryClient();

  // Remember the last visited route so we can restore it on next visit
  const location = useLocation();
  const navigate = useNavigate();
  const isPageRoute =
    location.pathname === "/page" || location.pathname.startsWith("/page/");

  React.useEffect(() => {
    const path = location.pathname;
    if (path === "/") return;
    localStorage.setItem("lastRoute", path);
  }, [location.pathname]);

  const hasNoSpaces = !spacesLoading && !loadError && spaces.length === 0;

  // Two very different people arrive with zero spaces, and the archive tells
  // them apart: a first run has nothing archived, while someone who archived
  // their last space has their whole workspace waiting there. Only asked for
  // when it decides something.
  const { data: archivedSpaces, isLoading: archivedLoading } =
    useGetArchivedSpaces({ enabled: hasNoSpaces });
  const isReturning = hasNoSpaces && (archivedSpaces?.length ?? 0) > 0;
  const needsOnboarding = hasNoSpaces && !isReturning;

  // The marketing site shares this origin and reads the flag on its landing
  // page: a browser with a workspace goes straight back into the editor, a
  // first-time visitor sees the pitch. Written only once the zero-space
  // question is settled, so a mid-load "nothing here" never sticks.
  React.useEffect(() => {
    if (spacesLoading || loadError) return;
    if (hasNoSpaces && archivedLoading) return;
    setHasWorkspace(!needsOnboarding);
  }, [spacesLoading, loadError, hasNoSpaces, archivedLoading, needsOnboarding]);

  // ⌘; / Ctrl+; toggles the sidebar, from anywhere — mid-sentence included.
  // The semicolon sits unshifted on every layout (backslash, Notion's pick, is
  // AltGr+plus on a Swedish keyboard), and neither the browser nor the editor
  // claims the chord; ⌘. went to spelling (fix-or-next), which wants the key
  // VS Code users already reach for. Matched on `code` so it survives a
  // non-Latin layout, and silent during onboarding, where the shell is a
  // drawn mock with nothing to toggle.
  //
  // The chord is a keyboard gesture, so the keyboard follows it: opening puts
  // focus on the open page's row in the tree, where the arrows walk pages the
  // way they already do after a click there, and closing hands the keyboard
  // back to the editor — but only when it was in the sidebar or nowhere, so a
  // dialog or search field being typed in is left alone. The mouse button
  // stays as it is: a click already says where focus goes.
  const { editor } = useActiveEditor();
  const sidebarOpen = isMobile ? !!floatingOpen : !!resizableOpen;
  const focusTreeOnOpen = React.useRef(false);
  React.useEffect(() => {
    if (needsOnboarding) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const isCmd = isApplePlatform() ? e.metaKey : e.ctrlKey;
      if (!isCmd || e.shiftKey || e.altKey || e.code !== "Semicolon") return;
      e.preventDefault();
      const setOpen = isMobile ? setFloatingOpen : setResizableOpen;
      if (sidebarOpen) {
        setOpen(false);
        const active = document.activeElement;
        if (
          !active ||
          active === document.body ||
          active.closest("[data-app-sidebar]")
        ) {
          editor?.focus();
        }
      } else {
        focusTreeOnOpen.current = true;
        setOpen(true);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    needsOnboarding,
    isMobile,
    sidebarOpen,
    editor,
    setFloatingOpen,
    setResizableOpen,
  ]);

  // The docked sidebar mounts only once open, so the row can be focused no
  // earlier than here. Rows still loading fall back to the tree itself, whose
  // first arrow press steps into the open page's row anyway.
  const currentPageId = useMatch("/page/:id")?.params.id;
  React.useEffect(() => {
    if (!sidebarOpen || !focusTreeOnOpen.current) return;
    focusTreeOnOpen.current = false;
    const tree = document.querySelector<HTMLElement>("[data-page-tree]");
    if (!tree) return;
    const rows = visibleTreeRows(readTreeRows(tree));
    const row = rows.find((r) => r.id === currentPageId) ?? rows[0];
    if (!row) {
      tree.focus();
      return;
    }
    row.element.focus();
    row.element.scrollIntoView({ block: "nearest" });
  }, [sidebarOpen, currentPageId]);

  // A remembered page id stops resolving the moment its space is gone. Drop
  // back to the page root, which renders whichever zero-space state applies.
  // Archive and Settings still work without a space, so they stay reachable —
  // Archive is how a returning user gets their spaces back.
  React.useEffect(() => {
    if (hasNoSpaces && location.pathname.startsWith("/page/")) {
      navigate("/page", { replace: true });
    }
  }, [hasNoSpaces, location.pathname, navigate]);

  // Wait for spaces to load before deciding what to show
  if (spacesLoading) {
    return null;
  }

  if (loadError) {
    return <DatabaseLockedScreen error={loadError} />;
  }

  // Which zero-space state applies isn't settled yet; showing either one now
  // would only have to be swapped a moment later.
  if (hasNoSpaces && archivedLoading) {
    return null;
  }

  // Mobile runs onboarding as its own page. Desktop shows it as a dialog, and
  // deliberately does NOT mount the live shell behind it: with no space, the
  // editor route flashes loading skeletons and lands on an empty state whose
  // button can't work. A drawn-once mock of the shell stands in instead.
  // One tree for both, so that crossing the breakpoint mid-flow — rotating a
  // tablet, resizing a window — re-renders the same OnboardingScreen instead of
  // unmounting it and throwing away whatever had been entered.
  if (needsOnboarding) {
    return (
      <>
        {!isMobile && <MockWorkspaceBackdrop />}
        <OnboardingScreen />
        {!isMobile && (
          <BottomToolDock>
            {devToolsEnabled && (
              <React.Suspense fallback={null}>
                <DevToolbar />
              </React.Suspense>
            )}
          </BottomToolDock>
        )}
      </>
    );
  }

  return (
    <>
      <div className={style.appContainer} {...fileDrop.dropZoneProps}>
        {isMobile ? (
          <FloatingSidebar
            open={!!floatingOpen}
            setOpen={setFloatingOpen}
            onAddSpace={() => setShowAddSpace(true)}
            onSpaceSettings={setGroupSettingsId}
            onInviteMembers={setInviteMembersId}
          />
        ) : (
          <ResizableSidebar
            open={!!resizableOpen}
            setOpen={setResizableOpen}
            onAddSpace={() => setShowAddSpace(true)}
            onSpaceSettings={setGroupSettingsId}
            onInviteMembers={setInviteMembersId}
          />
        )}

        {/* Stays mounted behind the mobile drawer rather than being torn down
            for as long as it is open: this is the tree holding the editor, and
            rebuilding it on every sidebar toggle is a cost with nothing to show
            for it. Inert instead, so nothing behind the drawer is reachable. */}
        <div
          className={style.appFrame}
          inert={
            isMobile && floatingOpen ? (true as unknown as boolean) : undefined
          }
        >
          <TopActionBar
            open={isMobile ? !!floatingOpen : !!resizableOpen}
            setOpen={isMobile ? setFloatingOpen : setResizableOpen}
          />
          <div className="flex-1 min-h-0 w-full">
            {/* Same reason the shell is skipped during onboarding: without a
                space the editor route has nothing to resolve. */}
            {hasNoSpaces && isPageRoute ? (
              <NoSpacesScreen onCreateSpace={() => setShowAddSpace(true)} />
            ) : (
              <Outlet />
            )}
          </div>
        </div>
      </div>
      <AddSpaceDialog open={showAddSpace} onOpenChange={setShowAddSpace} />
      <EditGroupDialog
        spaceId={groupSettingsId || ""}
        open={!!groupSettingsId}
        onOpenChange={(open) =>
          setGroupSettingsId(open ? groupSettingsId : null)
        }
        openInviteMembers={setInviteMembersId}
      />
      <InviteMembersDialog
        spaceId={inviteMembersId || ""}
        open={!!inviteMembersId}
        onOpenChange={(open) =>
          setInviteMembersId(open ? inviteMembersId : null)
        }
      />
      <FileDropChrome fileDrop={fileDrop} spaces={spaces} />
      {/* Nothing to search or act on yet, and its hotkey would open it over
          the onboarding dialog. */}
      {!needsOnboarding && <ActionCenter />}
      <BottomToolDock>
        {devToolsEnabled && (
          <React.Suspense fallback={null}>
            <DevToolbar />
          </React.Suspense>
        )}
        {isPageRoute && <WordCountOverlay />}
      </BottomToolDock>
      {needsOnboarding && <OnboardingScreen />}
    </>
  );
}
