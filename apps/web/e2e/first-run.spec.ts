import { createPage, expect, skipOnboarding } from "./fixtures";
import { test } from "@playwright/test";

test("skipping setup leads to an empty space where a new page opens the editor", async ({
  page,
}) => {
  await skipOnboarding(page);

  const editor = await createPage(page);

  await expect(page).toHaveURL(/\/page\//);
  await expect(editor.canvas).toBeVisible();
  // A new page starts as one empty title.
  await expect(editor.doc.getByRole("heading", { level: 1 })).toHaveText("");
});
