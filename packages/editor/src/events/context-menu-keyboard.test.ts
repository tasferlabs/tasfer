/**
 * Opening the contextual menu from the keyboard, and the menu owning the
 * keyboard while it is up.
 *
 * ⌘↩ used to fall straight through to the `Enter` case and split the block, so
 * the chord has to be answered before the switch. And with a menu open the
 * engine must stop handling keys entirely — otherwise the arrows the host menu
 * navigates with also drag the caret around behind it.
 */

import { OPEN_CONTEXT_MENU } from "../action-bus";
import { baseSchema } from "../schema";
import type { Block, Page } from "../serlization/loadPage";
import type { EditorState, ViewportState } from "../state-types";
import { createInitialState } from "../state-utils";
import { getVisibleTextFromRuns } from "../sync/char-runs";
import { createInteractionSession } from "./interaction-session";
import { handleKeyDown } from "./keysEvents";
import { afterEach, describe, expect, it, vi } from "vitest";

const viewport: ViewportState = {
  width: 800,
  height: 600,
  scrollY: 0,
  documentHeight: 2000,
};

function usePlatform(platform: "MacIntel" | "Win32"): void {
  vi.stubGlobal("navigator", { platform, userAgent: platform });
}

function stateAt(textIndex: number, text = "hello world"): EditorState {
  const page: Page = {
    id: "page-1",
    title: "t",
    blocks: [
      {
        id: "p-1",
        orderKey: "a0",
        deleted: false,
        type: "paragraph",
        charRuns: [{ peerId: "peer", startCounter: 0, text }],
        formats: [],
      } as unknown as Block,
    ],
  };
  const base = createInitialState(page, { schema: baseSchema.data });
  return {
    ...base,
    view: { ...base.view, isFocused: true },
    document: {
      ...base.document,
      cursor: { position: { blockIndex: 0, textIndex }, lastUpdate: 0 },
    },
  };
}

type Mods = Partial<
  Record<"ctrlKey" | "metaKey" | "altKey" | "shiftKey", boolean>
>;

function press(
  state: EditorState,
  key: string,
  mods: Mods = {},
  session?: ReturnType<typeof createInteractionSession>,
) {
  return handleKeyDown(
    state,
    viewport,
    {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      isTrusted: true,
      preventDefault() {},
      stopPropagation() {},
      ...mods,
    } as unknown as Event,
    undefined,
    undefined,
    session,
  );
}

function watchOpens(state: EditorState) {
  const opens: { x: number; y: number; hasSelection: boolean }[] = [];
  state.actionBus.register(OPEN_CONTEXT_MENU, (payload) => {
    opens.push(payload);
    return true;
  });
  return opens;
}

function textOf(state: EditorState): string {
  return getVisibleTextFromRuns(
    (state.document.page.blocks[0] as { charRuns?: [] }).charRuns,
  );
}

describe("contextual menu from the keyboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Cmd+Enter opens the menu on Apple instead of splitting the block", () => {
    usePlatform("MacIntel");
    const state = stateAt(5);
    const opens = watchOpens(state);

    const result = press(state, "Enter", { metaKey: true });

    expect(opens).toHaveLength(1);
    expect(opens[0].hasSelection).toBe(false);
    expect(textOf(result.state)).toBe("hello world");
    expect(
      result.state.document.page.blocks.filter((b) => !b.deleted),
    ).toHaveLength(1);
  });

  it("Ctrl+Enter is the same chord off Apple", () => {
    usePlatform("Win32");
    const state = stateAt(5);
    const opens = watchOpens(state);

    press(state, "Enter", { ctrlKey: true });

    expect(opens).toHaveLength(1);
  });

  it("Shift+F10 and the Menu key open it too", () => {
    usePlatform("Win32");
    const state = stateAt(5);
    const opens = watchOpens(state);

    press(state, "F10", { shiftKey: true });
    press(state, "ContextMenu");

    expect(opens).toHaveLength(2);
  });

  it("a plain Enter still splits the block", () => {
    usePlatform("MacIntel");
    const state = stateAt(5);
    const opens = watchOpens(state);

    const result = press(state, "Enter");

    expect(opens).toHaveLength(0);
    expect(
      result.state.document.page.blocks.filter((b) => !b.deleted),
    ).toHaveLength(2);
  });

  it("the caret stays put while a host menu is capturing", () => {
    usePlatform("MacIntel");
    const session = createInteractionSession({} as never);
    session.hostMenuCapturing = true;

    const result = press(stateAt(5), "ArrowRight", {}, session);

    expect(result.state.document.cursor?.position.textIndex).toBe(5);
    expect(result.ops).toHaveLength(0);
  });
});
