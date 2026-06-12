/**
 * @cypherkit/editor — full restyle / theming example.
 *
 * Framework-agnostic, no React. One editor, four totally different looks, all
 * driven by the headless theming surface — no CSS hacks reaching into the
 * canvas, no second editor, no remount. The whole demo is:
 *
 *     editor.setTheme(theme.editor)   // tokens + styles + font + placeholder
 *     …and the host repaints its own chrome to match  (the canvas is transparent)
 *
 * What each layer buys you lives in themes.ts; this file is the wiring:
 *   1. register the font families once (fonts.ts → theme.fonts at mount)
 *   2. build a switcher from THEMES and call setTheme() on click
 *   3. move the page chrome (CSS variables) in lockstep, because the editor
 *      canvas clears to transparent — the page background is the host's job
 *
 * Because the theme is PER-INSTANCE (no globals — see the project's no-globals
 * rule), a second editor on this page could hold a different theme at the same
 * time and the two would never clobber each other.
 */
import { createEditor } from "@cypherkit/editor";

import { FONT_STYLES, loadFonts } from "./fonts";
import { type Theme, themeById, THEMES } from "./themes";

const DRAFT_KEY = "cypher-theming-draft";
const THEME_KEY = "cypher-theming-theme";

// Content chosen to exercise everything a theme restyles: heading levels,
// inline marks, a link, all three list kinds, a code span, and a divider.
const INITIAL_MARKDOWN = `# Restyle the whole editor

One editor, four looks. The switcher up top calls **\`editor.setTheme(...)\`** —
nothing here is a second editor or a remount. Try **⌘B / Ctrl+B** to bold, then
flip themes and watch the *same* document change typeface, palette, and spacing.

## How a theme is built

- **tokens** — the semantic palette: set \`text\`, \`heading\`, \`primary\`, \`selection\`…
- **styles** — pixel control: font sizes, line-height, the list bullet, caret width
- **fontFamily** — pick a registered family; here \`sans\`, \`serif\`, and \`mono\`

### It round-trips like any document

1. type, format, and reorder — it's a real CRDT editor underneath
2. the look is data, not markup — read [the source](https://github.com) to see how
3. \`setTheme\` deep-*merges*, so each preset specifies the same leaves

Inline \`code\` chips, ~~strikethrough~~, and the caret all pick up the theme too.

- [x] paint colours from \`tokens\`
- [x] size + space from \`styles\`
- [ ] swap a stack in fonts.ts for a real web font

## Even the scrollbar restyles

Scroll this pane — the scrollbar's **colour, width, corner radius, and inset**
all come from the theme (\`styles.scrollbar\` + the \`scrollbar*\` tokens), so it
changes with every preset. Terminal makes it chunky and square; Manuscript keeps
it slim and tucked into the margin. Grab and drag the thumb to see the active
colour, too.

> Nothing here reaches into the canvas with CSS — the scrollbar is painted by
> the engine from the same themed style tree as the text.

---

Everything above is the host's job; the engine just renders the bytes.
`;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
}

async function main() {
  // 1. Fonts first — the canvas can't measure text until faces are ready. The
  //    registry (sans/serif/mono) is the same for every theme; presets only
  //    change which family is *selected* via `fontFamily`.
  await loadFonts();

  // 2. Which theme were we on last time? Default to the first preset.
  const initialTheme = themeById(localStorage.getItem(THEME_KEY));

  // 3. Mount the editor with the initial theme baked in: the font registry plus
  //    the preset's tokens/styles/fontFamily/strings. Restore a saved draft if
  //    there is one. `fonts` is the registry (constant); the rest is the look.
  const editor = createEditor({
    element: byId<HTMLDivElement>("editor"),
    value: localStorage.getItem(DRAFT_KEY) ?? INITIAL_MARKDOWN,
    pageId: "theming-demo",
    theme: { fonts: FONT_STYLES, ...initialTheme.editor },
    autofocus: true,
  });

  // 4. Build the switcher — one button per theme.
  const themesEl = byId("themes");
  const buttons = new Map<string, HTMLButtonElement>();
  for (const theme of THEMES) {
    const btn = document.createElement("button");
    btn.id = `theme-${theme.id}`;
    btn.textContent = theme.label;
    btn.title = `setTheme(${theme.id}) — ${theme.blurb}`;
    // preventDefault on mousedown so clicking the switcher doesn't blur the
    // canvas and collapse the selection; refocus after applying.
    btn.addEventListener("mousedown", (e) => e.preventDefault());
    btn.addEventListener("click", () => {
      applyTheme(theme);
      editor.refocus();
    });
    themesEl.appendChild(btn);
    buttons.set(theme.id, btn);
  }

  // 5. The one function that does it all. The editor half is a single
  //    setTheme(); the host half repaints the page chrome (CSS variables) so the
  //    surface BEHIND the transparent canvas, and the toolbar/status around it,
  //    move with the theme — that's what makes it read as a *full* restyle.
  const nameEl = byId("status-name");
  const blurbEl = byId("status-blurb");
  const apiEl = byId("status-api");
  const rootStyle = document.documentElement.style;

  const applyTheme = (theme: Theme) => {
    // --- editor side: tokens + styles + fontFamily + strings, in one call ---
    editor.setTheme(theme.editor);

    // --- host side: the page chrome the engine never touches ---
    rootStyle.setProperty("--page-bg", theme.chrome.background);
    rootStyle.setProperty("--surface", theme.chrome.surface);
    rootStyle.setProperty("--text", theme.chrome.text);
    rootStyle.setProperty("--muted", theme.chrome.muted);
    rootStyle.setProperty("--accent", theme.chrome.accent);

    // Reflect selection in the switcher + status bar.
    for (const [id, btn] of buttons) {
      btn.classList.toggle("is-active", id === theme.id);
    }
    nameEl.textContent = theme.label;
    blurbEl.textContent = theme.blurb;
    apiEl.textContent = `font: ${theme.editor.fontFamily} · setTheme({ tokens, styles, fontFamily })`;

    localStorage.setItem(THEME_KEY, theme.id);
  };

  // Apply once at start so the chrome + status + active button match the baked-in
  // mount theme (the setTheme inside is idempotent against an identical theme).
  applyTheme(initialTheme);

  // 6. Prove it's a live editor, not a static preview: a couple of real commands.
  const keepFocus = (id: string, run: () => void) => {
    const el = byId(id);
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      run();
      editor.refocus();
    });
  };
  const boldBtn = byId("bold");
  keepFocus("bold", () => editor.commands.toggleMark("strong"));
  keepFocus("undo", () => editor.commands.undo());

  // Light up Bold from the live read-model — pure function of editor state.
  const paintActive = () => {
    boldBtn.classList.toggle("is-active", editor.getActiveMarks().has("strong"));
  };
  editor.on("change", paintActive);
  editor.on("selectionchange", paintActive);
  paintActive();

  // 7. Auto-save the draft on every content change — the canonical createEditor
  //    pattern: on("change") + getMarkdown(). (The selected theme is persisted
  //    separately in applyTheme.)
  editor.on("change", () => {
    localStorage.setItem(DRAFT_KEY, editor.getMarkdown());
  });

  // Tear down on hot-reload / navigation so we don't leak listeners or canvases.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => editor.destroy());
  }
}

void main();
