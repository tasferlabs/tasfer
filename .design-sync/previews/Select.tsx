import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
} from "tasfer";

// defaultOpen + defaultValue renders the listbox open with a checked item.
export function Open() {
  return (
    <Select defaultOpen defaultValue="poppins">
      <SelectTrigger style={{ width: 220 }}>
        <SelectValue placeholder="Select a font" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Document font</SelectLabel>
          <SelectItem value="poppins">Poppins</SelectItem>
          <SelectItem value="inter">Inter</SelectItem>
          <SelectItem value="ibm-plex">IBM Plex Sans</SelectItem>
          <SelectItem value="lora">Lora</SelectItem>
          <SelectItem value="jetbrains">JetBrains Mono</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
