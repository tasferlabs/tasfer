/**
 * Presence grouping — one avatar per person in the active-users bar, however
 * many devices and tabs they are connected from.
 *
 * Presence arrives per replica: every tab of every device publishes its own
 * peer. Showing them raw makes one collaborator on a laptop and a phone look
 * like two people. Peers are folded by person where their host publishes a
 * `personId`, and by device otherwise — an unidentified peer stands on its
 * own rather than being merged into somebody else.
 */

import type { CursorUser } from "@tasfer/provider-core/cursors";

export interface PresencePerson {
  /** The peer that stands for this person in the avatar row. */
  user: CursorUser;
  /**
   * One peer per distinct device they are connected from, in first-seen order,
   * so a surface can both count the devices and name them.
   */
  devices: CursorUser[];
}

/** Peers sharing this key are the same human. */
function personKey(user: CursorUser): string {
  return user.personId ?? user.deviceId ?? user.peerId;
}

/** Peers sharing this key are the same device, e.g. two tabs of one browser. */
function deviceKey(user: CursorUser): string {
  return user.deviceId ?? user.peerId;
}

/**
 * Fold connected peers into one entry per person, in first-seen order, with
 * the number of devices each is here from.
 */
export function groupPresenceByPerson(users: CursorUser[]): PresencePerson[] {
  const devicesByPerson = new Map<string, Map<string, CursorUser>>();
  const order: { key: string; user: CursorUser }[] = [];

  for (const user of users) {
    const key = personKey(user);
    const devices = devicesByPerson.get(key);
    if (devices) {
      // First tab wins: extra tabs of a device add nothing to name it by.
      if (!devices.has(deviceKey(user))) devices.set(deviceKey(user), user);
      continue;
    }
    devicesByPerson.set(key, new Map([[deviceKey(user), user]]));
    order.push({ key, user });
  }

  return order.map(({ key, user }) => ({
    user,
    devices: [...devicesByPerson.get(key)!.values()],
  }));
}
