import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
  SheetClose,
  Button,
  Label,
  Input,
  Switch,
} from "tasfer";

const field: React.CSSProperties = { display: "grid", gap: 6 };
const toggleRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
};

// Rendered open (defaultOpen). Right-side sheet — a share panel with real fields,
// header, and a footer. Radix Dialog under the hood, with the built-in close X.
export function Open() {
  return (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button variant="outline">Share document</Button>
      </SheetTrigger>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Share document</SheetTitle>
          <SheetDescription>
            Invite peers to edit this canvas in real time. Changes merge
            automatically, even offline.
          </SheetDescription>
        </SheetHeader>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: "0 16px",
          }}
        >
          <div style={field}>
            <Label htmlFor="share-link">Share link</Label>
            <Input id="share-link" defaultValue="tasfer.app/d/roadmap-9f2a" readOnly />
          </div>
          <div style={toggleRow}>
            <Label htmlFor="allow-edit">Allow editing</Label>
            <Switch id="allow-edit" defaultChecked />
          </div>
          <div style={toggleRow}>
            <Label htmlFor="require-approval">Require approval to join</Label>
            <Switch id="require-approval" />
          </div>
        </div>
        <SheetFooter>
          <Button>Copy link</Button>
          <SheetClose asChild>
            <Button variant="outline">Done</Button>
          </SheetClose>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
