import { describe, expect, it } from "vitest";
import { FakeOwnPrefs } from "./fakeOwnPrefs.testing";
import {
  PALETTE_USAGE_PREF_PREFIX,
  readLegacyFrecency,
  readPaletteUsage,
  recordPaletteUse,
} from "./paletteUsage";

describe("paletteUsage", () => {
  it("adds up picks made on two devices at the same time", () => {
    const laptop = new FakeOwnPrefs("laptop");
    const phone = new FakeOwnPrefs("phone");
    recordPaletteUse(laptop, "page:a", 10);
    recordPaletteUse(laptop, "page:a", 20);
    recordPaletteUse(phone, "page:a", 30);

    laptop.syncFrom(phone);

    expect(readPaletteUsage(laptop)["page:a"]).toEqual({ count: 3, last: 30 });
  });

  it("adopts the old browser tally as this device's", () => {
    const raw = JSON.stringify({ "page:a": { count: 2, last: 5 } });
    expect(readLegacyFrecency(raw, "laptop")).toEqual([
      [
        PALETTE_USAGE_PREF_PREFIX + "laptop",
        { "page:a": { count: 2, last: 5 } },
      ],
    ]);
  });
});
