import { describe, expect, it } from "vitest";

import { groupPresenceByPerson } from "./presenceGroups";

function peer(
  peerId: string,
  deviceId?: string,
  personId?: string,
) {
  return { peerId, deviceId, personId };
}

describe("grouping presence by person", () => {
  it("shows a person once, with an entry per device", () => {
    const people = groupPresenceByPerson([
      peer("tab-1", "laptop", "root-a"),
      peer("tab-2", "phone", "root-a"),
      peer("tab-3", "desk", "root-b"),
    ]);

    expect(people.map((p) => [p.user.peerId, p.devices.length])).toEqual([
      ["tab-1", 2],
      ["tab-3", 1],
    ]);
  });

  it("names every device a person is here from", () => {
    const people = groupPresenceByPerson([
      peer("tab-1", "laptop", "root-a"),
      peer("tab-2", "phone", "root-a"),
    ]);

    expect(people[0].devices.map((d) => d.peerId)).toEqual(["tab-1", "tab-2"]);
  });

  it("counts two tabs of one device as one device", () => {
    const people = groupPresenceByPerson([
      peer("tab-1", "laptop", "root-a"),
      peer("tab-2", "laptop", "root-a"),
    ]);

    expect(people).toHaveLength(1);
    expect(people[0].devices.map((d) => d.peerId)).toEqual(["tab-1"]);
  });

  it("folds a device's own tabs together even with no person id", () => {
    // Presence from before device identity, or from a peer whose identity has
    // not finished bootstrapping.
    const people = groupPresenceByPerson([
      peer("tab-1", "laptop"),
      peer("tab-2", "laptop"),
    ]);

    expect(people.map((p) => p.user.peerId)).toEqual(["tab-1"]);
  });

  it("never folds unidentified peers into one another", () => {
    const people = groupPresenceByPerson([peer("tab-1"), peer("tab-2")]);

    expect(people).toHaveLength(2);
    expect(people.every((p) => p.devices.length === 1)).toBe(true);
  });

  it("keeps people in the order they appear", () => {
    const people = groupPresenceByPerson([
      peer("tab-1", "laptop", "root-a"),
      peer("tab-2", "desk", "root-b"),
      peer("tab-3", "phone", "root-a"),
    ]);

    expect(people.map((p) => p.user.peerId)).toEqual(["tab-1", "tab-2"]);
  });
});
