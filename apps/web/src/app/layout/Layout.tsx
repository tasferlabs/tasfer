import React from "react";
import { Outlet } from "react-router-dom";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import style from "./Layout.module.css";
import { ResizableSidebar } from "./ResizableSidebar";
import { FloatingSidebar } from "./FloatingSidebar";
import { TopActionBar } from "./TopActionBar";
import { ConfirmationDialogProvider } from "../components/ConfirmationDialog";
import { UnsavedChangesDialogProvider } from "../components/UnsavedChangesDialog";
import { PageSettingsProvider } from "../contexts/PageSettingsContext";
import { WebSocketProvider } from "../contexts/WebSocketContext";
import { useVersion } from "../contexts/VersionContext";
import ForceUpdatePage from "../pages/ForceUpdatePage";
import UpdatePopup from "../components/UpdatePopup";
import { DevToolbar } from "../components/DevToolbar";
import { useOfflineStatus } from "@/offline/hooks/useOfflineStatus";

// WebSocket server URL - defaults to using Vite proxy
const WEBSOCKET_BASE_URL =
  import.meta.env.VITE_WEBSOCKET_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
    window.location.host
  }/ws`;

// Auth key for WebSocket connection
const LIVE_AUTH_KEY = import.meta.env.VITE_LIVE_AUTH_KEY || "";
const WEBSOCKET_URL = LIVE_AUTH_KEY
  ? `${WEBSOCKET_BASE_URL}?key=${LIVE_AUTH_KEY}`
  : WEBSOCKET_BASE_URL;

export default function Layout() {
  const [resizableOpen, setResizableOpen] = useLocalStorage(
    "resizable-sidebar-open",
    true
  );
  const [floatingOpen, setFloatingOpen] = React.useState(false);
  const isMobile = useResponsive("(max-width: 768px)");

  // Silent background sync for offline mutations
  useOfflineStatus();

  const { isLoading, meetsMinimum } = useVersion();

  // Show force update page if minimum version not met
  if (!isLoading && !meetsMinimum) {
    return <ForceUpdatePage />;
  }

  return (
    <WebSocketProvider serverUrl={WEBSOCKET_URL}>
      <PageSettingsProvider>
        <ConfirmationDialogProvider>
          <UnsavedChangesDialogProvider>
            <div className={style.appContainer}>
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
            <UpdatePopup />
            <DevToolbar />
          </UnsavedChangesDialogProvider>
        </ConfirmationDialogProvider>
      </PageSettingsProvider>
    </WebSocketProvider>
  );
}
