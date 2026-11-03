import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { getCalendarPages } from "@/app/api/pages.api";
import { useOwnPref, useOwnPrefsStore } from "@/app/contexts/OwnPrefsContext";
import { useDateTimePrefs } from "@/app/contexts/DateTimePrefsContext";
import { getHour12, getResolvedTimezone } from "@/lib/dateTimePreferences";
import { usePrefEntries } from "@/lib/usePrefEntries";
import {
  createReminderDelivery,
  notificationPermission,
  requestNotificationPermission,
  type NotifyPermission,
  type ReminderDelivery,
} from "./delivery";
import {
  DEFAULT_REMINDER_KEY,
  PLAN_HORIZON_MS,
  REMINDER_PREF_PREFIX,
  planReminders,
  reminderMessage,
  type PlannedReminder,
} from "./reminders";

const HOUR_MS = 60 * 60_000;

interface RemindersContextValue {
  /** Whether this device may show notifications. */
  permission: NotifyPermission;
  /** Ask for it — from a click, or browsers ignore the request. */
  requestPermission(): Promise<NotifyPermission>;
  /** Whether reminders arrive while the app is closed (phones only). */
  background: boolean;
}

const RemindersContext = createContext<RemindersContextValue>({
  permission: "unsupported",
  requestPermission: async () => "unsupported",
  background: false,
});

export function useReminders(): RemindersContextValue {
  return useContext(RemindersContext);
}

/**
 * Plans this person's event reminders and keeps this device's delivery in step
 * with the plan: when an event moves, a reminder changes on another device, the
 * language or time zone changes, or an hour passes and the planning window
 * slides forward.
 */
export function RemindersProvider({ children }: { children: React.ReactNode }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const prefs = useOwnPrefsStore();
  const chosen = usePrefEntries(prefs, REMINDER_PREF_PREFIX);
  const { value: defaultSetting, loaded } = useOwnPref<unknown>(
    DEFAULT_REMINDER_KEY,
    undefined,
  );
  const dateTimePrefs = useDateTimePrefs();

  // Made in an effect, not a memo, so a remount (hot reload) never keeps
  // using a delivery the previous mount disposed. The channel name is fixed
  // once created; a language change later does not need a second delivery.
  const [delivery, setDelivery] = useState<ReminderDelivery | null>(null);
  useEffect(() => {
    const created = createReminderDelivery({
      channelName: t("reminders.channelName", "Event reminders"),
    });
    setDelivery(created);
    return () => created.dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => delivery?.onOpen((route) => navigate(route)),
    [delivery, navigate],
  );

  // The hour the planning window starts at. Advanced on the hour, and whenever
  // the app comes back to the foreground — a phone's timers stop while it is
  // in the background, and that is when the OS plan most needs topping up.
  const [hour, setHour] = useState(() => Math.floor(Date.now() / HOUR_MS));
  const [permission, setPermission] = useState<NotifyPermission>("unsupported");

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      setHour(Math.floor(Date.now() / HOUR_MS));
      void notificationPermission().then((p) => {
        if (!cancelled) setPermission(p);
      });
    };
    refresh();
    const timer = setInterval(refresh, HOUR_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const start = hour * HOUR_MS;
  // A day past the horizon, so an event whose "1 day before" falls inside it
  // is in the result too.
  const end = start + PLAN_HORIZON_MS + 2 * 24 * HOUR_MS;
  // Under the calendar's key, so every change that refreshes the grid — local
  // edits and peers' alike — refreshes the plan too.
  const { data: events } = useQuery({
    queryKey: ["calendar-pages", { reminders: true, start, end }],
    queryFn: () => getCalendarPages(start, end),
  });

  useEffect(() => {
    if (!delivery || !events || !loaded) return;
    const byPage = new Map(chosen);
    const timezone = getResolvedTimezone();
    const plan = planReminders(
      events,
      (ownerId) => byPage.get(`${REMINDER_PREF_PREFIX}${ownerId}`),
      defaultSetting,
      Date.now(),
      timezone,
    );
    const hour12 = getHour12();
    const language = i18n.language;
    void delivery.sync(plan, (reminder: PlannedReminder) =>
      reminderMessage(reminder, t, timezone, hour12, language),
    );
  }, [
    events,
    loaded,
    chosen,
    defaultSetting,
    dateTimePrefs,
    i18n.language,
    t,
    delivery,
    permission,
  ]);

  const requestPermission = useCallback(async () => {
    const next = await requestNotificationPermission();
    setPermission(next);
    return next;
  }, []);

  const value = useMemo(
    () => ({
      permission,
      requestPermission,
      background: delivery?.background ?? false,
    }),
    [permission, requestPermission, delivery],
  );

  return (
    <RemindersContext.Provider value={value}>
      {children}
    </RemindersContext.Provider>
  );
}
