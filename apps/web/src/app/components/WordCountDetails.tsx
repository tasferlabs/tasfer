import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { computeDocumentStats } from "@/lib/documentStats";
import { usePageSettings } from "../contexts/PageSettingsContext";
import useResponsive from "../hooks/useResponsive";

interface WordCountDetailsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Detailed document statistics surface opened by tapping the word-count pill.
 * Renders as a bottom drawer on mobile and a centered dialog on larger screens,
 * mirroring the app's other adaptive dialogs (e.g. ExportDialog).
 */
export function WordCountDetails({ open, onOpenChange }: WordCountDetailsProps) {
  const { currentBlocks } = usePageSettings();
  const { t, i18n } = useTranslation();
  const isMobile = useResponsive("(max-width: 768px)");

  const stats = useMemo(
    () => computeDocumentStats(currentBlocks),
    [currentBlocks],
  );

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language],
  );

  const title = t("wordCount.title", "Document statistics");
  const description = t(
    "wordCount.description",
    "A breakdown of your document's content.",
  );

  const rows: Array<{ label: string; value: string }> = [
    { label: t("wordCount.words", "Words"), value: numberFormat.format(stats.words) },
    {
      label: t("wordCount.characters", "Characters"),
      value: numberFormat.format(stats.characters),
    },
    {
      label: t("wordCount.charactersNoSpaces", "Characters (no spaces)"),
      value: numberFormat.format(stats.charactersNoSpaces),
    },
    {
      label: t("wordCount.sentences", "Sentences"),
      value: numberFormat.format(stats.sentences),
    },
    {
      label: t("wordCount.paragraphs", "Paragraphs"),
      value: numberFormat.format(stats.paragraphs),
    },
    {
      label: t("wordCount.readingTime", "Reading time"),
      value: t("format.minutes", "{{count}} min", {
        count: stats.readingTimeMinutes,
      }),
    },
  ];

  const statsList = (
    <dl className="divide-y divide-border">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between py-2.5"
        >
          <dt className="text-sm text-muted-foreground">{row.label}</dt>
          <dd className="text-sm font-medium tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent>
          <div className="mx-auto w-full max-w-sm pb-6">
            <DrawerHeader>
              <DrawerTitle>{title}</DrawerTitle>
              <DrawerDescription>{description}</DrawerDescription>
            </DrawerHeader>
            <div className="px-4">{statsList}</div>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {statsList}
      </DialogContent>
    </Dialog>
  );
}
