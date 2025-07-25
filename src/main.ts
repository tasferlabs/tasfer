// Markdown (place of truth) <-export/import-> Intermidate state + ephemeral state np -> DOM

import { createEditor } from './editor';
import { loadPage } from './deserializer/loadPage';


const canvas = document.getElementById("canvas") as HTMLCanvasElement;

try {
  if (!canvas) {
    throw new Error("Canvas element not found");
  }

  const editor = createEditor(canvas);

  const response = await fetch("./sample.md");
  const content = await response.text();

  // Parse markdown into tokens and then into a tree structure
  const page = loadPage(content);
  // console.log("Parsed tree:", page);

  editor.start(page);
} catch (error) {
  console.error("Error fetching sample.md:", error);
  canvas.outerHTML = "<p>Error loading content</p>";
}
