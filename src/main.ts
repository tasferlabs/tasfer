// Markdown (place of truth) <-export/import-> Intermidate state + ephemeral state np -> DOM

import { createEditor } from "./editor";
import { loadPage } from "./deserializer/loadPage";
import { loadFonts } from "./editor/fonts";

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

try {
  if (!canvas) {
    throw new Error("Canvas element not found");
  }

  await loadFonts();

  const editor = createEditor(canvas);

  const response = await fetch("./sample.md");
  const content = await response.text();

  const page = loadPage(content);

  editor.start(page);
} catch (error) {
  console.error("Error fetching sample.md:", error);
  canvas.outerHTML = "<p>Error loading content</p>";
}
