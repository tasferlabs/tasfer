import { beforeEach, describe, expect, it, vi } from "vitest";

import { acceptInvite } from "./spaces.api";
import type { SpaceInvite } from "@/platform/types";

const listArchived = vi.fn();
const unarchive = vi.fn();
const pairingAccept = vi.fn();

vi.mock("@/platform", () => ({
  getPlatform: () => ({
    spaces: { listArchived, unarchive },
    pairing: { acceptInvite: pairingAccept },
  }),
}));

const invite: SpaceInvite = {
  secret: "s".repeat(64),
  spaceId: "space-1",
  expiresAt: Date.now() + 60_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  listArchived.mockResolvedValue([]);
});

describe("accepting an invite to a space we already have", () => {
  it("restores an archived space instead of pairing again", async () => {
    listArchived.mockResolvedValue([
      { id: "space-1", name: "Studio", archivedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    const result = await acceptInvite(invite);

    expect(result).toEqual({ status: "restored", spaceName: "Studio" });
    expect(unarchive).toHaveBeenCalledWith("space-1");
    // Nothing to negotiate: the ops, membership and peer keys never left.
    expect(pairingAccept).not.toHaveBeenCalled();
  });

  it("pairs for a space this device has never held", async () => {
    const result = await acceptInvite(invite);

    expect(result).toEqual({ status: "paired" });
    expect(pairingAccept).toHaveBeenCalledOnce();
    expect(unarchive).not.toHaveBeenCalled();
  });

  it("pairs when the archive holds a different space", async () => {
    listArchived.mockResolvedValue([
      { id: "space-2", name: "Other", archivedAt: "2026-01-01T00:00:00.000Z" },
    ]);

    await acceptInvite(invite);

    expect(pairingAccept).toHaveBeenCalledOnce();
    expect(unarchive).not.toHaveBeenCalled();
  });
});
