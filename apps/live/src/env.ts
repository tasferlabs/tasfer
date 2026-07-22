import type { TurnBudget } from "./turn-budget";

export interface Env {
  SIGNAL_ROOM: DurableObjectNamespace;
  TURN_BUDGET: DurableObjectNamespace<TurnBudget>;
  /** Cloudflare Calls TURN key ID — set via: wrangler secret put TURN_KEY_ID */
  TURN_KEY_ID: string;
  /** Cloudflare Calls TURN API token — set via: wrangler secret put TURN_API_TOKEN */
  TURN_API_TOKEN: string;
}
