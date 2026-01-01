import React from "react";
import Router from "./routes/Router";
import { ConfirmationDialogProvider } from "./components/ConfirmationDialog";
import { SavingProvider } from "./contexts/SavingContext";

const App: React.FC = () => {
  return (
    <ConfirmationDialogProvider>
      <SavingProvider>
        <Router />
      </SavingProvider>
    </ConfirmationDialogProvider>
  );
};

export default App;
