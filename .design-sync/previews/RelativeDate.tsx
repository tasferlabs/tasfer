import { RelativeDate } from "tasfer";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

export function Recent() {
  return (
    <div style={{ fontSize: 14 }}>
      Last edited <RelativeDate date={minutesAgo(3)} />
    </div>
  );
}

export function DaysAgo() {
  return (
    <div style={{ fontSize: 14 }}>
      Synced <RelativeDate date={minutesAgo(60 * 24 * 2)} />
    </div>
  );
}

const daysAgoIso = (d: number) =>
  new Date(Date.now() - d * 86_400_000).toISOString();

export function IsoString() {
  return (
    <div style={{ fontSize: 14 }}>
      Created <RelativeDate date={daysAgoIso(90)} />
    </div>
  );
}
