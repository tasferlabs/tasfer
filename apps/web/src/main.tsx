// Markdown (place of truth) <-export/import-> Intermediate state + ephemeral state np -> DOM

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, Suspense, useState, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { Direction } from "radix-ui";
import { registerSW } from "virtual:pwa-register";
import { initPlatform, getPlatform } from "./platform";
import {
  setAssetResolver,
  setSlashCommandProvider,
} from "@cypherkit/editor/adapters";
import { getSlashCommands } from "./editor/SlashCommandMenu";
import { AuthProvider } from "./app/contexts/AuthContext";
import { VersionProvider } from "./app/contexts/VersionContext";
import { ThemeProvider } from "./app/hooks/useTheme";
import { router } from "./app/routes/Router";
import LoadingScreen from "./components/ui/loading-screen";
import { loadFonts, loadArabicFonts } from "./fonts";
import "./i18n";
import i18next from "i18next";
import { serviceWorkerBridge } from "./serviceWorkerBridge";

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

const onLanguageChanged = () => {
  updateDocumentDirection();
  loadArabicFontsIfNeeded();
};

const onInitialized = () => {
  updateDocumentDirection();
  loadArabicFontsIfNeeded();
};

i18next.on("languageChanged", onLanguageChanged);
i18next.on("initialized", onInitialized);

// Mark native apps so CSS can disable text selection
if ((window as any).Capacitor?.isNativePlatform?.()) {
  document.body.classList.add("native");
}

// Mark Electron so CSS can apply window-chrome styles (drag regions, traffic-light insets)
if ((window as any).cypher) {
  document.body.classList.add("electron");
  // Add platform-specific class for Windows vs macOS title bar differences
  const platform = (window as any).cypher.platform;
  if (platform === "win32") {
    document.body.classList.add("electron-win");
  } else if (platform === "darwin") {
    document.body.classList.add("electron-mac");
  } else if (platform === "linux") {
    document.body.classList.add("electron-linux");
  }

  // Mount the custom menu bar + window controls for Windows/Linux
  // The element is already visible (set by inline script in index.html to avoid flash).
  if (platform !== "darwin") {
    const el = document.getElementById("electron-menubar");
    if (el) {
      import("./app/layout/ElectronMenuBar").then(({ ElectronMenuBar }) => {
        createRoot(el).render(<ElectronMenuBar />);
      });
    }
  }
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

const App = () => (
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
  </QueryClientProvider>
);

// Persist root across HMR updates
let root: Root | null = (window as any).__CYPHER_ROOT__ ?? null;
let platformReady: boolean = (window as any).__CYPHER_PLATFORM_READY__ ?? false;

function renderApp() {
  if (!root) {
    root = createRoot(document.getElementById("root")!);
    (window as any).__CYPHER_ROOT__ = root;
  }
  root.render(<App />);
}

/**
 * Acquire an exclusive Web Lock so only one tab can run the app.
 * OPFS + wa-sqlite requires exclusive access — a second tab would corrupt state.
 * Electron and Capacitor are single-window, so this only applies to the web platform.
 */
function acquireTabLock(): Promise<boolean> {
  if (
    !navigator.locks ||
    (window as any).cypher || // Electron
    (window as any).Capacitor?.isNativePlatform?.() // Capacitor
  ) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    navigator.locks.request("cypher-app", { ifAvailable: true }, (lock) => {
      if (!lock) {
        // Another tab holds the lock
        resolve(false);
        return;
      }
      // Hold the lock for the lifetime of this tab by returning
      // a promise that never resolves
      resolve(true);
      return new Promise(() => {});
    });
  });
}

/** Apply the user's saved theme so CSS variables resolve correctly. */
function applyStoredTheme() {
  const stored = localStorage.getItem("theme");
  const root = document.documentElement;
  if (stored === "dark") {
    root.classList.add("dark");
  } else if (stored === "light") {
    root.classList.remove("dark");
  } else {
    // "system" or unset — follow OS preference
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }
}

function renderTabError() {
  applyStoredTheme();
  if (!root) {
    root = createRoot(document.getElementById("root")!);
    (window as any).__CYPHER_ROOT__ = root;
  }
  root.render(<TabAlreadyOpenScreen />);
}

function TabAlreadyOpenScreen() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100dvh",
        width: "100%",
        overflow: "hidden",
        fontFamily:
          'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
        padding: "24px",
        textAlign: "center",
        background: "var(--background)",
        color: "var(--foreground)",
      }}
    >
      <div style={{ fontSize: "32px", marginBottom: "16px" }}>&#9888;</div>
      <h1
        style={{
          fontSize: "18px",
          fontWeight: 600,
          margin: "0 0 12px",
        }}
      >
        {i18next.t("error.tabAlreadyOpen", "Cypher is already open")}
      </h1>
      <p
        style={{
          fontSize: "14px",
          color: "var(--muted-foreground)",
          maxWidth: "400px",
          lineHeight: 1.7,
          margin: "0 0 24px",
        }}
      >
        {i18next.t(
          "error.tabAlreadyOpenDesc",
          "Cypher can only run in one tab at a time. Please close this tab and use the one that's already open.",
        )}
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          padding: "10px 24px",
          background: "var(--primary)",
          color: "var(--primary-foreground)",
          border: "none",
          cursor: "pointer",
          fontFamily: "inherit",
          fontSize: "13px",
          fontWeight: 600,
        }}
      >
        {i18next.t("error.tryAgainTab", "Try again")}
      </button>
    </div>
  );
}

if (platformReady) {
  // Platform already initialized from a previous HMR cycle — just re-render
  renderApp();
} else {
  acquireTabLock().then((acquired) => {
    if (!acquired) {
      renderTabError();
      return;
    }
    // Initialize platform adapter (web/electron/capacitor) before rendering.
    // Must await — the worker-backed SQLite needs time to spin up.
    initPlatform()
      .then(() => {
        // Wire the editor package's asset resolver to the host platform layer
        setAssetResolver((url) => getPlatform().assets.getUrl(url));
        // Provide the host's (translated, UI-decorated) slash command list
        setSlashCommandProvider(getSlashCommands);
        platformReady = true;
        (window as any).__CYPHER_PLATFORM_READY__ = true;
        renderApp();
      })
      .catch((err) => {
        console.error("[Platform] Failed to initialize:", err);
      });
  });
}

// Register service worker for offline support (skip in Electron — loaded via file://)
const isElectron = !!(window as any).cypher;
const updateSW = isElectron
  ? () => {}
  : registerSW({
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

// HMR cleanup — remove stacked listeners on module dispose
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    i18next.off("languageChanged", onLanguageChanged);
    i18next.off("initialized", onInitialized);
  });
}
