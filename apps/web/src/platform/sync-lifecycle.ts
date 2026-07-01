/**
 * SyncLifecycleController — makes P2P sync lifecycle-aware on native.
 *
 * On native (Capacitor) the Engine + Replicator run directly on the WebView
 * main thread. When the OS backgrounds the app the JS loop is suspended and
 * WebRTC/WebSocket connections die with no clean teardown; on foreground
 * nothing proactively reconnects. This controller bridges app-state events to
 * `Replicator.pause()/resume()`:
 *
 *   - background → flush the in-flight sync round, then tear down peers and
 *     suspend sockets (so a backgrounded app doesn't retry endlessly).
 *   - foreground → reconnect fast and run a fresh sync round.
 *
 * Two event sources drive it, and both are safe to fire together (pause/resume
 * are idempotent and serialized):
 *   1. Native shell — iOS calls `window.__cypherLifecycle.onPause/onResume`
 *      via evaluateJavaScript, wrapped in a `beginBackgroundTask` window. When
 *      teardown finishes we call `bridge.lifecycle.endFlush()` to release that
 *      task early.
 *   2. Web/electron fallback — `visibilitychange` + `pagehide`, so behavior is
 *      correct off-iOS and as a belt-and-suspenders on iOS.
 *
 * It owns no sync state; it is a thin coordinator over the Replicator.
 */

import { getBridge } from "./bridge";
import type { Replicator } from "./sync";

declare global {
  interface Window {
    __cypherLifecycle?: {
      onPause(): void;
      onResume(): void;
    };
  }
}

export class SyncLifecycleController {
  private replicator: Replicator;
  /** Serializes pause/resume so a resume can't race an unfinished pause. */
  private inFlight: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(replicator: Replicator) {
    this.replicator = replicator;
  }

  /**
   * Wire up native + web lifecycle events. Returns a disposer that removes the
   * listeners and clears the global — call it before re-installing (e.g. HMR).
   */
  install(): () => void {
    // Native shell entry points (called from Swift/Kotlin via evaluateJavaScript).
    if (typeof window !== "undefined") {
      window.__cypherLifecycle = {
        onPause: () => this.handlePause(),
        onResume: () => this.handleResume(),
      };
    }

    // Web/electron-safe fallback. On iOS this also fires and is deduped by the
    // idempotent, serialized pause/resume below. On Android it is the sole
    // driver: the WebView reports visibility in both directions (verified on
    // device) and Capacitor keeps JS running in the background long enough for
    // the flush to drain, so no native bridge is needed there.
    const onVisibility = () => {
      if (document.hidden) this.handlePause();
      else this.handleResume();
    };
    const onPageHide = () => this.handlePause();

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
      window.addEventListener("pagehide", onPageHide);
    }

    return () => {
      if (this.disposed) return;
      this.disposed = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
      }
      if (typeof window !== "undefined" && window.__cypherLifecycle) {
        delete window.__cypherLifecycle;
      }
    };
  }

  private handlePause(): void {
    this.enqueue(async () => {
      try {
        await this.replicator.pause();
      } catch (e) {
        console.error("[SyncLifecycle] pause failed:", e);
      } finally {
        // Release the native background task as soon as teardown completes,
        // rather than making the OS wait out its watchdog. No-op on web.
        try {
          getBridge()?.lifecycle?.endFlush();
        } catch {
          /* bridge unavailable — nothing to release */
        }
      }
    });
  }

  private handleResume(): void {
    this.enqueue(async () => {
      try {
        await this.replicator.resume();
      } catch (e) {
        console.error("[SyncLifecycle] resume failed:", e);
      }
    });
  }

  /** Chain work onto inFlight so pause/resume never overlap. */
  private enqueue(work: () => Promise<void>): void {
    this.inFlight = this.inFlight.then(work, work);
  }
}
