// The page that gets recorded: the editor canvas, with a keycap floating over
// its bottom edge that flashes the key being pressed. Each press replaces the
// one before; there is no history.
//
// The recorder shows the whole app by default. With its --canvas option, the
// app runs in a frame that is larger than the video and shifted so only its
// canvas shows; the sidebar and the top bar fall outside the picture.
//
// The keycap is an overlay: the app keeps the full height of the video and
// the key is drawn on top of it. It borrows the app's own colours and font,
// so it reads as part of the app in either theme.
//
// The whole page is zoomed by `scale`, so the app sees CSS pixels at a pixel
// density of `scale` and the recording is that much sharper.

export function shellHtml({ width, height, scale, appUrl }) {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  :root {
    /* Stand-ins until the app's own values are copied over (adoptTheme). */
    --background: #fff; --foreground: #09090b; --muted: #f4f4f5;
    --border: #e4e4e7; --primary: #3fa34d; --primary-foreground: #f2fdf3;
    --radius: 0.45rem;
    --font: system-ui, -apple-system, sans-serif;
  }
  html, body { margin: 0; height: 100%; overflow: hidden; background: var(--background); }
  body { zoom: ${scale}; }
  #stage { overflow: hidden; width: ${width}px; height: ${height}px; }
  #app { display: block; border: 0; width: ${width}px; height: ${height}px; }
  #stage { position: relative; }
  /* Floats over the bottom of the app; clicks pass through it. */
  #keys {
    position: absolute; left: 0; right: 0; bottom: 24px;
    display: flex; justify-content: center; pointer-events: none;
    font-family: var(--font); color: var(--foreground);
  }
  /* The key being pressed, drawn like the app's own shortcut keycaps. */
  #key {
    box-sizing: border-box; min-width: 44px; height: 44px; padding: 0 13px;
    display: flex; align-items: center; justify-content: center;
    border: 1px solid var(--border); border-bottom-width: 3px;
    border-radius: calc(var(--radius) + 2px); background: var(--muted);
    font: 500 20px/1 var(--font); white-space: pre;
    box-shadow: 0 6px 18px rgb(0 0 0 / 0.14);
    transition: opacity 0.3s ease;
  }
  #key.special {
    background: var(--primary); border-color: var(--primary);
    color: var(--primary-foreground);
  }
  #key.off { opacity: 0; }
  #key.press { animation: press 0.12s ease-out; }
  @keyframes press {
    from { transform: translateY(3px) scale(0.9); }
  }
</style>
<div id="stage">
  <iframe id="app" src="${appUrl}"></iframe>
  <div id="keys"><span id="key" class="off"></span></div>
</div>
<script>(${installOverlay})();</script>`;
}

// Runs inside the recorded page, so it must not use anything outside its body.
function installOverlay() {
  const $ = (id) => document.getElementById(id);
  const frame = $("app");
  const stage = $("stage");
  const cap = $("key");

  const IDLE_MS = 650;
  const THEME = [
    "--background",
    "--foreground",
    "--muted",
    "--border",
    "--primary",
    "--primary-foreground",
    "--radius",
  ];
  let idle = 0;

  window.demoOverlay = {
    /** Copy the app's colours and font, so the keycap matches its theme. */
    adoptTheme() {
      const doc = frame.contentDocument;
      const from = getComputedStyle(doc.documentElement);
      const root = document.documentElement.style;
      for (const name of THEME) {
        const value = from.getPropertyValue(name).trim();
        if (value) root.setProperty(name, value);
      }
      root.setProperty("--font", getComputedStyle(doc.body).fontFamily);
    },
    /**
     * Show only the editor canvas: grow the frame by whatever surrounds the
     * canvas and shift it so the canvas exactly fills the stage.
     */
    cropToCanvas() {
      const win = frame.contentWindow;
      const box = win.document.querySelector("canvas").getBoundingClientRect();
      const extraX = win.innerWidth - box.width;
      const extraY = win.innerHeight - box.height;
      frame.style.width = `${stage.clientWidth + extraX}px`;
      frame.style.height = `${stage.clientHeight + extraY}px`;
      frame.style.marginLeft = `${-box.left}px`;
      frame.style.marginTop = `${-box.top}px`;
    },
    /**
     * Where a point of the canvas (`dx`, `dy` from its corner, in the app's
     * CSS pixels) sits in the recorded page, also in the app's CSS pixels.
     */
    canvasPoint(dx, dy) {
      const box = frame.contentDocument
        .querySelector("canvas")
        .getBoundingClientRect();
      return {
        x: box.left + (parseFloat(frame.style.marginLeft) || 0) + dx,
        y: box.top + (parseFloat(frame.style.marginTop) || 0) + dy,
      };
    },
    /** Flash one key press. It replaces the key shown before. */
    key(label, special) {
      cap.textContent = label;
      cap.className = special ? "special" : "";
      // Reading the size restarts the press animation for a repeated key.
      void cap.offsetWidth;
      cap.classList.add("press");
      clearTimeout(idle);
      idle = setTimeout(() => cap.classList.add("off"), IDLE_MS);
    },
  };
}
