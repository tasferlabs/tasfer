import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
  Input,
  Switch,
} from "tasfer";

export function Basic() {
  return (
    <Field style={{ width: 320 }}>
      <FieldLabel htmlFor="doc-title">Document title</FieldLabel>
      <Input id="doc-title" defaultValue="Q3 product roadmap" />
      <FieldDescription>
        Shown in the sidebar and on shared links.
      </FieldDescription>
    </Field>
  );
}

export function Horizontal() {
  return (
    <Field orientation="horizontal" style={{ width: 340 }}>
      <FieldContent>
        <FieldTitle>Peer-to-peer sync</FieldTitle>
        <FieldDescription>
          Share edits directly between devices — no server involved.
        </FieldDescription>
      </FieldContent>
      <Switch defaultChecked />
    </Field>
  );
}

export function Invalid() {
  return (
    <Field data-invalid="true" style={{ width: 320 }}>
      <FieldLabel htmlFor="ws">Workspace name</FieldLabel>
      <Input id="ws" aria-invalid defaultValue="acme" />
      <FieldError>That workspace name is already in use.</FieldError>
    </Field>
  );
}

export function Grouped() {
  return (
    <FieldSet style={{ width: 340 }}>
      <FieldLegend>Export settings</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="fmt">File name</FieldLabel>
          <Input id="fmt" defaultValue="roadmap.canvas" />
        </Field>
        <FieldSeparator />
        <Field>
          <FieldLabel htmlFor="scale">Export scale</FieldLabel>
          <Input id="scale" defaultValue="2x" />
          <FieldDescription>Higher scale exports sharper images.</FieldDescription>
        </Field>
      </FieldGroup>
    </FieldSet>
  );
}
