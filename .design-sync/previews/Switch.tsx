import { Switch, Label } from "tasfer";

const row: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

export function States() {
  return (
    <div style={row}>
      <Switch aria-label="Off" />
      <Switch defaultChecked aria-label="On" />
      <Switch disabled aria-label="Disabled off" />
      <Switch defaultChecked disabled aria-label="Disabled on" />
    </div>
  );
}

export function Sizes() {
  return (
    <div style={row}>
      <Switch size="sm" defaultChecked aria-label="Small on" />
      <Switch size="default" defaultChecked aria-label="Default on" />
    </div>
  );
}

export function WithLabels() {
  return (
    <div style={stack}>
      <div style={row}>
        <Switch id="sync-peers" defaultChecked />
        <Label htmlFor="sync-peers">Sync with nearby peers</Label>
      </div>
      <div style={row}>
        <Switch id="offline-mode" />
        <Label htmlFor="offline-mode">Work offline only</Label>
      </div>
    </div>
  );
}
