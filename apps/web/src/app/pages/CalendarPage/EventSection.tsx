import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { useId, type ReactNode } from "react";
import style from "./CalendarPage.module.css";

/**
 * One group of an event panel's fields, folded into a summary of what they
 * hold: a line of values and a muted line of details under it. A tap opens
 * the fields themselves below the summary.
 */
export function EventSection({
  icon: Icon,
  primary,
  secondary,
  open,
  onOpenChange,
  children,
}: {
  icon: LucideIcon;
  primary: ReactNode;
  secondary?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const bodyId = useId();
  return (
    <div className={style.eventSection}>
      <button
        type="button"
        className={style.eventSectionSummary}
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <Icon size={14} className={style.previewRowIcon} aria-hidden />
        <span className={style.previewDetailsSummaryText}>
          <span className={style.previewDetailsSummaryPrimary}>{primary}</span>
          {secondary && (
            <span className={style.previewDetailsSummaryMeta}>
              {secondary}
            </span>
          )}
        </span>
        <ChevronDown
          size={16}
          aria-hidden
          className={`${style.previewDetailsChevron} ${open ? style.previewDetailsChevronOpen : ""}`}
        />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={bodyId}
            className={style.eventSectionBody}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
