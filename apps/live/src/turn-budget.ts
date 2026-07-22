/**
 * TurnBudget — Cloudflare Durable Object (singleton)
 *
 * Global daily ceiling on TURN credential mints. Per-peer throttles and
 * per-room caches (signal-room.ts) keep honest traffic bounded, but they do
 * nothing against an attacker spread across many rooms and addresses — the
 * only real bound on the bandwidth bill is a global cap. One instance
 * (named "global") counts mints per UTC day; past the ceiling, rooms answer
 * turn-requests with an error and clients degrade to STUN-only until the
 * day rolls over.
 */

import { DurableObject } from "cloudflare:workers";

/**
 * Each mint serves a whole room for up to 20 minutes (see the room cache in
 * signal-room.ts), so this buys roughly 1,600 room-hours of TURN per day.
 * Bump as real usage warrants.
 */
const DAILY_MINT_BUDGET = 5000;

interface BudgetState {
  day: string;
  count: number;
}

export class TurnBudget extends DurableObject {
  /** Consume one mint from today's budget. False means the ceiling is hit. */
  async tryConsume(): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const state = await this.ctx.storage.get<BudgetState>("budget");
    const count = state?.day === today ? state.count : 0;
    if (count >= DAILY_MINT_BUDGET) return false;
    await this.ctx.storage.put<BudgetState>("budget", { day: today, count: count + 1 });
    return true;
  }
}
