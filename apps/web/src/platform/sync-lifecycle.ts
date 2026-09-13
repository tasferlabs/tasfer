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
 *   1. Native shell — iOS calls `window.__tasferLifecycle.onPause/onResume`
 *      via evaluateJavaScript, wrapped in a `beginBackgroundTask` window. When
 *      teardown finishes we call `bridge.lifecycle.endFlush()` to release that
 *      task early.
 *   2. Visibility events, for hosts where losing the foreground means losing
 *      the JS loop. See {@link SyncLifecycleOptions.suspendsWhenBackgrounded} —
 *      electron opts out, because on desktop a backgrounded window is still a
 *      running process and tearing sync down there is pure churn.
 *
 * Connectivity events (`offline`/`online`) drive it on every host: a network
 * that went away really did take the sockets with it.
 *
 * It owns no sync state; it is a thin coordinator over the Replicator.
 */

import { getBridge } from "./bridge";
import type { Replicator } from "./sync";

declare global {
  interface Window {
    __tasferLifecycle?: {
      onPause(): void;
      onResume(): void;
    };
  }
}

export interface SyncLifecycleOptions {
  /**
   * Whether the host suspends our JS loop when the app leaves the foreground.
   *
   * True on Capacitor (iOS/Android), where the OS freezes the WebView and the
   * sockets die with no clean teardown — so we pause first and reconnect on
   * the way back in.
   *
   * False on electron. A desktop window that is hidden, minimized, occluded by
   * another app, or closed to the tray keeps running: `BrowserWindow.hide()`
   * and macOS occlusion both flip `document.hidden`, but nothing about the
   * connections has changed. Pausing on that signal tore down every peer and
   * every per-topic signaling socket on each app switch, then rebuilt them all
   * — with fresh ICE — the moment the window came back.
   */
  suspendsWhenBackgrounded: boolean;
}

export class SyncLifecycleController {
  private replicator: Replicator;
  private suspendsWhenBackgrounded: boolean;
  /** Serializes pause/resume so a resume can't race an unfinished pause. */
  private inFlight: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(replicator: Replicator, options: SyncLifecycleOptions) {
    this.replicator = replicator;
    this.suspendsWhenBackgrounded = options.suspendsWhenBackgrounded;
  }

  /**
   * Wire up native + web lifecycle events. Returns a disposer that removes the
   * listeners and clears the global — call it before re-installing (e.g. HMR).
   */
  install(): () => void {
    // Native shell entry points (called from Swift/Kotlin via evaluateJavaScript).
    if (typeof window !== "undefined") {
      window.__tasferLifecycle = {
        onPause: () => this.handlePause(),
        onResume: () => this.handleResume(),
      };
    }

    // On iOS this also fires and is deduped by the idempotent, serialized
    // pause/resume below. On Android it is the sole driver: the WebView reports
    // visibility in both directions (verified on device) and Capacitor keeps JS
    // running in the background long enough for the flush to drain, so no
    // native bridge is needed there.
    const onVisibility = () => {
      if (document.hidden) this.handlePause();
      else this.handleResume();
    };
    // A teardown on the way out is still right on electron: the page is going
    // away for real, so flushing beats letting the sockets drop mid-round.
    const onPageHide = () => this.handlePause();
    const onOffline = () => this.handlePause();
    const onOnline = () => {
      // Where visibility does not gate sync, a hidden window coming back onto
      // a live network still wants its peers back.
      if (!this.suspendsWhenBackgrounded || !document.hidden)
        this.handleResume();
    };

    if (typeof document !== "undefined") {
      if (this.suspendsWhenBackgrounded) {
        document.addEventListener("visibilitychange", onVisibility);
      }
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("offline", onOffline);
      window.addEventListener("online", onOnline);
    }

    return () => {
      if (this.disposed) return;
      this.disposed = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", onOnline);
      }
      if (typeof window !== "undefined" && window.__tasferLifecycle) {
        delete window.__tasferLifecycle;
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
