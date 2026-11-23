# End-to-end tests

These tests open the real app in a real browser and use it like a person would:
real mouse, real keyboard. They are for things unit tests cannot see, such as
"dragging the mouse across a line selects it" or "the page is still there after
a reload".

## Run them

From `apps/web`:

```bash
npm run test:e2e          # all tests, no window
npm run test:e2e:ui       # Playwright's window: watch, step, re-run
npx playwright test selection   # one file
npx playwright test --headed    # watch the browser
npx playwright show-report      # open the last run's report
```

The first time on a machine, download the browser once:

```bash
npx playwright install chromium
```

The tests start their own dev server on port 4319, so the one you have open on
4000 is not touched. Every test starts from a brand-new browser profile: new
identity, new space, one empty page.

## Write one

```ts
import { expect, test } from "./fixtures";

test("shift and the arrow keys select letters", async ({ editor }) => {
  await editor.type("Title");
  await editor.press("Enter");
  await editor.type("one two three");

  await editor.press("Shift+ArrowLeft", 5);

  await expect.poll(() => editor.selectedText()).toBe("three");
});
```

Asking for `editor` gives you an open, empty page with the caret in its title.

The document is painted on a canvas, so `getByText` cannot find its words on
screen. Use these instead (all in [`fixtures.ts`](fixtures.ts)):

| To check                          | Use                                                       |
| --------------------------------- | --------------------------------------------------------- |
| Headings, paragraphs, lists, bold | `editor.doc`, the hidden copy screen readers get          |
| What is selected                  | `editor.selectedText()`                                   |
| The whole page, formulas included | `editor.markdown()` (selects everything, so call it last) |
| Where to aim the mouse            | `editor.caret()`: park the caret with the keyboard, ask where it is |
| How it looks                      | a screenshot                                              |

## Things that will bite you

- **Don't write pixel positions down.** Move the caret with the keyboard and
  ask `editor.caret()`. Positions typed by hand break with the next font change.
- **A formula is one placeholder character in `editor.doc`.** Read formulas
  through `editor.markdown()`.
- **Use `ControlOrMeta+…` for shortcuts** so the same test runs on Mac and Linux.
- **Wait for results, not for time.** `await expect(...)` and `expect.poll(...)`
  retry until true; `waitForTimeout` makes tests slow and flaky.
- **Keep Playwright's output where it is** (`test-results/`,
  `playwright-report/`). Files written elsewhere under `apps/web` make the dev
  server reload the app in the middle of a test.
- **Touch screens are not covered.** Selection handles and phone keyboards
  still need a real device.
