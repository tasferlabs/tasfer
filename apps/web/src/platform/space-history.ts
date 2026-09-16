/**
 * Space settings history, derived from a space's operation log for the
 * Timeline.
 *
 * Nothing here is stored: the log already holds every settings change with its
 * author, so the history is a read-time projection like any other. Only the
 * settings a person changes are surfaced — name, the personal flag, and who
 * joined. Page ops and profile edits (`member_set`) are not settings changes.
 */

import type { SpaceOperation } from "./types";

/** One op from the log, with the wall time this replica stored it at. */
export interface StoredSpaceOp {
  op: SpaceOperation;
  /** Unix ms when this replica wrote the row (`ops.timestamp`). */
  storedAt: number;
}

interface SpaceHistoryBase {
  /** The op id, stable across replicas. */
  id: string;
  spaceId: string;
  /** ISO timestamp the change was made (see {@link changeTime}). */
  at: string;
  /** Device key that made the change. */
  byKey: string;
  /** Display name of the author, or null when this replica never learned it. */
  byName: string | null;
  /** The change was made on one of this person's own devices. */
  byYou: boolean;
}

export type SpaceHistoryEntry = SpaceHistoryBase &
  (
    | { kind: "created"; name: string; personal: boolean }
    | { kind: "renamed"; from: string; to: string }
    | { kind: "madePersonal"; name: string }
    | {
        kind: "memberJoined";
        name: string;
        memberKey: string;
        memberName: string;
        /**
         * The note this person wrote for the joining device, when it is one of
         * their own. Notes never reach co-members, so another person's device
         * has none.
         */
        memberNote: string | null;
      }
  );

export interface SpaceHistoryContext {
  spaceId: string;
  /** Whether the space admits only this person's devices. */
  personal: boolean;
  /** Log rows in merge order: `clock`, then `peer_id`. */
  ops: StoredSpaceOp[];
  /** Latest known display name per member device key. */
  memberNames: ReadonlyMap<string, string>;
  /** Root ("person") key per certified device key. */
  deviceRoots: ReadonlyMap<string, string>;
  /** This person's notes for their own devices, by device key. */
  deviceNotes: ReadonlyMap<string, string>;
  /** This person's own device keys. */
  ownKeys: ReadonlySet<string>;
  /** This person's root key, when the identity has one. */
  ownRoot: string | null;
}

/**
 * When a change was made.
 *
 * Ops written since the Timeline carry `at`, the author's wall clock. Older ops
 * only have the time this replica stored them, which for a change that came
 * from a peer is when it arrived. `at` is capped at the arrival time so a peer
 * with a clock running ahead cannot place its change in the future.
 */
export function changeTime({ op, storedAt }: StoredSpaceOp): number {
  const at = op.at;
  if (typeof at === "number" && Number.isFinite(at) && at > 0) {
    return Math.min(at, storedAt);
  }
  return storedAt;
}

/** Settings changes in a space, oldest first. */
export function buildSpaceHistory(ctx: SpaceHistoryContext): SpaceHistoryEntry[] {
  const person = (key: string) => ctx.deviceRoots.get(key) ?? key;
  const isOwn = (key: string) =>
    ctx.ownKeys.has(key) ||
    (ctx.ownRoot !== null && ctx.deviceRoots.get(key) === ctx.ownRoot);

  const out: SpaceHistoryEntry[] = [];
  let name: string | null = null;
  let created: Extract<SpaceHistoryEntry, { kind: "created" }> | null = null;
  let createdClock: { counter: number; peerId: string } | null = null;
  let personal = false;
  const joined = new Set<string>();

  for (const row of ctx.ops) {
    const { op } = row;
    const base: SpaceHistoryBase = {
      id: op.id,
      spaceId: ctx.spaceId,
      at: new Date(changeTime(row)).toISOString(),
      byKey: op.clock.peerId,
      byName: ctx.memberNames.get(op.clock.peerId) ?? null,
      byYou: isOwn(op.clock.peerId),
    };

    if (op.op === "space_set" && op.field === "name") {
      if (typeof op.value !== "string") continue;
      if (created === null) {
        created = { ...base, kind: "created", name: op.value, personal: false };
        createdClock = op.clock;
        // The creator is a member from the start; their own member_add is
        // part of creating the space, not someone joining it.
        joined.add(person(op.clock.peerId));
        out.push(created);
      } else if (op.value !== name) {
        out.push({ ...base, kind: "renamed", from: name ?? "", to: op.value });
      }
      name = op.value;
    } else if (op.op === "space_set" && op.field === "personal") {
      // Monotonic, like the merge: only the first `true` is a change.
      if (op.value !== true || personal) continue;
      personal = true;
      // `spaces.create` emits the flag right after the name, so a personal
      // space reads as created personal rather than created, then converted.
      if (
        created &&
        createdClock &&
        op.clock.peerId === createdClock.peerId &&
        op.clock.counter === createdClock.counter + 1
      ) {
        created.personal = true;
        continue;
      }
      out.push({ ...base, kind: "madePersonal", name: name ?? "" });
    } else if (op.op === "member_add") {
      // One entry per person: linking another of your devices enrolls it in
      // every space, which is not news to anyone in them.
      const who = person(op.publicKey);
      if (joined.has(who)) continue;
      joined.add(who);
      // A personal space never shows a member who is not this person's.
      if (ctx.personal && !isOwn(op.publicKey)) continue;
      out.push({
        ...base,
        kind: "memberJoined",
        name: name ?? "",
        memberKey: op.publicKey,
        memberName: ctx.memberNames.get(op.publicKey) ?? op.name,
        memberNote: isOwn(op.publicKey)
          ? ctx.deviceNotes.get(op.publicKey)?.trim() || null
          : null,
      });
    }
  }
  return out;
}
