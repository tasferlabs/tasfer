import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface SavingIndicatorProps {
  isSaving: boolean;
  className?: string;
}

export function SavingIndicator({ isSaving, className }: SavingIndicatorProps) {
  const { t } = useTranslation("SavingIndicator");
  if (!isSaving) {
    return (
      <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
        <Check className="h-4 w-4" />
        <span>{t`Saved`}</span>
      </div>
    );
  }

  return (
    <div className={cn("flex items-center gap-2 text-sm text-muted-foreground", className)}>
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{t`Saving...`}</span>
    </div>
  );
}

