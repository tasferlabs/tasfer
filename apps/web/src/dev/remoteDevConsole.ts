/**
 * Remote dev console: lets you debug the app on another device (a phone, a
 * tablet, another browser) from the terminal, without remote devtools. Pairs
 * with `scripts/remote-dev-console-plugin.ts`.
 *
 * Forwards to the dev server, which prints to the terminal and appends to
 * `remote-dev-console.log`:
 * - every `console.*` call,
 * - uncaught errors and unhandled promise rejections,
 * - a trace of input events on any contenteditable (keys, beforeinput/input,
 *   composition, selection), since text input is the hardest thing to see
 *   on a device.
 *
 * Vite dev only, and only when the page is opened from another device
 * (non-localhost host) or with `?remotelog` in the URL.
 */

const ROUTE = "/__remote-dev-console";
const LEVELS = ["log", "info", "warn", "error", "debug"] as const;

type Entry = {
  session: string;
  seq: number;
  t: number;
  level: string;
  text: string;
};

function enabled(): boolean {
  const host = location.hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return !local || new URLSearchParams(location.search).has("remotelog");
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (typeof value === "function") return `[function ${value.name}]`;
  if (value instanceof Node) return `<${value.nodeName.toLowerCase()}>`;
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return String(value);
  }
}

/** Text of the hidden input with `|` at the caret (or `[…]` for a range). */
function surfaceSnapshot(el: HTMLElement): string {
  const text = el.textContent ?? "";
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) {
    return JSON.stringify(text);
  }
  const range = sel.getRangeAt(0);
  const offsetOf = (node: Node, offset: number) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.setEnd(node, offset);
    return r.toString().length;
  };
  const start = offsetOf(range.startContainer, range.startOffset);
  const end = offsetOf(range.endContainer, range.endOffset);
  const marked =
    start === end
      ? `${text.slice(0, start)}|${text.slice(start)}`
      : `${text.slice(0, start)}[${text.slice(start, end)}]${text.slice(end)}`;
  return JSON.stringify(marked);
}

function editableTarget(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement && target.isContentEditable
    ? target
    : null;
}

export function installRemoteDevConsole(): void {
  if (!enabled()) return;

  const session = Math.random().toString(36).slice(2, 6);
  let seq = 0;
  let queue: Entry[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    if (queue.length === 0) return;
    const body = JSON.stringify(queue);
    queue = [];
    fetch(ROUTE, { method: "POST", body, keepalive: true }).catch(() => {});
  };

  const push = (level: string, text: string) => {
    queue.push({ session, seq: seq++, t: performance.now(), level, text });
    timer ??= setTimeout(flush, 200);
  };

  for (const level of LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        push(level, args.map(stringify).join(" "));
      } catch {
        // Never let logging break the page.
      }
    };
  }

  window.addEventListener("error", (e) =>
    push("error", `uncaught: ${stringify(e.error ?? e.message)}`),
  );
  window.addEventListener("unhandledrejection", (e) =>
    push("error", `unhandled rejection: ${stringify(e.reason)}`),
  );
  window.addEventListener("pagehide", flush);

  push("info", `session start ${navigator.userAgent} ${location.href}`);

  // Input trace: what the keyboard sends, and what the hidden surface holds
  // right after. Capture phase so it runs before the editor's own handlers.
  const trace = (e: Event, detail: string, el: HTMLElement) =>
    push("event", `${e.type} ${detail} surface=${surfaceSnapshot(el)}`);

  document.addEventListener(
    "keydown",
    (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      trace(
        e,
        `key=${JSON.stringify(e.key)} code=${e.code} keyCode=${e.keyCode} composing=${e.isComposing}`,
        el,
      );
    },
    true,
  );

  document.addEventListener(
    "beforeinput",
    (e) => {
      const el = editableTarget(e.target);
      if (!el) return;
      const ranges = e
        .getTargetRanges()
        .map((r) => {
          const text = r.startContainer.textContent ?? "";
          return `${r.startOffset}-${r.endOffset}:${JSON.stringify(text.slice(r.startOffset, r.endOffset))}`;
        })
        .join(",");
      trace(
        e,
        `type=${e.inputType} data=${JSON.stringify(e.data)} composing=${e.isComposing} ranges=[${ranges}] cancelable=${e.cancelable}`,
        el,
      );
      // Report whether the editor cancelled it, once dispatch has finished.
      setTimeout(() => {
        if (e.defaultPrevented) push("event", `  ↳ beforeinput ${e.inputType} prevented`);
      }, 0);
    },
    true,
  );

  document.addEventListener(
    "input",
    (e) => {
      const el = editableTarget(e.target);
      if (!el || !(e instanceof InputEvent)) return;
      trace(
        e,
        `type=${e.inputType} data=${JSON.stringify(e.data)} composing=${e.isComposing}`,
        el,
      );
    },
    true,
  );

  for (const type of ["compositionstart", "compositionupdate", "compositionend"] as const) {
    document.addEventListener(
      type,
      (e) => {
        const el = editableTarget(e.target);
        if (!el) return;
        trace(e, `data=${JSON.stringify(e.data)}`, el);
      },
      true,
    );
  }

  document.addEventListener("selectionchange", () => {
    const el = editableTarget(document.activeElement);
    if (!el) return;
    push("event", `selectionchange surface=${surfaceSnapshot(el)}`);
  });
}
