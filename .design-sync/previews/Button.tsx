import { Button } from "tasfer";
import { ArrowRight, Check, Plus, Trash2 } from "lucide-react";

const row: React.CSSProperties = {
  display: "flex",
  gap: 10,
  alignItems: "center",
  flexWrap: "wrap",
};

export function Variants() {
  return (
    <div style={row}>
      <Button>Save changes</Button>
      <Button variant="outline">Cancel</Button>
      <Button variant="secondary">Duplicate</Button>
      <Button variant="ghost">Dismiss</Button>
      <Button variant="destructive">Delete</Button>
      <Button variant="link">Learn more</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={row}>
      <Button size="sm">Small</Button>
      <Button size="default">Default</Button>
      <Button size="lg">Large</Button>
    </div>
  );
}

export function WithIcons() {
  return (
    <div style={row}>
      <Button>
        <Plus /> New page
      </Button>
      <Button variant="outline">
        Continue <ArrowRight />
      </Button>
      <Button variant="secondary">
        <Check /> Done
      </Button>
      <Button variant="destructive">
        <Trash2 /> Remove
      </Button>
    </div>
  );
}

export function IconOnly() {
  return (
    <div style={row}>
      <Button size="icon" aria-label="Add">
        <Plus />
      </Button>
      <Button size="icon" variant="outline" aria-label="Confirm">
        <Check />
      </Button>
      <Button size="icon" variant="ghost" aria-label="Delete">
        <Trash2 />
      </Button>
    </div>
  );
}

export function States() {
  return (
    <div style={row}>
      <Button loading>Saving…</Button>
      <Button disabled>Disabled</Button>
      <Button variant="outline" disabled>
        Unavailable
      </Button>
    </div>
  );
}
