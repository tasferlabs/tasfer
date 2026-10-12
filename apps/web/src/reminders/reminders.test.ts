import { describe, expect, it } from "vitest";
import {
  MAX_PLANNED,
  PLAN_HORIZON_MS,
  effectiveReminder,
  planReminders,
  reminderBase,
  type ReminderEvent,
} from "./reminders";

const NOW = Date.parse("2026-10-12T10:00:00Z");

function event(over: Partial<ReminderEvent> & { id: string }): ReminderEvent {
  return {
    title: over.id,
    scheduledAt: "2026-10-12T12:00:00Z",
    allDay: false,
    ...over,
  };
}

describe("effectiveReminder", () => {
  it("prefers the event's own choice, including off", () => {
    expect(effectiveReminder({ allDay: false }, 30, 10)).toBe(30);
    expect(effectiveReminder({ allDay: false }, "off", 10)).toBe("off");
  });

  it("falls back to the default, then to 10 minutes", () => {
    expect(effectiveReminder({ allDay: false }, undefined, 5)).toBe(5);
    expect(effectiveReminder({ allDay: false }, null, "off")).toBe("off");
    expect(effectiveReminder({ allDay: false }, undefined, undefined)).toBe(10);
  });

  it("ignores values it does not understand", () => {
    expect(effectiveReminder({ allDay: false }, { soon: true }, 15)).toBe(15);
    expect(effectiveReminder({ allDay: false }, -5, "bogus")).toBe(10);
  });

  it("leaves all-day events silent unless asked", () => {
    expect(effectiveReminder({ allDay: true }, undefined, 10)).toBe("off");
    expect(effectiveReminder({ allDay: true }, 0, 10)).toBe(0);
  });
});

describe("reminderBase", () => {
  it("is the start for a timed event", () => {
    const e = event({ id: "a" });
    expect(reminderBase(e, "UTC")).toBe(Date.parse(e.scheduledAt));
  });

  it("is 09:00 of the day, in the display zone, for an all-day event", () => {
    const e = event({
      id: "a",
      allDay: true,
      scheduledAt: "2026-10-13T22:00:00Z",
    });
    // 22:00 UTC on the 13th is already the 14th in Riyadh (UTC+3).
    expect(reminderBase(e, "Asia/Riyadh")).toBe(
      Date.parse("2026-10-14T06:00:00Z"),
    );
  });
});

describe("planReminders", () => {
  it("plans each event at its offset, soonest first", () => {
    const plan = planReminders(
      [
        event({ id: "late", scheduledAt: "2026-10-12T15:00:00Z" }),
        event({ id: "soon", scheduledAt: "2026-10-12T11:00:00Z" }),
      ],
      (id) => (id === "late" ? 60 : undefined),
      10,
      NOW,
      "UTC",
    );
    expect(
      plan.map((r) => [r.entryId, new Date(r.fireAt).toISOString()]),
    ).toEqual([
      ["soon", "2026-10-12T10:50:00.000Z"],
      ["late", "2026-10-12T14:00:00.000Z"],
    ]);
  });

  it("skips reminders already due, turned off, or past the horizon", () => {
    const plan = planReminders(
      [
        event({ id: "past", scheduledAt: "2026-10-12T10:05:00Z" }),
        event({ id: "off" }),
        event({
          id: "far",
          scheduledAt: new Date(
            NOW + PLAN_HORIZON_MS + 3_600_000,
          ).toISOString(),
        }),
      ],
      (id) => (id === "off" ? "off" : undefined),
      10,
      NOW,
      "UTC",
    );
    expect(plan).toEqual([]);
  });

  it("keys a reminder by event and fire time, so a moved event re-plans", () => {
    const [before] = planReminders(
      [event({ id: "a" })],
      () => 0,
      10,
      NOW,
      "UTC",
    );
    const [after] = planReminders(
      [event({ id: "a", scheduledAt: "2026-10-12T13:00:00Z" })],
      () => 0,
      10,
      NOW,
      "UTC",
    );
    expect(before!.key).not.toBe(after!.key);
  });

  it("reads a repeating event's setting from its series", () => {
    const plan = planReminders(
      [
        event({
          id: "occ-1",
          seriesId: "series",
          scheduledAt: "2026-10-12T12:00:00Z",
        }),
        event({
          id: "occ-2",
          seriesId: "series",
          scheduledAt: "2026-10-13T12:00:00Z",
        }),
      ],
      (owner) => (owner === "series" ? 30 : undefined),
      10,
      NOW,
      "UTC",
    );
    expect(plan.map((r) => [r.entryId, r.minutesBefore])).toEqual([
      ["occ-1", 30],
      ["occ-2", 30],
    ]);
  });

  it("caps the plan below the iOS pending-notification limit", () => {
    const many = Array.from({ length: 100 }, (_, i) =>
      event({
        id: `e${i}`,
        scheduledAt: new Date(NOW + (i + 1) * 3_600_000).toISOString(),
      }),
    );
    const plan = planReminders(many, () => undefined, 10, NOW, "UTC");
    expect(plan).toHaveLength(MAX_PLANNED);
    expect(plan[0]!.entryId).toBe("e0");
  });
});

describe("planReminders for tasks", () => {
  it("does not remind about a task that is done", () => {
    const plan = planReminders(
      [
        event({ id: "open", scheduledAt: "2026-10-12T11:00:00Z" }),
        event({ id: "done", scheduledAt: "2026-10-12T11:00:00Z", done: true }),
      ],
      () => undefined,
      10,
      NOW,
      "UTC",
    );
    expect(plan.map((r) => r.entryId)).toEqual(["open"]);
  });
});
