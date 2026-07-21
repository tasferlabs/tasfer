import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
  Button,
  Input,
  Label,
} from "tasfer";

// Rendered open (defaultOpen) so the card shows the surface, not just a trigger.
export function Open() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button variant="outline">Rename page</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename page</DialogTitle>
          <DialogDescription>
            Give this page a clear title. It updates for everyone with access.
          </DialogDescription>
        </DialogHeader>
        <div style={{ display: "grid", gap: 6 }}>
          <Label htmlFor="page-name">Page name</Label>
          <Input id="page-name" defaultValue="Product roadmap" />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
          <Button>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
