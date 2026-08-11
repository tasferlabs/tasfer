import { describe, expect, it } from "vitest";

import { groupMembersByPerson, type ISpaceMember } from "./spaces.api";

function member(
  id: string,
  rootKey: string | null,
  lastSeen: string | null = null,
): ISpaceMember {
  return {
    id,
    userId: id,
    createdAt: "2026-01-01T00:00:00.000Z",
    userName: id,
    userEmail: "",
    userAvatar: null,
    lastSeen,
    rootKey,
  };
}

describe("grouping space members by person", () => {
  it("shows one row per person, however many devices they have", () => {
    const grouped = groupMembersByPerson([
      member("laptop", "root-a"),
      member("phone", "root-a"),
      member("colleague", "root-b"),
    ]);

    expect(grouped.map((m) => m.rootKey)).toEqual(["root-a", "root-b"]);
  });

  it("keeps every device of a person on their row", () => {
    const grouped = groupMembersByPerson([
      member("laptop", "root-a"),
      member("phone", "root-a"),
      member("colleague", "root-b"),
    ]);

    expect(grouped.map((m) => m.devices.map((d) => d.id))).toEqual([
      ["laptop", "phone"],
      ["colleague"],
    ]);
  });

  it("represents a person by their most recently seen device", () => {
    const grouped = groupMembersByPerson([
      member("laptop", "root-a", "2026-01-01T00:00:00.000Z"),
      member("phone", "root-a", "2026-06-01T00:00:00.000Z"),
    ]);

    // Presence should answer "is this person around", not "is the device that
    // happened to join first around".
    expect(grouped.map((m) => m.id)).toEqual(["phone"]);
    expect(grouped[0].devices.map((d) => d.id)).toEqual(["phone", "laptop"]);
  });

  it("prefers a seen device over one that has never been seen", () => {
    const grouped = groupMembersByPerson([
      member("never", "root-a", null),
      member("seen", "root-a", "2026-06-01T00:00:00.000Z"),
    ]);

    expect(grouped.map((m) => m.id)).toEqual(["seen"]);
  });

  it("keeps the grouped row in the original list position", () => {
    const grouped = groupMembersByPerson([
      member("laptop", "root-a", "2026-01-01T00:00:00.000Z"),
      member("colleague", "root-b"),
      member("phone", "root-a", "2026-06-01T00:00:00.000Z"),
    ]);

    expect(grouped.map((m) => m.id)).toEqual(["phone", "colleague"]);
  });

  it("never merges devices with no known certificate", () => {
    // Two unidentified devices are not evidence of one person — collapsing
    // them would understate who can read the space.
    const grouped = groupMembersByPerson([
      member("unknown-1", null),
      member("unknown-2", null),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.every((m) => m.devices.length === 1)).toBe(true);
  });
});
