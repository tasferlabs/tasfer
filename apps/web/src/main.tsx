// Markdown (place of truth) <-export/import-> Intermediate state + ephemeral state np -> DOM

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { registerSW } from "virtual:pwa-register";
import { AuthProvider } from "./app/contexts/AuthContext";
import { VersionProvider } from "./app/contexts/VersionContext";
import { ThemeProvider } from "./app/hooks/useTheme";
import { router } from "./app/routes/Router";
import LoadingScreen from "./components/ui/loading-screen";
import { loadFonts } from "./editor/fonts";
import "./i18n";
import { serviceWorkerBridge } from "./serviceWorkerBridge";

// Mark native apps so CSS can disable text selection
if ((window as any).Capacitor?.isNativePlatform?.()) {
  document.body.classList.add("native");
}

// Start font loading in background — don't block initial render.
// Font metrics are computed lazily on first use per size/weight combo.
loadFonts();

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
    <AuthProvider>
      <ThemeProvider>
        <VersionProvider>
          <Suspense fallback={<LoadingScreen />}>
            <RouterProvider router={router} />
          </Suspense>
        </VersionProvider>
      </ThemeProvider>
    </AuthProvider>
  </QueryClientProvider>,
);

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
