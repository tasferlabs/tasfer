import { PasswordInput, Label } from "tasfer";

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  width: 280,
};

export function Default() {
  return (
    <div style={{ width: 280 }}>
      <PasswordInput defaultValue="correcthorsebattery" />
    </div>
  );
}

export function WithLabel() {
  return (
    <div style={field}>
      <Label htmlFor="room-passphrase">Room passphrase</Label>
      <PasswordInput id="room-passphrase" placeholder="Enter passphrase to join" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ width: 280 }}>
      <PasswordInput defaultValue="locked-vault-key" disabled />
    </div>
  );
}

export function Invalid() {
  return (
    <div style={{ width: 280 }}>
      <PasswordInput defaultValue="short" aria-invalid />
    </div>
  );
}
