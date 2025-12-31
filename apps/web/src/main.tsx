// Markdown (place of truth) <-export/import-> Intermidate state + ephemeral state np -> DOM

import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { ThemeProvider } from "./app/hooks/useTheme";
import { loadFonts } from "./editor/fonts";
import "./i18n";

await loadFonts();

createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>
);
