import React from "react";
import Router from "./routes/Router";
import { ConfirmationDialogProvider } from "./components/ConfirmationDialog";
import { PageSettingsProvider } from "./contexts/PageSettingsContext";
import { OfflineIndicator } from "@/components/ui/offline-indicator";

const App: React.FC = () => {
  return (
    <PageSettingsProvider>
      <ConfirmationDialogProvider>
        <Router />
        <OfflineIndicator />
      </ConfirmationDialogProvider>
    </PageSettingsProvider>
  );
};

export default App;
