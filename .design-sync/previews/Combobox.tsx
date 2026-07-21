import { useState, useRef, useEffect } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
} from "tasfer";

const collaborators = [
  "Amara Nwosu",
  "Diego Marín",
  "Priya Nair",
  "Jonas Lindqvist",
  "Mei-Ling Chen",
  "Yusuf Demir",
];

// Combobox open state is internal (no open prop), so click the trigger on
// mount to render the dropdown, search input, and filtered list in the card.
export function Open() {
  const [value, setValue] = useState<string | null>("Priya Nair");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const trigger = ref.current?.querySelector<HTMLElement>(
      '[data-slot="combobox-trigger"]',
    );
    trigger?.click();
  }, []);

  return (
    <div ref={ref} style={{ width: 280 }}>
      <Combobox items={collaborators} value={value} onValueChange={setValue}>
        <ComboboxInput placeholder="Add a collaborator" />
        <ComboboxContent>
          <ComboboxList>
            {collaborators.map((name) => (
              <ComboboxItem key={name} value={name}>
                {name}
              </ComboboxItem>
            ))}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  );
}
