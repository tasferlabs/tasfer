// Markdown (place of truth) <-export/import-> Intermediate state + ephemeral state np -> DOM

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { router } from "./app/routes/Router";
import { VersionProvider } from "./app/contexts/VersionContext";
import { ThemeProvider } from "./app/hooks/useTheme";
import LoadingScreen from "./components/ui/loading-screen";
import { loadFonts } from "./editor/fonts";
import "./i18n";
import { serviceWorkerBridge } from "./serviceWorkerBridge";

// Load fonts and initialize metrics cache before rendering the app
// This ensures the canvas has proper font metrics when it first renders
await loadFonts();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      networkMode: "always", // Always attempt fetch - let service worker handle offline
    },
    mutations: {
      networkMode: "always",
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThemeProvider>
      <VersionProvider>
        <Suspense fallback={<LoadingScreen />}>
          <RouterProvider router={router} />
        </Suspense>
      </VersionProvider>
    </ThemeProvider>
  </QueryClientProvider>,
);

// Cancel the recovery timeout - app loaded successfully
window.__cancelRecoveryTimeout?.();

// Register service worker for offline support
const updateSW = registerSW({
  onNeedRefresh() {
    // New version available - notify VersionContext via bridge
    console.log("[SW] New version available");
    serviceWorkerBridge.triggerUpdate();
  },
  onOfflineReady() {
    console.log("[SW] App ready to work offline");
  },
  onRegisteredSW(swUrl: string, r: ServiceWorkerRegistration | undefined) {
    // Store the update function for VersionContext via bridge
    if (r) {
      serviceWorkerBridge.setActivator(() => {
        r.waiting?.postMessage({ type: "SKIP_WAITING" });
      });
    }

    // Register for background sync if supported
    if (r && "sync" in r) {
      r.sync?.register("sync-mutations").catch(() => {
        // Background sync not supported
      });
    }
    console.log("[SW] Service worker registered:", swUrl);
  },
  onRegisterError(error: unknown) {
    console.error("[SW] Registration error:", error);
  },
});

// Export updateSW for manual triggering if needed
export { updateSW };
