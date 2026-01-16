import { Check, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface SavingIndicatorProps {
  isSaving: boolean;
  className?: string;
}

export function SavingIndicator({ isSaving, className }: SavingIndicatorProps) {
  const { t } = useTranslation();
  const [showSaved, setShowSaved] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    if (isSaving) {
      // Mark that a save operation has started
      setHasSaved(true);
      setShowSaved(false);
    } else if (hasSaved) {
      // Only show "Saved" if there was a previous save operation
      setShowSaved(true);

      // Hide after 2 seconds
      const timer = setTimeout(() => {
        setShowSaved(false);
      }, 2000);

      return () => clearTimeout(timer);
    }
  }, [isSaving, hasSaved]);

  if (isSaving) {
    return (
      <div
        className={cn(
          "flex items-center gap-2 text-sm text-muted-foreground",
          className
        )}
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t`Saving...`}</span>
      </div>
    );
  }

  return (
    <AnimatePresence>
      {showSaved && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          className={cn(
            "flex items-center gap-2 text-sm text-muted-foreground",
            className
          )}
        >
          <Check className="h-4 w-4" />
          <span>{t`Saved`}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
