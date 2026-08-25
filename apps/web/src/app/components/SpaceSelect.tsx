import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getRememberedChoice, rememberChoice } from "@/lib/rememberedChoice";
import { useSpaces } from "../contexts/SpaceContext";
import type { ISpace } from "../api/spaces.api";

interface SpaceSelectProps {
  /** The chosen space; an empty string while none is settled yet. */
  value: string | null;
  onChange: (spaceId: string) => void;
  /**
   * Remember the chosen space on this device under this key and offer it again
   * the next time a picker with the same key mounts — so someone who always
   * imports into the same space stops re-picking it. Left out, the picker shows
   * whatever the caller defaults to.
   */
  remember?: string;
  /** Defaults to every space the person is a member of. */
  spaces?: ISpace[];
  size?: "sm" | "default";
  /** Applied to the trigger, which is the whole visible control. */
  className?: string;
  /** Only needed where no visible label names the control. */
  "aria-label"?: string;
}

/**
 * The remembered space for `key`, or undefined when nothing is remembered or
 * the space is gone. For callers that compute their own default — an on-open
 * reset, say — which lands after the picker's own restore and would otherwise
 * overwrite it.
 */
export function rememberedSpaceId(
  key: string,
  spaces: ISpace[],
): string | undefined {
  return getRememberedChoice(
    key,
    spaces.map((space) => space.id),
  );
}

/**
 * Picks one space out of the ones a person is in. The single place that knows
 * what a space list looks like in a form — and, with `remember`, the only place
 * that decides when a past choice may stand in for the caller's default.
 */
export function SpaceSelect({
  value,
  onChange,
  remember,
  spaces: spacesProp,
  size,
  className,
  "aria-label": ariaLabel,
}: SpaceSelectProps) {
  const { t } = useTranslation();
  const { spaces: memberSpaces } = useSpaces();
  const spaces = spacesProp ?? memberSpaces;
  const restored = useRef(false);

  // Spaces arrive a tick after a dialog opens, so a remembered one is only
  // worth restoring once the list is there to vouch for it: a space that has
  // since been deleted must never outrank the caller's own default.
  useEffect(() => {
    if (!remember || restored.current || spaces.length === 0) return;
    restored.current = true;
    const stored = getRememberedChoice(
      remember,
      spaces.map((space) => space.id),
    );
    if (stored && stored !== value) onChange(stored);
  }, [remember, spaces, value, onChange]);

  const handleChange = useCallback(
    (spaceId: string) => {
      if (remember) rememberChoice(remember, spaceId);
      onChange(spaceId);
    },
    [remember, onChange],
  );

  return (
    <Select value={value ?? ""} onValueChange={handleChange}>
      <SelectTrigger size={size} className={className} aria-label={ariaLabel}>
        <SelectValue placeholder={t("space.selectSpace", "Select space")} />
      </SelectTrigger>
      <SelectContent>
        {spaces.map((space) => (
          <SelectItem key={space.id} value={space.id}>
            {space.name || t("space.untitled", "Untitled space")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
