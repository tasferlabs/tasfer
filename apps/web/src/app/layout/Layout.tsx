import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ActionCenter } from "../components/ActionCenter";
import { AddSpaceDialog } from "../components/AddSpaceDialog";
import { BottomToolDock } from "../components/BottomToolDock";
import { ConfirmationDialogProvider } from "../components/ConfirmationDialog";
import { DevToolbar } from "../components/DevToolbar";
import { EditGroupDialog } from "../components/EditGroupDialog";
import { InviteMembersDialog } from "../components/InviteMembersDialog";
import { OnboardingScreen } from "../components/OnboardingScreen";
import PeerVersionPopup from "../components/PeerVersionPopup";
import { UnsavedChangesDialogProvider } from "../components/UnsavedChangesDialog";
import { WordCountOverlay } from "../components/WordCountOverlay";
import { ActiveEditorProvider } from "../contexts/ActiveEditorContext";
import { PageSettingsProvider } from "../contexts/PageSettingsContext";
import { SidebarPanelProvider } from "../contexts/SidebarPanelContext";
import { SpaceProvider, useSpaces } from "../contexts/SpaceContext";
import { SpacePrefsProvider } from "../contexts/SpacePrefsContext";
import { TreeExpandProvider } from "../contexts/TreeExpandContext";
import { useVersion } from "../contexts/VersionContext";
import { useFileDropImport } from "../hooks/useFileDropImport";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import ForceUpdatePage from "../pages/ForceUpdatePage";
import { FileDropChrome } from "./FileDropChrome";
import { FloatingSidebar } from "./FloatingSidebar";
import style from "./Layout.module.css";
import { ResizableSidebar } from "./ResizableSidebar";
import { TopActionBar } from "./TopActionBar";
import { TopActionBarSlotProvider } from "./TopActionBarSlot";

export default function Layout() {
  const { isLoading, meetsMinimum } = useVersion();

  // Track if app ever mounted with valid version (user was working)
  const hadValidVersion = React.useRef(false);
  if (!isLoading && meetsMinimum) {
    hadValidVersion.current = true;
  }

  const needsForceUpdate = !isLoading && !meetsMinimum;

  // If force update needed on first load, show update page directly
  if (needsForceUpdate && !hadValidVersion.current) {
    return <ForceUpdatePage />;
  }

  return (
    <TopActionBarSlotProvider>
      <SpaceProvider>
        <SpacePrefsProvider>
          <TreeExpandProvider>
            <SidebarPanelProvider>
              <PageSettingsProvider>
                <ActiveEditorProvider>
                  <ConfirmationDialogProvider>
                    <UnsavedChangesDialogProvider>
                      <LayoutInner needsForceUpdate={needsForceUpdate} />
                    </UnsavedChangesDialogProvider>
                  </ConfirmationDialogProvider>
                </ActiveEditorProvider>
              </PageSettingsProvider>
            </SidebarPanelProvider>
          </TreeExpandProvider>
        </SpacePrefsProvider>
      </SpaceProvider>
    </TopActionBarSlotProvider>
  );
}

function LayoutInner({ needsForceUpdate }: { needsForceUpdate: boolean }) {
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
  const isMobile = useResponsive("(max-width: 768px)");
  const { spaces, isLoading: spacesLoading } = useSpaces();
  const fileDrop = useFileDropImport();

  // Remember the last visited route so we can restore it on next visit
  const location = useLocation();
  const isPageRoute =
    location.pathname === "/page" || location.pathname.startsWith("/page/");

  React.useEffect(() => {
    const path = location.pathname;
    if (path === "/") return;
    localStorage.setItem("lastRoute", path);
  }, [location.pathname]);

  // Wait for spaces to load before deciding what to show
  if (spacesLoading) {
    return null;
  }

  if (spaces.length === 0) {
    return <OnboardingScreen />;
  }

  return (
    <>
      <div
        className={style.appContainer}
        inert={needsForceUpdate ? (true as unknown as boolean) : undefined}
        {...fileDrop.dropZoneProps}
      >
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

        {!(isMobile && floatingOpen) && (
          <div className={style.appFrame}>
            <TopActionBar
              open={isMobile ? !!floatingOpen : !!resizableOpen}
              setOpen={isMobile ? setFloatingOpen : setResizableOpen}
            />
            <div className="flex-1 min-h-0 w-full">
              <Outlet />
            </div>
          </div>
        )}
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
      <ActionCenter />
      <PeerVersionPopup />
      <BottomToolDock>
        <DevToolbar />
        {isPageRoute && <WordCountOverlay />}
      </BottomToolDock>
      {needsForceUpdate && <ForceUpdatePage />}
    </>
  );
}
