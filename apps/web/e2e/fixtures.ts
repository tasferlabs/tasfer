import { test as base, expect, type Locator, type Page } from "@playwright/test";

// The document is painted on a <canvas>, so its text is not in the page the way
// a normal web page's text is. Three things make it testable anyway:
//
//   - The editor keeps a hidden copy of the document for screen readers
//     (role="document"). Tests read that copy: `editor.doc`.
//   - Typing goes through a hidden text box (role="textbox"), and the editor
//     moves that box to wherever the caret is. So `editor.caret()` tells a test
//     where on screen the caret sits, which is how tests aim the mouse.
//   - Copy puts the selection on the clipboard as text. `editor.selectedText()`
//     and `editor.markdown()` read it, formulas included.
//
// So tests act like a user (real mouse and keyboard on the canvas) and check
// the result through those three. For "does it look right", take a screenshot.

export interface Point {
  x: number;
  y: number;
}

export class EditorHarness {
  readonly page: Page;
  /** The painted document. */
  readonly canvas: Locator;
  /** The hidden text box that receives typing and follows the caret. */
  readonly input: Locator;
  /**
   * The hidden screen-reader copy of the document: headings, paragraphs, lists,
   * bold and so on as normal HTML. A formula shows up here as a placeholder
   * character, so check formulas with `markdown()` instead.
   */
  readonly doc: Locator;

  constructor(page: Page) {
    this.page = page;
    this.canvas = page.locator("canvas").first();
    this.input = page.getByRole("textbox", { name: "Text editor" });
    this.doc = page.getByRole("document", { name: "Text editor" });
  }

  /** Put the caret in the document by clicking near its top-left. */
  async focus(): Promise<void> {
    const box = await this.canvas.boundingBox();
    if (!box) throw new Error("the editor canvas is not on screen");
    await this.page.mouse.click(box.x + 120, box.y + 90);
    await expect(this.input).toBeFocused();
  }

  /** Type with the real keyboard. */
  async type(text: string): Promise<void> {
    await this.page.keyboard.type(text);
  }

  /** Press a key or shortcut, e.g. "Enter", "Shift+ArrowLeft", "ControlOrMeta+z". */
  async press(keys: string, times = 1): Promise<void> {
    for (let i = 0; i < times; i++) await this.page.keyboard.press(keys);
  }

  /** Where the caret is on screen, once the editor has painted. */
  async caret(): Promise<Point> {
    // The caret box moves when the editor paints; let two frames pass first.
    await this.page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    const box = await this.input.boundingBox();
    if (!box) throw new Error("the editor has no caret on screen");
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  /** Press the mouse at one point, move to another, release. */
  async drag(from: Point, to: Point): Promise<void> {
    const mouse = this.page.mouse;
    await mouse.move(from.x, from.y);
    await mouse.down();
    await mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
    await mouse.move(to.x, to.y, { steps: 5 });
    await mouse.up();
  }

  /** Paste text as if it came from the clipboard. Markdown is understood. */
  async paste(text: string): Promise<void> {
    await this.input.evaluate((el, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
    }, text);
  }

  /**
   * Copy the current selection and return what the editor put on the clipboard.
   * `markdown` is the editor's own Markdown for the selection ("" when nothing
   * is selected).
   */
  async copy(): Promise<{ text: string; html: string; markdown: string }> {
    return this.input.evaluate((el) => {
      const data = new DataTransfer();
      el.dispatchEvent(
        new ClipboardEvent("copy", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      const html = data.getData("text/html");
      // The editor hides the selection's Markdown in the copied HTML.
      const hidden = /<!--tasfer-clipboard:([A-Za-z0-9+/=]+)-->/.exec(html);
      const markdown = hidden
        ? new TextDecoder().decode(
            Uint8Array.from(atob(hidden[1]), (c) => c.charCodeAt(0)),
          )
        : "";
      return { text: data.getData("text/plain"), html, markdown };
    });
  }

  /** The selected text as plain words ("" when nothing is selected). */
  async selectedText(): Promise<string> {
    return (await this.copy()).text;
  }

  /** The whole page as Markdown. Selects everything, so do it last. */
  async markdown(): Promise<string> {
    await this.press("ControlOrMeta+a");
    let markdown = "";
    await expect
      .poll(async () => (markdown = (await this.copy()).markdown))
      .not.toBe("");
    return markdown;
  }
}

/** Get past first-run setup into an empty space. */
export async function skipOnboarding(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Skip setup" }).click();
  await expect(
    page.getByRole("button", { name: "Create new page" }).first(),
  ).toBeVisible();
}

/** Create a page in the current space and wait for its editor. */
export async function createPage(page: Page): Promise<EditorHarness> {
  await page.getByRole("button", { name: "Create new page" }).first().click();
  const editor = new EditorHarness(page);
  await expect(editor.canvas).toBeVisible();
  await expect(editor.doc).toBeAttached();
  return editor;
}

export const test = base.extend<{ editor: EditorHarness }>({
  // Every test gets a fresh browser profile: a new identity, a new space and
  // one empty page with the caret in its title.
  editor: async ({ page }, use) => {
    await skipOnboarding(page);
    const editor = await createPage(page);
    await editor.focus();
    await use(editor);
  },
});

export { expect };
