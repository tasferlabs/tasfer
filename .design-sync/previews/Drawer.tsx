import {
  Drawer,
  DrawerTrigger,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
  DrawerFooter,
  DrawerClose,
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

// Rendered open (defaultOpen). vaul bottom drawer — a mobile settings panel with
// real fields, header, and a pinned footer.
export function Open() {
  return (
    <Drawer defaultOpen>
      <DrawerTrigger asChild>
        <Button variant="outline">Sync settings</Button>
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Sync settings</DrawerTitle>
          <DrawerDescription>
            Control how this document shares changes with nearby peers.
          </DrawerDescription>
        </DrawerHeader>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            padding: "0 16px",
          }}
        >
          <div style={field}>
            <Label htmlFor="device-name">Device name</Label>
            <Input id="device-name" defaultValue="Hamza’s MacBook" />
          </div>
          <div style={toggleRow}>
            <Label htmlFor="lan-sync">Sync over local network</Label>
            <Switch id="lan-sync" defaultChecked />
          </div>
          <div style={toggleRow}>
            <Label htmlFor="offline-only">Work offline only</Label>
            <Switch id="offline-only" />
          </div>
        </div>
        <DrawerFooter>
          <Button>Save changes</Button>
          <DrawerClose asChild>
            <Button variant="outline">Cancel</Button>
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
