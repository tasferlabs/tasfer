/**
 * Unit tests for the command-bus primitive (`command-bus.ts`).
 *
 * These exercise the bus *mechanics* — command shapes, priority ordering,
 * override/observe semantics, unsubscribe, and the `dispatchState` threading —
 * without building a real `EditorState`. A minimal fake state object, cast to
 * `EditorState`, is enough: the transforms here only read/write a tiny shape and
 * emit sentinel ops, so the bus's plumbing is what's under test, not the editor.
 */

import {
  command,
  createCommandBus,
  isMutationCommand,
  isStateCommand,
  stateCommand,
  type StateResult,
} from "./command-bus";
import type { ChangeApi } from "./entries/editor";
import type { EditorState, Operation } from "./state-types";
import { describe, expect, it } from "vitest";

// ─── Fixtures ────────────────────────────────────────────────────────────────

/** A tiny stand-in for `EditorState` — only the cursor offset is meaningful. */
function fakeState(cursor = 0): EditorState {
  return { document: { cursor } } as unknown as EditorState;
}

function cursorOf(state: EditorState): number {
  return (state as unknown as { document: { cursor: number } }).document.cursor;
}

/** A sentinel op tagged with a label so tests can assert on accumulation/order. */
function sentinelOp(tag: string): Operation {
  return { type: tag } as unknown as Operation;
}

function opTags(result: StateResult): string[] {
  return result.ops.map((op) => (op as unknown as { type: string }).type);
}

// ─── Command construction & narrowing ────────────────────────────────────────

describe("command construction and narrowing", () => {
  it("command(name) makes a plain command (no mutate/transform)", () => {
    const c = command<{ url: string }>("open-link");
    expect(c.name).toBe("open-link");
    expect(isMutationCommand(c)).toBe(false);
    expect(isStateCommand(c)).toBe(false);
  });

  it("command(name, mutate) makes a mutation command", () => {
    const mutate = (_c: ChangeApi, _p: void) => {};
    const c = command("insert-bullet", mutate);
    expect(c.name).toBe("insert-bullet");
    expect(c.mutate).toBe(mutate);
    expect(isMutationCommand(c)).toBe(true);
    expect(isStateCommand(c)).toBe(false);
  });

  it("stateCommand(name, transform) makes a state command", () => {
    const transform = (state: EditorState) => ({ state, ops: [] });
    const c = stateCommand("move-cursor-left", transform);
    expect(c.name).toBe("move-cursor-left");
    expect(c.transform).toBe(transform);
    expect(isStateCommand(c)).toBe(true);
    expect(isMutationCommand(c)).toBe(false);
  });

  it("narrowers gate on the right field, not on each other", () => {
    const plain = command("plain");
    const mut = command("mut", () => {});
    const st = stateCommand("st", (state) => ({ state, ops: [] }));

    expect(isMutationCommand(plain)).toBe(false);
    expect(isStateCommand(plain)).toBe(false);
    expect(isMutationCommand(mut)).toBe(true);
    expect(isStateCommand(mut)).toBe(false);
    expect(isStateCommand(st)).toBe(true);
    expect(isMutationCommand(st)).toBe(false);
  });
});

// ─── dispatch: priority, override, observe ───────────────────────────────────

describe("dispatch priority and override/observe semantics", () => {
  it("walks handlers high→low priority", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const order: string[] = [];

    bus.register(cmd, () => void order.push("low"), 0);
    bus.register(cmd, () => void order.push("high"), 10);
    bus.register(cmd, () => void order.push("mid"), 5);

    bus.dispatch(cmd);
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("a handler returning true claims it and stops propagation", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const seen: string[] = [];

    bus.register(cmd, () => void seen.push("low"), 0);
    bus.register(
      cmd,
      () => {
        seen.push("high");
        return true;
      },
      10,
    );

    const claimed = bus.dispatch(cmd);
    expect(claimed).toBe(true);
    // Lower-priority handler must not run after a claim.
    expect(seen).toEqual(["high"]);
  });

  it("false/void observes and lets propagation continue", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const seen: string[] = [];

    bus.register(cmd, () => {
      seen.push("a");
      return false;
    });
    bus.register(cmd, () => {
      seen.push("b");
      // returns undefined (void)
    });

    const claimed = bus.dispatch(cmd);
    expect(claimed).toBe(false);
    expect(seen).toEqual(["a", "b"]);
  });

  it("returns false when no handlers are registered", () => {
    const bus = createCommandBus();
    expect(bus.dispatch(command("none"))).toBe(false);
  });

  it("passes the payload through to handlers", () => {
    const bus = createCommandBus();
    const cmd = command<{ url: string }>("open-link");
    let received: string | undefined;
    bus.register(cmd, (p) => void (received = p.url));
    bus.dispatch(cmd, { url: "https://example.com" });
    expect(received).toBe("https://example.com");
  });
});

// ─── registration order, unsubscribe, mid-dispatch mutation ──────────────────

describe("registration order and unsubscribe", () => {
  it("equal priority preserves registration order", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const order: string[] = [];

    bus.register(cmd, () => void order.push("first"));
    bus.register(cmd, () => void order.push("second"));
    bus.register(cmd, () => void order.push("third"));

    bus.dispatch(cmd);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("the unsubscribe function removes the handler", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const seen: string[] = [];

    const off = bus.register(cmd, () => void seen.push("a"));
    bus.register(cmd, () => void seen.push("b"));

    off();
    bus.dispatch(cmd);
    expect(seen).toEqual(["b"]);
  });

  it("a handler that unregisters itself mid-dispatch doesn't corrupt the walk", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const seen: string[] = [];

    const off = bus.register(
      cmd,
      () => {
        seen.push("self");
        off(); // remove during dispatch
      },
      10,
    );
    bus.register(cmd, () => void seen.push("other"), 0);

    bus.dispatch(cmd);
    // Both still run this pass (dispatch walks a snapshot copy).
    expect(seen).toEqual(["self", "other"]);

    // Next dispatch reflects the removal.
    seen.length = 0;
    bus.dispatch(cmd);
    expect(seen).toEqual(["other"]);
  });

  it("a handler that registers a new handler mid-dispatch doesn't run it this pass", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const seen: string[] = [];

    bus.register(
      cmd,
      () => {
        seen.push("first");
        bus.register(cmd, () => void seen.push("late"), 100);
      },
      10,
    );

    bus.dispatch(cmd);
    expect(seen).toEqual(["first"]);

    seen.length = 0;
    bus.dispatch(cmd);
    // The late handler is highest priority, so it now runs first.
    expect(seen).toEqual(["late", "first"]);
  });

  it("handlersFor returns handlers high→low priority", () => {
    const bus = createCommandBus();
    const cmd = command("c");
    const high = () => {};
    const low = () => {};
    bus.register(cmd, low, 0);
    bus.register(cmd, high, 10);
    expect(bus.handlersFor(cmd)).toEqual([high, low]);
  });
});

// ─── dispatchState: threading state + accumulating ops ───────────────────────

describe("dispatchState threading and op accumulation", () => {
  it("runs the default transform when there are no observers", () => {
    const bus = createCommandBus();
    const cmd = stateCommand("move", (state) => ({
      state: fakeState(cursorOf(state) + 1),
      ops: [sentinelOp("default")],
    }));

    const result = bus.dispatchState(cmd, fakeState(0));
    expect(cursorOf(result.state)).toBe(1);
    expect(opTags(result)).toEqual(["default"]);
  });

  it("threads state through observers (high→low) then the default", () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    const cmd = stateCommand("move", (state) => {
      seen.push("default");
      return {
        state: fakeState(cursorOf(state) + 100),
        ops: [sentinelOp("default")],
      };
    });

    // Each observer increments the cursor and records the value it saw.
    bus.register(
      cmd,
      ((state: EditorState) => {
        seen.push(`low@${cursorOf(state)}`);
        return {
          state: fakeState(cursorOf(state) + 1),
          ops: [sentinelOp("low")],
        };
      }) as never,
      0,
    );
    bus.register(
      cmd,
      ((state: EditorState) => {
        seen.push(`high@${cursorOf(state)}`);
        return {
          state: fakeState(cursorOf(state) + 1),
          ops: [sentinelOp("high")],
        };
      }) as never,
      10,
    );

    const result = bus.dispatchState(cmd, fakeState(0));
    // high sees 0 → 1; low sees 1 → 2; default sees 2 → 102.
    expect(seen).toEqual(["high@0", "low@1", "default"]);
    expect(cursorOf(result.state)).toBe(102);
    // Ops accumulate in execution order: observers first, then default.
    expect(opTags(result)).toEqual(["high", "low", "default"]);
  });

  it("an observer returning handled:true overrides and skips the default", () => {
    const bus = createCommandBus();
    let defaultRan = false;
    const cmd = stateCommand("move", (state) => {
      defaultRan = true;
      return { state, ops: [sentinelOp("default")] };
    });

    bus.register(
      cmd,
      ((state: EditorState) => ({
        state: fakeState(cursorOf(state) + 5),
        ops: [sentinelOp("override")],
        handled: true,
      })) as never,
      10,
    );

    const result = bus.dispatchState(cmd, fakeState(0));
    expect(defaultRan).toBe(false);
    expect(cursorOf(result.state)).toBe(5);
    expect(opTags(result)).toEqual(["override"]);
  });

  it("handled:true stops lower-priority observers too", () => {
    const bus = createCommandBus();
    const seen: string[] = [];
    const cmd = stateCommand("move", (state) => ({ state, ops: [] }));

    bus.register(
      cmd,
      ((state: EditorState) => {
        seen.push("high");
        return { state, ops: [sentinelOp("high")], handled: true };
      }) as never,
      10,
    );
    bus.register(
      cmd,
      ((state: EditorState) => {
        seen.push("low");
        return { state, ops: [sentinelOp("low")] };
      }) as never,
      0,
    );

    const result = bus.dispatchState(cmd, fakeState(0));
    expect(seen).toEqual(["high"]);
    expect(opTags(result)).toEqual(["high"]);
  });

  it("a void observer passes through without changing state or ops", () => {
    const bus = createCommandBus();
    const cmd = stateCommand("move", (state) => ({
      state: fakeState(cursorOf(state) + 1),
      ops: [sentinelOp("default")],
    }));

    let observed = -1;
    bus.register(
      cmd,
      ((state: EditorState) => {
        observed = cursorOf(state);
        // returns void — observe only
      }) as never,
      10,
    );

    const result = bus.dispatchState(cmd, fakeState(7));
    expect(observed).toBe(7);
    // Default still ran on the untouched state.
    expect(cursorOf(result.state)).toBe(8);
    expect(opTags(result)).toEqual(["default"]);
  });

  it("concatenates ops across multiple observers and the default", () => {
    const bus = createCommandBus();
    const cmd = stateCommand("move", (state) => ({
      state,
      ops: [sentinelOp("d1"), sentinelOp("d2")],
    }));

    bus.register(
      cmd,
      ((state: EditorState) => ({ state, ops: [sentinelOp("a")] })) as never,
      10,
    );
    bus.register(
      cmd,
      ((state: EditorState) => ({
        state,
        ops: [sentinelOp("b1"), sentinelOp("b2")],
      })) as never,
      5,
    );

    const result = bus.dispatchState(cmd, fakeState(0));
    expect(opTags(result)).toEqual(["a", "b1", "b2", "d1", "d2"]);
  });

  it("passes the payload to observers and the default transform", () => {
    const bus = createCommandBus();
    const cmd = stateCommand<{ delta: number }>("move", (state, { delta }) => ({
      state: fakeState(cursorOf(state) + delta),
      ops: [],
    }));

    let observedDelta = 0;
    bus.register(
      cmd,
      ((state: EditorState, p: { delta: number }) => {
        observedDelta = p.delta;
      }) as never,
      10,
    );

    const result = bus.dispatchState(cmd, fakeState(0), { delta: 3 });
    expect(observedDelta).toBe(3);
    expect(cursorOf(result.state)).toBe(3);
  });
});
