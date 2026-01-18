import React from "react";
import Router from "./routes/Router";
import { ConfirmationDialogProvider } from "./components/ConfirmationDialog";
import { PageSettingsProvider } from "./contexts/PageSettingsContext";
import { WebSocketProvider } from "./contexts/WebSocketContext";
import { useOfflineStatus } from "@/offline/hooks/useOfflineStatus";
import { useVersion } from "./contexts/VersionContext";
import ForceUpdatePage from "./pages/ForceUpdatePage";
import UpdatePopup from "./components/UpdatePopup";

// WebSocket server URL - defaults to using Vite proxy
// Uses wss:// for HTTPS, ws:// for HTTP
const WEBSOCKET_URL =
  import.meta.env.VITE_WEBSOCKET_URL ||
  `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${
    window.location.host
  }/ws`;

const App: React.FC = () => {
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
          <Router />
          <UpdatePopup />
        </ConfirmationDialogProvider>
      </PageSettingsProvider>
    </WebSocketProvider>
  );
};

export default App;
