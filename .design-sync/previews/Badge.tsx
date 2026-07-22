import { Badge } from "tasfer";
import { Check, GitBranch, Wifi } from "lucide-react";

const row: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

export function Default() {
  return (
    <div style={row}>
      <Badge>Synced</Badge>
    </div>
  );
}

export function Variants() {
  return (
    <div style={row}>
      <Badge variant="default">Synced</Badge>
      <Badge variant="secondary">Draft</Badge>
      <Badge variant="destructive">Conflict</Badge>
      <Badge variant="outline">Offline</Badge>
      <Badge variant="ghost">Idle</Badge>
      <Badge variant="link">Details</Badge>
    </div>
  );
}

export function WithIcon() {
  return (
    <div style={row}>
      <Badge>
        <Check /> Saved
      </Badge>
      <Badge variant="secondary">
        <GitBranch /> main
      </Badge>
      <Badge variant="outline">
        <Wifi /> 3 peers
      </Badge>
    </div>
  );
}

export function Counts() {
  return (
    <div style={row}>
      <Badge variant="secondary">12 pages</Badge>
      <Badge>4 online</Badge>
      <Badge variant="destructive">2 conflicts</Badge>
    </div>
  );
}
