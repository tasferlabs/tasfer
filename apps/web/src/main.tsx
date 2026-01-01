// Markdown (place of truth) <-export/import-> Intermidate state + ephemeral state np -> DOM

import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./app/App";
import { ThemeProvider } from "./app/hooks/useTheme";
import { loadFonts } from "./editor/fonts";
import LoadingScreen from "./components/ui/loading-screen";
import "./i18n";

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
