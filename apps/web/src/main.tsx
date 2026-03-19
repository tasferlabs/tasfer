// Markdown (place of truth) <-export/import-> Intermediate state + ephemeral state np -> DOM

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, Suspense, useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Direction } from "radix-ui";
import { registerSW } from "virtual:pwa-register";
import { initPlatform } from "./platform";
import { AuthProvider } from "./app/contexts/AuthContext";
import { VersionProvider } from "./app/contexts/VersionContext";
import { ThemeProvider } from "./app/hooks/useTheme";
import { router } from "./app/routes/Router";
import LoadingScreen from "./components/ui/loading-screen";
import { loadFonts, loadArabicFonts } from "./editor/fonts";
import "./i18n";
import i18next from "i18next";

// Set document direction and lang based on current language
function updateDocumentDirection() {
  const dir = i18next.dir();
  const lang = i18next.language || "en";
  document.documentElement.dir = dir;
  document.documentElement.lang = lang;
}

// Load Arabic fonts when language is or switches to Arabic
function loadArabicFontsIfNeeded() {
  const lang = i18next.language || "en";
  if (lang === "ar" || lang.startsWith("ar-")) {
    loadArabicFonts();
  }
}

i18next.on("languageChanged", () => {
  updateDocumentDirection();
  loadArabicFontsIfNeeded();
});
i18next.on("initialized", () => {
  updateDocumentDirection();
  loadArabicFontsIfNeeded();
});
import { serviceWorkerBridge } from "./serviceWorkerBridge";

// Mark native apps so CSS can disable text selection
if ((window as any).Capacitor?.isNativePlatform?.()) {
  document.body.classList.add("native");
}

// Start font loading in background — don't block initial render.
// Font metrics are computed lazily on first use per size/weight combo.
loadFonts();

// Initialize platform adapter (web/electron/capacitor) before rendering.
// This is synchronous-enough for first render — the adapter is lazy-loaded
// but getPlatform() will be available by the time components make API calls.
initPlatform().catch((err) => {
  console.error("[Platform] Failed to initialize:", err);
});

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

function DirectionWrapper({ children }: { children: ReactNode }) {
  const [dir, setDir] = useState<"ltr" | "rtl">(
    (i18next.dir() as "ltr" | "rtl") || "ltr",
  );

  useEffect(() => {
    const handleLanguageChanged = () => {
      setDir((i18next.dir() as "ltr" | "rtl") || "ltr");
    };
    i18next.on("languageChanged", handleLanguageChanged);
    return () => {
      i18next.off("languageChanged", handleLanguageChanged);
    };
  }, []);

  return (
    <Direction.DirectionProvider dir={dir}>
      {children}
    </Direction.DirectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <ThemeProvider>
        <DirectionWrapper>
          <VersionProvider>
            <Suspense fallback={<LoadingScreen />}>
              <RouterProvider router={router} />
            </Suspense>
          </VersionProvider>
        </DirectionWrapper>
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
