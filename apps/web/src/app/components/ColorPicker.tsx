import { useState } from "react";
import { useTranslation } from "react-i18next";
import useResponsive from "@/app/hooks/useResponsive";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import clsx from "clsx";

const PRESET_COLORS = [
  "#EF4444",
  "#F97316",
  "#F59E0B",
  "#EAB308",
  "#84CC16",
  "#22C55E",
  "#14B8A6",
  "#06B6D4",
  "#3B82F6",
  "#6366F1",
  "#8B5CF6",
  "#A855F7",
  "#D946EF",
  "#EC4899",
  "#F43F5E",
];

interface ColorPickerProps {
  color: string | null | undefined;
  onChange: (color: string | null) => void;
}

export function ColorPicker({ color, onChange }: ColorPickerProps) {
  const { t } = useTranslation();
  const isCoarse = useResponsive("(pointer: coarse)");
  const [open, setOpen] = useState(false);

  const handleSelect = (hex: string) => {
    onChange(hex);
  };

  const handleClear = () => {
    onChange(null);
    setOpen(false);
  };

  const grid = (
    <div
      className="grid grid-cols-8 gap-2 p-1"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className={clsx(
          "w-full aspect-square rounded-lg border-2 cursor-pointer transition-transform hover:scale-110 bg-primary",
          !color ? "border-foreground" : "border-transparent",
        )}
        onClick={handleClear}
        aria-label={t("editor.defaultColor", "Default color")}
      />
      {PRESET_COLORS.map((hex) => (
        <button
          key={hex}
          className={clsx(
            "w-full aspect-square rounded-lg border-2 cursor-pointer transition-transform hover:scale-110",
            color?.toUpperCase() === hex.toUpperCase()
              ? "border-foreground"
              : "border-transparent",
          )}
          style={{ backgroundColor: hex }}
          onClick={() => handleSelect(hex)}
          aria-label={t("editor.selectColor", "Select color {{color}}", {
            color: hex,
          })}
        />
      ))}
    </div>
  );

  const trigger = (
    <button
      type="button"
      className="color-picker-trigger"
      aria-label={t("editor.pickColor", "Pick color")}
      onClick={(e) => e.stopPropagation()}
    >
      <span
        className="color-picker-blob"
        style={{
          backgroundColor: color || "var(--primary)",
          opacity: color ? 1 : 0.3,
        }}
      />
    </button>
  );

  if (isCoarse) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="sr-only">
            <DrawerTitle>{t("editor.chooseColor", "Choose color")}</DrawerTitle>
          </DrawerHeader>
          <div className="p-4">{grid}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 max-w-full"
        collisionPadding={8}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {grid}
      </PopoverContent>
    </Popover>
  );
}
