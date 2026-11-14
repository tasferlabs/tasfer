/**
 * TEMPORARY debug log for the iPhone "Backspace does nothing" hunt. Remove once
 * the cause is found.
 *
 * Each editor keeps its own ring buffer of what the input surface saw (keys,
 * input, composition, focus, selection moves) and what each frame did with the
 * queued keys. Read it from Safari's Web Inspector on the surface element:
 * `copy(document.activeElement.tasferInputLog())`.
 */

export interface InputLogEntry {
  readonly time: string;
  readonly event: string;
  readonly detail: Record<string, unknown>;
  readonly snapshot: Record<string, unknown>;
}

function clock(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function format(e: InputLogEntry): string {
  return `${e.time} ${e.event} ${JSON.stringify(e.detail)} | ${JSON.stringify(e.snapshot)}`;
}

export class InputLog {
  private readonly entries: InputLogEntry[] = [];

  private readonly limit: number;

  constructor(limit = 600) {
    this.limit = limit;
  }

  push(
    event: string,
    detail: Record<string, unknown>,
    snapshot: Record<string, unknown>,
  ): void {
    const entry = { time: clock(), event, detail, snapshot };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.shift();
    // Also to the console, so a host that forwards a device's console (the web
    // app's remote dev console) streams the log as it happens.
    console.debug(`[input-log] ${format(entry)}`);
  }

  dump(): string {
    return this.entries.map(format).join("\n");
  }
}

/** Surface events the log records, after the editor's own handlers ran. */
export const SURFACE_LOG_EVENTS = [
  "keydown",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "focus",
  "blur",
] as const;
