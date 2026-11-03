/**
 * An in-memory stand-in for one device's `OwnPrefsStore`, for tests.
 *
 * Each instance is one device's copy of the register. `syncFrom` does what a
 * handshake between two of the person's devices does: every key the other
 * device decided later wins, the rest stay — so a test can make two devices
 * write at once and then see what survives the merge.
 */

let clock = 0;

export class FakeOwnPrefs {
  private snapshot = { values: {} as Record<string, unknown>, loaded: true };
  private onLoaded: Array<() => void> = [];
  private stamps = new Map<string, number>();
  private listeners = new Set<() => void>();

  deviceKey: string | null;

  constructor(deviceKey: string | null = "device-a") {
    this.deviceKey = deviceKey;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  whenLoaded(): Promise<void> {
    if (this.snapshot.loaded) return Promise.resolve();
    return new Promise((resolve) => this.onLoaded.push(resolve));
  }

  /** Start as a device whose register has not been read yet. */
  unload(): void {
    this.snapshot = { ...this.snapshot, loaded: false };
  }

  /** Land the register's first read, as `OwnPrefsStore.hydrate` does. */
  load(stored: Record<string, unknown> = {}): void {
    for (const key of Object.keys(stored)) this.stamps.set(key, ++clock);
    this.commit({ ...stored, ...this.snapshot.values });
    for (const resolve of this.onLoaded.splice(0)) resolve();
  }

  get<T>(key: string, fallback: T): T {
    const value = this.snapshot.values[key];
    return value === undefined || value === null ? fallback : (value as T);
  }

  set(key: string, value: unknown): void {
    this.stamps.set(key, ++clock);
    this.commit({ ...this.snapshot.values, [key]: value });
  }

  entries(prefix: string): Array<[string, unknown]> {
    return Object.entries(this.snapshot.values).filter(
      ([key, value]) => key.startsWith(prefix) && value != null,
    );
  }

  /** Take every key `other` decided later than this device did. */
  syncFrom(other: FakeOwnPrefs): void {
    const next = { ...this.snapshot.values };
    for (const [key, stamp] of other.stamps) {
      if (stamp > (this.stamps.get(key) ?? 0)) {
        this.stamps.set(key, stamp);
        next[key] = other.snapshot.values[key];
      }
    }
    this.commit(next);
  }

  private commit(values: Record<string, unknown>) {
    this.snapshot = { values, loaded: true };
    for (const l of this.listeners) l();
  }
}
