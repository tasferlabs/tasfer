// Markdown (place of truth) <-export/import-> Intermidate state + ephemeral state np -> DOM

import { loadFonts } from "./editor/fonts";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import "./i18n";

await loadFonts();

createRoot(document.getElementById("root")!).render(React.createElement(App));
