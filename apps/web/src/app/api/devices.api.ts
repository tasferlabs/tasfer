/**
 * Devices API — the person's own machines and the notes that tell them apart.
 *
 * A note is person-private: the engine replicates it to this person's other
 * devices and to no co-member, which is what lets any of them say which device
 * is which (see `platform.devices`).
 */

import { useEffect, useState } from "react";
import { getPlatform } from "@/platform";
import type { DeviceInfo } from "@/platform";

/** Label one of this person's devices, here or from across the link. */
export async function setDeviceNote(
  publicKey: string,
  note: string,
): Promise<void> {
  await getPlatform().devices.setNote(publicKey, note);
}

/**
 * This person's linked devices, kept current as they are linked and renamed —
 * a rename made on another of their devices lands here too.
 */
export function useOwnDevices(): DeviceInfo[] {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);

  useEffect(() => {
    const platform = getPlatform();
    let cancelled = false;

    const read = () => {
      platform.devices
        .list()
        .then((next) => {
          if (!cancelled) setDevices(next);
        })
        .catch((err) => console.warn("[Devices] Failed to list devices:", err));
    };

    // Subscribe before the first read: an event that lands while it is in
    // flight describes a later moment than the read does, and re-reading is
    // how it gets applied.
    const unsubscribe = platform.devices.onChange(read);
    read();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return devices;
}
