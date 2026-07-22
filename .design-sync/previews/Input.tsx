import { Input } from "tasfer";

const box: React.CSSProperties = { width: 260 };

export function Default() {
  return (
    <div style={box}>
      <Input defaultValue="Untitled document" />
    </div>
  );
}

export function Placeholder() {
  return (
    <div style={box}>
      <Input placeholder="Search pages and peers…" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={box}>
      <Input defaultValue="local-only" disabled />
    </div>
  );
}

export function Invalid() {
  return (
    <div style={box}>
      <Input defaultValue="not-a-peer-id" aria-invalid />
    </div>
  );
}
