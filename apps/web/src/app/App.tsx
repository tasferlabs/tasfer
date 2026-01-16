import React from "react";
import Router from "./routes/Router";
import { ConfirmationDialogProvider } from "./components/ConfirmationDialog";
import { PageSettingsProvider } from "./contexts/PageSettingsContext";
import { useOfflineStatus } from "@/offline/hooks/useOfflineStatus";

const App: React.FC = () => {
  // Silent background sync for offline mutations
  useOfflineStatus();

  return (
    <PageSettingsProvider>
      <ConfirmationDialogProvider>
        <Router />
      </ConfirmationDialogProvider>
    </PageSettingsProvider>
  );
};

export default App;
