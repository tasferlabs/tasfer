import { useOfflineStatus } from "@/offline/hooks/useOfflineStatus";
import React from "react";
import { Outlet } from "react-router-dom";
import { ConfirmationDialogProvider } from "../components/ConfirmationDialog";
import { DevToolbar } from "../components/DevToolbar";
import { UnsavedChangesDialogProvider } from "../components/UnsavedChangesDialog";
import { CommandCenter } from "../components/CommandCenter";
import UpdatePopup from "../components/UpdatePopup";
import { useAuth } from "../contexts/AuthContext";
import { PageSettingsProvider } from "../contexts/PageSettingsContext";
import { SidebarPanelProvider } from "../contexts/SidebarPanelContext";
import { SpaceProvider } from "../contexts/SpaceContext";
import { useVersion } from "../contexts/VersionContext";
import { WebSocketProvider } from "../contexts/WebSocketContext";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import ForceUpdatePage from "../pages/ForceUpdatePage";
import { FloatingSidebar } from "./FloatingSidebar";
import style from "./Layout.module.css";
import { ResizableSidebar } from "./ResizableSidebar";
import { TopActionBar } from "./TopActionBar";

// WebSocket server URL - defaults to using Vite proxy
const WEBSOCKET_BASE_URL =
  import.meta.env.VITE_WEBSOCKET_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
    window.location.host
  }/ws`;

export default function Layout() {
  const [resizableOpen, setResizableOpen] = useLocalStorage(
    "resizable-sidebar-open",
    true
  );
  const [floatingOpen, setFloatingOpen] = React.useState(false);
  const isMobile = useResponsive("(max-width: 768px)");

  // Silent background sync for offline mutations
  useOfflineStatus();

  const { user } = useAuth();
  const { isLoading, meetsMinimum } = useVersion();

  const websocketUrl = WEBSOCKET_BASE_URL;

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
    <WebSocketProvider serverUrl={websocketUrl} userName={user?.name} userAvatar={user?.avatar}>
      <SpaceProvider>
      <SidebarPanelProvider>
      <PageSettingsProvider>
        <ConfirmationDialogProvider>
          <UnsavedChangesDialogProvider>
            <div className={style.appContainer} inert={needsForceUpdate ? (true as unknown as boolean) : undefined}>
              {isMobile ? (
                <FloatingSidebar open={floatingOpen} setOpen={setFloatingOpen} />
              ) : (
                <ResizableSidebar open={!!resizableOpen} setOpen={setResizableOpen} />
              )}

              <div className={style.appFrame}>
                <TopActionBar
                  open={isMobile ? floatingOpen : !!resizableOpen}
                  setOpen={isMobile ? setFloatingOpen : setResizableOpen}
                />
                <div className="flex-1 min-h-0 w-full">
                  <Outlet />
                </div>
              </div>
            </div>
            <CommandCenter />
            <UpdatePopup />
            <DevToolbar />
            {needsForceUpdate && <ForceUpdatePage />}
          </UnsavedChangesDialogProvider>
        </ConfirmationDialogProvider>
      </PageSettingsProvider>
      </SidebarPanelProvider>
      </SpaceProvider>
    </WebSocketProvider>
  );
}
