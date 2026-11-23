import { EditorHarness, expect, test } from "./fixtures";

test("a page is still there after the tab is reloaded", async ({ editor, page }) => {
  await editor.type("Keep me");
  await editor.press("Enter");
  await editor.type("This line must survive a reload, with $a+b$ in it.");
  await expect(page.locator("[data-page-row]")).toContainText("Keep me");

  await page.reload();

  const reopened = new EditorHarness(page);
  await expect(reopened.doc.getByRole("heading", { level: 1 })).toHaveText(
    "Keep me",
  );
  await reopened.focus();
  expect(await reopened.markdown()).toMatch(
    /^# Keep me\nThis line must survive a reload, with \$.*a.*b.*\$ in it\.$/,
  );
});
