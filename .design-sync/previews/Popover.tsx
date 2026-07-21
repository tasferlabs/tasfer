import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription,
  Button,
  Input,
  Label,
  Switch,
} from "tasfer";

// modal defaults true; defaultOpen renders the share surface in the card.
export function Open() {
  return (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="outline">Share</Button>
      </PopoverTrigger>
      <PopoverContent>
        <PopoverHeader>
          <PopoverTitle>Share canvas</PopoverTitle>
          <PopoverDescription>
            Anyone with the link joins this peer-to-peer session live.
          </PopoverDescription>
        </PopoverHeader>
        <div style={{ display: "grid", gap: 6 }}>
          <Label htmlFor="session-link">Session link</Label>
          <div style={{ display: "flex", gap: 8 }}>
            <Input
              id="session-link"
              readOnly
              value="tasfer.app/c/roadmap-9f2a"
              style={{ flex: 1 }}
            />
            <Button>Copy</Button>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <Label htmlFor="allow-edit">Allow editing</Label>
          <Switch id="allow-edit" defaultChecked />
        </div>
      </PopoverContent>
    </Popover>
  );
}
