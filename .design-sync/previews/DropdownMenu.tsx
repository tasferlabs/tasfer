import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  Button,
} from "tasfer";
import { Pencil, Copy, Download, Trash2 } from "lucide-react";

// defaultOpen renders the page-actions menu already open in the card.
export function Open() {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">Page actions</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" style={{ width: 232 }}>
        <DropdownMenuLabel>Product roadmap</DropdownMenuLabel>
        <DropdownMenuItem>
          <Pencil />
          Rename
          <DropdownMenuShortcut>⌘R</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Copy />
          Duplicate
          <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem>
          <Download />
          Export as PDF
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">
          <Trash2 />
          Delete page
          <DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
