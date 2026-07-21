import { BottomSheet, Button, Label, Input, Switch } from "tasfer";

// BottomSheet is controlled (no `defaultOpen`); pass a literal `open` and a no-op
// handler so the static card renders it open. `variant="sheet"` gives the dimmed
// backdrop + single tall detent. It owns no sub-parts, so compose the header,
// scroll body, and footer as a flex column: shrink-0 edges, a flex-1 min-h-0
// middle, matching the layout contract documented in bottom-sheet.tsx.
export function Open() {
  return (
    <BottomSheet open onOpenChange={() => {}} variant="sheet">
      <div style={{ flexShrink: 0, padding: "4px 16px 12px" }}>
        <div style={{ fontWeight: 500 }}>Rectangle</div>
        <div style={{ color: "var(--muted-foreground)", fontSize: 13 }}>
          Selected shape · 2 layers
        </div>
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          padding: "0 16px",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <Label htmlFor="shape-w">Width</Label>
            <Input id="shape-w" defaultValue="320" />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <Label htmlFor="shape-h">Height</Label>
            <Input id="shape-h" defaultValue="180" />
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Label htmlFor="lock-ratio">Lock aspect ratio</Label>
          <Switch id="lock-ratio" defaultChecked />
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <Label htmlFor="snap-grid">Snap to grid</Label>
          <Switch id="snap-grid" />
        </div>
      </div>
      <div style={{ flexShrink: 0, display: "flex", gap: 8, padding: 16 }}>
        <Button variant="outline" style={{ flex: 1 }}>
          Reset
        </Button>
        <Button style={{ flex: 1 }}>Done</Button>
      </div>
    </BottomSheet>
  );
}
