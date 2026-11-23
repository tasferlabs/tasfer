import { expect, test } from "./fixtures";

// Each test finds its mouse targets by parking the caret there with the
// keyboard first and asking where it is. No pixel positions are written down,
// so a font or layout change does not break them.

test.beforeEach(async ({ editor }) => {
  await editor.type("Title");
  await editor.press("Enter");
  await editor.type("one two three");
});

test("dragging the mouse selects the text it passes over", async ({ editor }) => {
  const end = await editor.caret();
  await editor.press("Home");
  await editor.press("ArrowRight", 4);
  const beforeTwo = await editor.caret();

  await editor.drag(beforeTwo, end);

  await expect.poll(() => editor.selectedText()).toBe("two three");
});

test("dragging backwards selects the same text", async ({ editor }) => {
  const end = await editor.caret();
  await editor.press("Home");
  await editor.press("ArrowRight", 4);
  const beforeTwo = await editor.caret();

  await editor.drag(end, beforeTwo);

  await expect.poll(() => editor.selectedText()).toBe("two three");
});

test("double-clicking selects one word", async ({ editor, page }) => {
  await editor.press("Home");
  await editor.press("ArrowRight", 5);
  const insideTwo = await editor.caret();

  await page.mouse.dblclick(insideTwo.x, insideTwo.y);

  await expect.poll(() => editor.selectedText()).toBe("two");
});

test("shift and the arrow keys grow the selection one letter at a time", async ({
  editor,
}) => {
  await editor.press("Shift+ArrowLeft", 5);

  await expect.poll(() => editor.selectedText()).toBe("three");
});

test("select all copies the whole page as Markdown", async ({ editor }) => {
  expect(await editor.markdown()).toBe("# Title\none two three");
});
