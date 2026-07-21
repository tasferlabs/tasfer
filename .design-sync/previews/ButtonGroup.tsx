import {
  ButtonGroup,
  ButtonGroupSeparator,
  ButtonGroupText,
  Button,
} from "tasfer";
import {
  AlignLeft,
  AlignCenter,
  AlignRight,
  Undo2,
  Redo2,
  Minus,
  Plus,
  Share2,
} from "lucide-react";

export function Basic() {
  return (
    <ButtonGroup>
      <Button variant="outline" size="icon-sm" aria-label="Align left">
        <AlignLeft />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label="Align center">
        <AlignCenter />
      </Button>
      <Button variant="outline" size="icon-sm" aria-label="Align right">
        <AlignRight />
      </Button>
    </ButtonGroup>
  );
}

export function WithText() {
  return (
    <ButtonGroup>
      <ButtonGroupText>Zoom</ButtonGroupText>
      <Button variant="outline" size="icon-sm" aria-label="Zoom out">
        <Minus />
      </Button>
      <ButtonGroupText>100%</ButtonGroupText>
      <Button variant="outline" size="icon-sm" aria-label="Zoom in">
        <Plus />
      </Button>
    </ButtonGroup>
  );
}

export function WithSeparator() {
  return (
    <ButtonGroup>
      <Button variant="outline" size="sm">
        <Undo2 /> Undo
      </Button>
      <Button variant="outline" size="sm">
        <Redo2 /> Redo
      </Button>
      <ButtonGroupSeparator />
      <Button variant="outline" size="sm">
        <Share2 /> Share
      </Button>
    </ButtonGroup>
  );
}

export function Vertical() {
  return (
    <ButtonGroup orientation="vertical">
      <Button variant="outline" size="sm">
        Bring to front
      </Button>
      <Button variant="outline" size="sm">
        Send backward
      </Button>
      <Button variant="outline" size="sm">
        Send to back
      </Button>
    </ButtonGroup>
  );
}
