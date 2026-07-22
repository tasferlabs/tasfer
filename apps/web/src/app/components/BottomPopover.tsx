import { AnimatePresence, motion } from "framer-motion";
import type { AriaRole, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Shared shape for the floating bottom popovers (update prompt, peer-version
 * notice, mobile app nudge): slide-up animation, safe-area-aware placement,
 * and the card chrome. Content, queueing, and dismissal stay with callers. */

const popupVariants = {
  hidden: { y: 80, opacity: 0 },
  visible: { y: 0, opacity: 1, transition: { duration: 0.4 } },
  exit: { y: 80, opacity: 0, transition: { duration: 0.3 } },
};

interface BottomPopoverProps {
  show: boolean;
  role?: AriaRole;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  /** Extra classes for the card container. */
  className?: string;
  children: ReactNode;
}

export function BottomPopover({
  show,
  className,
  children,
  ...aria
}: BottomPopoverProps) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="fixed z-[2000] pointer-events-auto"
          style={{
            bottom:
              "calc(0.5rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))",
            left: "calc(0.5rem + var(--safe-area-inset-left, env(safe-area-inset-left, 0px)))",
            right:
              "calc(0.5rem + var(--safe-area-inset-right, env(safe-area-inset-right, 0px)))",
          }}
          initial="hidden"
          animate="visible"
          exit="exit"
          variants={popupVariants}
          {...aria}
        >
          <div
            className={cn(
              "max-w-md w-full overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg",
              className,
            )}
          >
            {children}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
