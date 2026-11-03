import type { PlannedReminder } from "./reminders";
import { reminderRoute } from "./reminders";
import { getClientPlatform } from "@/platform";

/**
 * Getting a planned reminder in front of the person, on whichever platform
 * this is.
 *
 * - iOS / Android hand the whole plan to the OS (Capacitor local
 *   notifications), which fires it even while the app is closed.
 * - Desktop and the web keep a timer in the page and show a system
 *   notification when it runs out. The desktop app stays alive in the tray, so
 *   that is close to always; a browser only while a Tasfer tab is open.
 *
 * Every instance owns its own timers and listeners; nothing here is shared
 * between two schedulers.
 */

export type NotifyPermission = "granted" | "denied" | "prompt" | "unsupported";

export interface ReminderText {
  title: string;
  body: string;
}

export interface ReminderDelivery {
  /** Whether reminders still arrive once the app is closed. */
  readonly background: boolean;
  /** Replace the plan this device delivers from. */
  sync(
    plan: readonly PlannedReminder[],
    text: (reminder: PlannedReminder) => ReminderText,
  ): Promise<void>;
  /** Fires with the in-app route of a reminder the person opened. */
  onOpen(cb: (route: string) => void): () => void;
  dispose(): void;
}

/** A message the service worker posts when a reminder it showed is clicked. */
export const REMINDER_OPEN_MESSAGE = "REMINDER_OPEN";

/**
 * A reminder is still worth showing this long after it was due — a laptop
 * waking from sleep, a background tab whose timer was throttled. Later than
 * that it is about something already under way.
 */
const LATE_LIMIT_MS = 30 * 60_000;

// setTimeout overflows past 2^31-1 ms (~24.8 days) and fires at once.
const MAX_TIMER_MS = 2 ** 31 - 1;

// =============================================================================
// Permission
// =============================================================================

type LocalNotificationsModule = typeof import("@capacitor/local-notifications");

function isNative(): boolean {
  const platform = getClientPlatform();
  return platform === "ios" || platform === "android";
}

function loadLocalNotifications(): Promise<
  LocalNotificationsModule["LocalNotifications"]
> {
  return import("@capacitor/local-notifications").then(
    (m) => m.LocalNotifications,
  );
}

function fromNative(state: string): NotifyPermission {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  return "prompt";
}

function fromBrowser(state: NotificationPermission): NotifyPermission {
  if (state === "granted") return "granted";
  if (state === "denied") return "denied";
  return "prompt";
}

/** Whether this device may show notifications, without asking. */
export async function notificationPermission(): Promise<NotifyPermission> {
  if (isNative()) {
    try {
      const ln = await loadLocalNotifications();
      return fromNative((await ln.checkPermissions()).display);
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  return fromBrowser(Notification.permission);
}

/**
 * Ask for permission to show notifications. Browsers only show the prompt
 * from a user gesture, so call this from a click, not from an effect.
 */
export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (isNative()) {
    try {
      const ln = await loadLocalNotifications();
      return fromNative((await ln.requestPermissions()).display);
    } catch {
      return "unsupported";
    }
  }
  if (typeof Notification === "undefined") return "unsupported";
  if (Notification.permission !== "default") {
    return fromBrowser(Notification.permission);
  }
  return fromBrowser(await Notification.requestPermission());
}

/**
 * Android 12+ delivers a scheduled notification on time only with the "Alarms
 * & reminders" special access; without it the OS batches it, minutes late.
 * Null where the question does not arise (everywhere but Android).
 */
export async function exactTimingPermission(): Promise<NotifyPermission | null> {
  if (getClientPlatform() !== "android") return null;
  try {
    const ln = await loadLocalNotifications();
    return fromNative((await ln.checkExactNotificationSetting()).exact_alarm);
  } catch {
    return null;
  }
}

/** Open the Android system screen that grants exact timing. */
export async function openExactTimingSettings(): Promise<NotifyPermission | null> {
  if (getClientPlatform() !== "android") return null;
  try {
    const ln = await loadLocalNotifications();
    return fromNative((await ln.changeExactNotificationSetting()).exact_alarm);
  } catch {
    return null;
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createReminderDelivery(options: {
  /** Android channel name, shown in the system's notification settings. */
  channelName: string;
}): ReminderDelivery {
  if (isNative()) return new NativeDelivery(options.channelName);
  return new PageTimerDelivery();
}

// =============================================================================
// iOS / Android
// =============================================================================

const CHANNEL_ID = "reminders";

/**
 * A 31-bit notification id derived from what the notification says. Re-planning
 * the same reminder lands on the same id and leaves it alone; renaming or
 * moving the event changes the id, so the stale one is cancelled.
 */
function notificationId(reminder: PlannedReminder, text: ReminderText): number {
  const source = `${reminder.key}|${text.title}|${text.body}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Positive and non-zero: Android ids are Java ints.
  return hash & 0x7fffffff || 1;
}

class NativeDelivery implements ReminderDelivery {
  readonly background = true;
  private queue: Promise<void> = Promise.resolve();
  private listeners = new Set<(route: string) => void>();
  private handle: Promise<{ remove(): Promise<void> } | null>;
  private disposed = false;

  constructor(channelName: string) {
    this.handle = loadLocalNotifications()
      .then(async (ln) => {
        if (getClientPlatform() === "android") {
          await ln
            .createChannel({
              id: CHANNEL_ID,
              name: channelName,
              importance: 4,
              visibility: 1,
            })
            .catch(() => {});
        }
        return ln.addListener("localNotificationActionPerformed", (action) => {
          const route = action.notification.extra?.route;
          if (typeof route !== "string") return;
          for (const cb of this.listeners) cb(route);
        });
      })
      .catch((err) => {
        console.warn("[Reminders] notifications unavailable:", err);
        return null;
      });
  }

  sync(
    plan: readonly PlannedReminder[],
    text: (reminder: PlannedReminder) => ReminderText,
  ): Promise<void> {
    // One at a time: two overlapping syncs would each read the same pending
    // list and schedule the same reminder twice.
    this.queue = this.queue
      .then(() => this.apply(plan, text))
      .catch((err) => console.warn("[Reminders] could not schedule:", err));
    return this.queue;
  }

  private async apply(
    plan: readonly PlannedReminder[],
    text: (reminder: PlannedReminder) => ReminderText,
  ): Promise<void> {
    if (this.disposed) return;
    const ln = await loadLocalNotifications();
    if ((await ln.checkPermissions()).display !== "granted") return;

    const wanted = new Map<
      number,
      { reminder: PlannedReminder; text: ReminderText }
    >();
    for (const reminder of plan) {
      const t = text(reminder);
      wanted.set(notificationId(reminder, t), { reminder, text: t });
    }

    const { notifications: pending } = await ln.getPending();
    const pendingIds = new Set(pending.map((n) => n.id));
    // This app schedules no other local notifications, so whatever is pending
    // and not wanted is a reminder that no longer applies.
    const stale = pending.filter((n) => !wanted.has(n.id));
    if (stale.length > 0) {
      await ln.cancel({ notifications: stale.map((n) => ({ id: n.id })) });
    }

    const fresh = [...wanted].filter(([id]) => !pendingIds.has(id));
    if (fresh.length === 0) return;
    await ln.schedule({
      notifications: fresh.map(([id, { reminder, text: t }]) => ({
        id,
        title: t.title,
        body: t.body,
        schedule: { at: new Date(reminder.fireAt), allowWhileIdle: true },
        channelId: CHANNEL_ID,
        smallIcon: "ic_stat_tasfer",
        extra: {
          route: reminderRoute(reminder.entryId, reminder.scheduledAt),
        },
      })),
    });
  }

  onOpen(cb: (route: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    void this.handle.then((h) => h?.remove());
  }
}

// =============================================================================
// Desktop / web
// =============================================================================

/**
 * Keeps the plan in memory and arms one timer for the next reminder due.
 *
 * Several tabs of the web app each run a scheduler; a Web Lock makes one of
 * them the deliverer, and the next takes over when it closes. Only reminders
 * that come due while this tab holds the lock are shown, so reloading never
 * repeats one.
 */
class PageTimerDelivery implements ReminderDelivery {
  readonly background = false;
  private plan: readonly PlannedReminder[] = [];
  private text: ((reminder: PlannedReminder) => ReminderText) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Reminders due at or before this moment have been dealt with. */
  private cursor = Date.now();
  private leading = false;
  private releaseLock: (() => void) | null = null;
  private listeners = new Set<(route: string) => void>();
  private disposed = false;
  private stopMessages: (() => void) | null = null;

  constructor() {
    this.takeLead();
    this.listenToServiceWorker();
  }

  private takeLead() {
    const locks =
      typeof navigator !== "undefined" ? navigator.locks : undefined;
    if (!locks) {
      this.lead();
      return;
    }
    void locks
      .request(
        "tasfer.reminders",
        () =>
          new Promise<void>((release) => {
            if (this.disposed) {
              release();
              return;
            }
            this.releaseLock = release;
            this.lead();
          }),
      )
      .catch(() => {});
  }

  private lead() {
    this.leading = true;
    this.cursor = Date.now();
    this.arm();
  }

  private listenToServiceWorker() {
    const sw =
      typeof navigator !== "undefined" ? navigator.serviceWorker : undefined;
    if (!sw) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; route?: unknown } | null;
      if (data?.type !== REMINDER_OPEN_MESSAGE) return;
      if (typeof data.route === "string") this.open(data.route);
    };
    sw.addEventListener("message", onMessage);
    this.stopMessages = () => sw.removeEventListener("message", onMessage);
  }

  async sync(
    plan: readonly PlannedReminder[],
    text: (reminder: PlannedReminder) => ReminderText,
  ): Promise<void> {
    this.plan = plan;
    this.text = text;
    this.arm();
  }

  private arm() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.leading || this.disposed) return;
    const next = this.plan.find((r) => r.fireAt > this.cursor);
    if (!next) return;
    const wait = Math.min(Math.max(0, next.fireAt - Date.now()), MAX_TIMER_MS);
    this.timer = setTimeout(() => this.fire(), wait);
  }

  private fire() {
    this.timer = null;
    const now = Date.now();
    const due = this.plan.filter(
      (r) => r.fireAt > this.cursor && r.fireAt <= now,
    );
    this.cursor = now;
    for (const reminder of due) {
      if (now - reminder.fireAt > LATE_LIMIT_MS) continue;
      void this.show(reminder);
    }
    this.arm();
  }

  private async show(reminder: PlannedReminder) {
    if (!this.text) return;
    if (typeof Notification === "undefined") return;
    if (Notification.permission !== "granted") return;
    const { title, body } = this.text(reminder);
    const route = reminderRoute(reminder.entryId, reminder.scheduledAt);
    const options: NotificationOptions = {
      body,
      // The same reminder from two tabs, or two devices of one browser
      // profile, replaces itself instead of stacking.
      tag: reminder.key,
      icon: `${import.meta.env.BASE_URL}icon-192.png`,
      data: { route },
    };

    // A service worker notification is the one that still works once this tab
    // is gone, and the only kind Chrome on Android shows at all.
    const registration = await navigator.serviceWorker
      ?.getRegistration()
      .catch(() => undefined);
    if (registration?.active) {
      try {
        await registration.showNotification(title, options);
        return;
      } catch {
        // Fall through to a page notification.
      }
    }
    try {
      const notification = new Notification(title, options);
      notification.onclick = () => {
        notification.close();
        this.open(route);
      };
    } catch (err) {
      console.warn("[Reminders] could not show a notification:", err);
    }
  }

  private open(route: string) {
    window.focus();
    // The desktop window may be hidden in the tray.
    const bridge = (
      window as { tasfer?: { invoke(c: string): Promise<unknown> } }
    ).tasfer;
    void bridge?.invoke("app:show").catch(() => {});
    for (const cb of this.listeners) cb(route);
  }

  onOpen(cb: (route: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.stopMessages?.();
    this.releaseLock?.();
  }
}
