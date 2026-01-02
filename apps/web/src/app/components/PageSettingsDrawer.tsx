import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { MoreVertical } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import useResponsive from "../hooks/useResponsive";
import {
  usePageSettings,
  type FontStyle,
} from "../contexts/PageSettingsContext";

export function PageSettingsDrawer() {
  const { t, i18n } = useTranslation("PageSettingsDrawer");
  const [open, setOpen] = useState(false);
  const {
    fontStyle,
    setFontStyle,
    showWordCount,
    setShowWordCount,
    wordCount,
  } = usePageSettings();
  const isMobile = useResponsive("(max-width: 768px)");

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="text-muted-foreground hover:text-foreground"
    >
      <MoreVertical className="h-4 w-4" />
      <span className="sr-only">{t`Page settings`}</span>
    </Button>
  );

  const fontOptions: Array<{
    value: FontStyle;
    label: string;
    className: string;
  }> = [
    { value: "default", label: t`Default`, className: "font-sans" },
    { value: "serif", label: t`Serif`, className: "font-serif" },
  ];

  const content = (
    <div className="space-y-6 flex-1 p-4">
      <div className="space-y-3">
        <label className="text-sm font-medium sr-only">{t`Font style`}</label>
        <div className="grid grid-cols-2 gap-2">
          {fontOptions.map((option) => (
            <button
              key={option.value}
              onClick={() => setFontStyle(option.value)}
              className={`
                flex flex-col items-center justify-center
                p-2 rounded-lg border-2 transition-all
                hover:bg-accent duration-200 cursor-pointer
                ${
                  fontStyle === option.value
                    ? "border-primary"
                    : "border-border bg-background"
                }
              `}
            >
              <span
                className={`text-2xl font-medium mb-1 ${
                  fontStyle === option.value ? "text-primary" : ""
                } ${option.className}`}
              >
                Ag
              </span>
              <span className="text-xs text-muted-foreground">
                {option.label}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-3 pt-3 border-t border-border">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <label htmlFor="word-count-toggle" className="text-sm font-medium">
              {t`Show word count`}
            </label>
            <p className="text-xs text-muted-foreground">
              {t`Display word count overlay on page`}
            </p>
          </div>
          <Switch
            id="word-count-toggle"
            checked={showWordCount}
            onCheckedChange={setShowWordCount}
          />
        </div>
        <div className="text-sm text-muted-foreground">
          <span className="font-medium">
            {new Intl.NumberFormat(i18n.language).format(wordCount)}
          </span>{" "}
          {wordCount === 1 ? t`word` : t`words`}
        </div>
      </div>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{triggerButton}</DrawerTrigger>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm h-full flex flex-col">
            <DrawerHeader className="relative">
              <DrawerTitle>{t`Page Settings`}</DrawerTitle>
            </DrawerHeader>
            {content}
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{triggerButton}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px] p-0 shadow-2xl">
        <DropdownMenuLabel className="sr-only">
          {t`Page Settings`}
        </DropdownMenuLabel>
        {content}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
