/**
 * Two devices that change the same page or space field while apart must show
 * the same value once they swap ops. A device's own change used to be left out
 * of the winners it checks incoming ops against, so each device took the
 * other's change and the two ended up swapped for good.
 */

import { describe, expect, it } from "vitest";
import { Engine } from "./engine";
import { memoryEngine } from "./memoryEngine.testing";
import type { SpaceOperation } from "./types";

const SPACE = "sp-sync";
const AUTHOR = "author-key";

async function device() {
  const d = await memoryEngine();
  const sent: SpaceOperation[] = [];
  d.engine.setReplicator({
    pushSpaceOps: (_spaceId: string, ops: SpaceOperation[]) => {
      sent.push(...ops);
    },
    pushPageOps: () => {},
    onPeerReady: () => () => {},
    addPeer: async () => {},
  } as never);
  return { ...d, sent };
}

/** Two devices in one space, both holding a page the first one made. */
async function pair() {
  const a = await device();
  const b = await device();
  const start = [
    { op: "space_set", field: "name", value: "Shared" },
    { op: "member_add", publicKey: a.publicKey, name: "A" },
    { op: "member_add", publicKey: b.publicKey, name: "B" },
  ].map((p, i) => ({
    ...p,
    id: `${AUTHOR}:${i + 1}`,
    clock: { counter: i + 1, peerId: AUTHOR },
    spaceId: SPACE,
    at: 1_000 + i,
  })) as SpaceOperation[];
  await a.engine.handleRemoteSpaceOps(SPACE, start);
  await b.engine.handleRemoteSpaceOps(SPACE, start);
  const page = await a.engine.pages.create({
    title: "Plan",
    parentId: null,
    spaceId: SPACE,
  });
  await b.engine.handleRemoteSpaceOps(SPACE, a.sent.splice(0));
  const swap = async () => {
    const fromA = a.sent.splice(0);
    const fromB = b.sent.splice(0);
    await a.engine.handleRemoteSpaceOps(SPACE, fromB);
    await b.engine.handleRemoteSpaceOps(SPACE, fromA);
  };
  return { a, b, pageId: page.id, swap };
}

describe("space field convergence", () => {
  it("agrees on a page field both devices changed apart", async () => {
    const { a, b, pageId, swap } = await pair();
    await a.engine.pages.update({ id: pageId, color: "red" });
    await b.engine.pages.update({ id: pageId, color: "blue" });
    await swap();

    const onA = (await a.engine.pages.get(pageId)).color;
    const onB = (await b.engine.pages.get(pageId)).color;
    expect(onA).toBe(onB);
  });

  it("keeps a newer local change over an older one that arrives later", async () => {
    const { a, b, pageId, swap } = await pair();
    // B's change is older: A makes two changes after it.
    await b.engine.pages.update({ id: pageId, color: "blue" });
    await a.engine.pages.update({ id: pageId, color: "green" });
    await a.engine.pages.update({ id: pageId, color: "red" });
    await swap();

    expect((await a.engine.pages.get(pageId)).color).toBe("red");
    expect((await b.engine.pages.get(pageId)).color).toBe("red");
  });

  it("agrees on a space name both devices changed apart", async () => {
    const { a, b, swap } = await pair();
    await a.engine.spaces.rename(SPACE, "From A");
    await b.engine.spaces.rename(SPACE, "From B");
    await swap();

    const name = async (e: Engine) =>
      (await e.spaces.list()).find((s) => s.id === SPACE)?.name;
    expect(await name(a.engine)).toBe(await name(b.engine));
  });

  it("repairs a field that already went wrong, on upgrade", async () => {
    const { a, b, pageId, swap } = await pair();
    await a.engine.pages.update({ id: pageId, color: "red" });
    await b.engine.pages.update({ id: pageId, color: "blue" });
    await swap();
    const winner = (await b.engine.pages.get(pageId)).color;

    // What an older build left behind: the log is right, the row is not.
    const wrong = winner === "red" ? "blue" : "red";
    await a.driver.db.mutate("UPDATE pages SET color = ? WHERE id = ?", [
      wrong,
      pageId,
    ]);
    await a.driver.db.exec("PRAGMA user_version = 1");

    const upgraded = new Engine(a.driver);
    await upgraded.init();
    expect((await upgraded.pages.get(pageId)).color).toBe(winner);
  });
});
