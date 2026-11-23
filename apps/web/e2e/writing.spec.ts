import { expect, test } from "./fixtures";

test("typed text becomes the title and a paragraph", async ({ editor, page }) => {
  await editor.type("Trip notes");
  await editor.press("Enter");
  await editor.type("Pack the tent.");

  await expect(editor.doc.getByRole("heading", { level: 1 })).toHaveText(
    "Trip notes",
  );
  await expect(editor.doc.getByRole("paragraph")).toHaveText("Pack the tent.");
  // The sidebar names the page after its title.
  await expect(page.locator("[data-page-row]")).toContainText("Trip notes");
});

test("pasted Markdown becomes a list, bold text and a formula", async ({
  editor,
}) => {
  await editor.type("Shopping");
  await editor.press("Enter");

  await editor.paste("- milk\n- eggs\n\nBuy **two** of each, so $2x$ items.\n");

  await expect(editor.doc.getByRole("listitem")).toHaveText(["milk", "eggs"]);
  await expect(editor.doc.locator("strong")).toHaveText("two");
  expect(await editor.markdown()).toContain("$2x$");
});

test("typing between dollar signs makes a formula", async ({ editor }) => {
  await editor.type("Area");
  await editor.press("Enter");

  await editor.type("It is $x^2$ wide");

  expect(await editor.markdown()).toMatch(/It is \$.*x.*2.*\$ wide/);
});

test("undo takes a paste back and redo returns it", async ({ editor }) => {
  await editor.type("Draft");
  await editor.press("Enter");
  await editor.paste("a pasted sentence");
  const pasted = editor.doc.getByText("a pasted sentence");
  await expect(pasted).toBeAttached();

  await editor.press("ControlOrMeta+z");
  await expect(pasted).not.toBeAttached();

  await editor.press("ControlOrMeta+Shift+z");
  await expect(pasted).toBeAttached();
});

test("Arabic text is kept exactly as typed", async ({ editor }) => {
  await editor.type("ملاحظات");
  await editor.press("Enter");
  await editor.type("مرحبا بالعالم");

  await expect(editor.doc.getByRole("heading", { level: 1 })).toHaveText(
    "ملاحظات",
  );
  expect(await editor.markdown()).toBe("# ملاحظات\nمرحبا بالعالم");
});
