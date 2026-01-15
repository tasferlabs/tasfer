// Markdown (place of truth) <-export/import-> Intermidate state + ephemeral state np -> DOM

import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { registerSW } from "virtual:pwa-register";
import App from "./app/App";
import { ThemeProvider } from "./app/hooks/useTheme";
import { loadFonts } from "./editor/fonts";
import LoadingScreen from "./components/ui/loading-screen";
import "./i18n";

// Load fonts and initialize metrics cache before rendering the app
// This ensures the canvas has proper font metrics when it first renders
await loadFonts();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <BrowserRouter>
        <Suspense fallback={<LoadingScreen />}>
          <App />
        </Suspense>
      </BrowserRouter>
    </ThemeProvider>
  </QueryClientProvider>
);

// Register service worker for offline support
const updateSW = registerSW({
  onNeedRefresh() {
    // New version available - could prompt user to refresh
    console.log("[SW] New version available");
  },
  onOfflineReady() {
    console.log("[SW] App ready to work offline");
  },
  onRegisteredSW(swUrl, r) {
    // Register for background sync if supported
    if (r && "sync" in r) {
      r.sync.register("sync-mutations").catch(() => {
        // Background sync not supported
      });
    }
    console.log("[SW] Service worker registered:", swUrl);
  },
  onRegisterError(error) {
    console.error("[SW] Registration error:", error);
  },
});
