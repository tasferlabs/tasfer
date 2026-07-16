import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { loadEditorFonts } from "./fonts";
import "./styles.css";

// Kick off font loading before first paint; the editor re-measures when ready.
loadEditorFonts();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
