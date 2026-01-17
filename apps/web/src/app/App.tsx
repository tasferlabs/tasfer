import React from "react";
import Router from "./routes/Router";
import { ConfirmationDialogProvider } from "./components/ConfirmationDialog";
import { PageSettingsProvider } from "./contexts/PageSettingsContext";
import { useOfflineStatus } from "@/offline/hooks/useOfflineStatus";
import { useVersion } from "./contexts/VersionContext";
import ForceUpdatePage from "./pages/ForceUpdatePage";
import UpdatePopup from "./components/UpdatePopup";

const App: React.FC = () => {
  // Silent background sync for offline mutations
  useOfflineStatus();

  const { isLoading, meetsMinimum } = useVersion();

  // Show force update page if minimum version not met
  if (!isLoading && !meetsMinimum) {
    return <ForceUpdatePage />;
  }

  return (
    <PageSettingsProvider>
      <ConfirmationDialogProvider>
        <Router />
        <UpdatePopup />
      </ConfirmationDialogProvider>
    </PageSettingsProvider>
  );
};

export default App;
