import React from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ConfirmationDialogProvider } from "../components/ConfirmationDialog";
import { DevToolbar } from "../components/DevToolbar";
import { UnsavedChangesDialogProvider } from "../components/UnsavedChangesDialog";
import { CommandCenter } from "../components/CommandCenter";
import UpdatePopup from "../components/UpdatePopup";
import { PageSettingsProvider } from "../contexts/PageSettingsContext";
import { SidebarPanelProvider } from "../contexts/SidebarPanelContext";
import { TreeExpandProvider } from "../contexts/TreeExpandContext";
import { SpaceProvider } from "../contexts/SpaceContext";
import { useVersion } from "../contexts/VersionContext";
import useLocalStorage from "../hooks/useLocalStorage";
import useResponsive from "../hooks/useResponsive";
import ForceUpdatePage from "../pages/ForceUpdatePage";
import { FloatingSidebar } from "./FloatingSidebar";
import style from "./Layout.module.css";
import { ResizableSidebar } from "./ResizableSidebar";
import { TopActionBar } from "./TopActionBar";


export default function Layout() {
  const [resizableOpen, setResizableOpen] = useLocalStorage(
    "resizable-sidebar-open",
    true
  );
  const [floatingOpen, setFloatingOpen] = React.useState(false);
  const isMobile = useResponsive("(max-width: 768px)");

  // Remember the last visited route so we can restore it on next visit
  const location = useLocation();
  React.useEffect(() => {
    const path = location.pathname;
    if (path === "/") return;
    localStorage.setItem("lastRoute", path);
  }, [location.pathname]);

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
      <SpaceProvider>
      <TreeExpandProvider>
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
      </TreeExpandProvider>
      </SpaceProvider>
  );
}
