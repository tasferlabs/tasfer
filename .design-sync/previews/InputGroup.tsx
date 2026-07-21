import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
} from "tasfer";
import { Search, Copy, Send } from "lucide-react";

export function Basic() {
  return (
    <InputGroup style={{ width: 300 }}>
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
      <InputGroupInput placeholder="Search pages and layers" />
    </InputGroup>
  );
}

export function WithButton() {
  return (
    <InputGroup style={{ width: 320 }}>
      <InputGroupInput defaultValue="tasfer.app/s/9fk2-roadmap" readOnly />
      <InputGroupAddon align="inline-end">
        <InputGroupButton variant="outline" size="icon-xs" aria-label="Copy link">
          <Copy />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}

export function WithText() {
  return (
    <InputGroup style={{ width: 320 }}>
      <InputGroupAddon>
        <InputGroupText>tasfer.app/</InputGroupText>
      </InputGroupAddon>
      <InputGroupInput defaultValue="product-roadmap" />
    </InputGroup>
  );
}

export function Textarea() {
  return (
    <InputGroup style={{ width: 320 }}>
      <InputGroupTextarea placeholder="Leave a comment on this frame…" rows={3} />
      <InputGroupAddon align="block-end">
        <InputGroupText>Visible to peers on this canvas</InputGroupText>
        <InputGroupButton
          variant="default"
          size="icon-xs"
          aria-label="Send comment"
          style={{ marginInlineStart: "auto" }}
        >
          <Send />
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
