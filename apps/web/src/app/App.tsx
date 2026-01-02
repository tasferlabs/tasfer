import React from "react";
import Router from "./routes/Router";
import { ConfirmationDialogProvider } from "./components/ConfirmationDialog";
import { PageSettingsProvider } from "./contexts/PageSettingsContext";

const App: React.FC = () => {
  return (
    <PageSettingsProvider>
      <ConfirmationDialogProvider>
        <Router />
      </ConfirmationDialogProvider>
    </PageSettingsProvider>
  );
};

export default App;
