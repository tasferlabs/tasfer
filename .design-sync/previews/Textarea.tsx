import { Textarea } from "tasfer";

const box: React.CSSProperties = { width: 300 };

export function Default() {
  return (
    <div style={box}>
      <Textarea defaultValue="Peer-to-peer editing keeps your document on every device, no server required." />
    </div>
  );
}

export function Placeholder() {
  return (
    <div style={box}>
      <Textarea placeholder="Add a description for this page…" />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={box}>
      <Textarea defaultValue="This page is read-only while syncing." disabled />
    </div>
  );
}

export function Invalid() {
  return (
    <div style={box}>
      <Textarea defaultValue="" aria-invalid placeholder="A description is required" />
    </div>
  );
}
