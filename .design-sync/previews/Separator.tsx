import { Separator } from "tasfer";

export function Horizontal() {
  return (
    <div style={{ width: 280 }}>
      <div style={{ fontSize: 14, fontWeight: 500 }}>Document settings</div>
      <Separator style={{ marginTop: 12, marginBottom: 12 }} />
      <div style={{ fontSize: 13, color: "var(--muted-foreground)" }}>
        Sharing, sync, and export options.
      </div>
    </div>
  );
}

export function Vertical() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        height: 24,
        fontSize: 13,
      }}
    >
      <span>Edit</span>
      <Separator orientation="vertical" />
      <span>Share</span>
      <Separator orientation="vertical" />
      <span>Export</span>
    </div>
  );
}
