import { Label, Input, Switch } from "tasfer";

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: 260,
};

export function WithInput() {
  return (
    <div style={field}>
      <Label htmlFor="doc-title">Document title</Label>
      <Input id="doc-title" defaultValue="Roadmap Q3" />
    </div>
  );
}

export function WithSwitch() {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <Switch id="autosave" defaultChecked />
      <Label htmlFor="autosave">Autosave changes</Label>
    </div>
  );
}

export function Disabled() {
  return (
    <div style={field} data-disabled="true" className="group">
      <Label htmlFor="workspace-id">Workspace ID</Label>
      <Input id="workspace-id" defaultValue="local-only" disabled />
    </div>
  );
}
