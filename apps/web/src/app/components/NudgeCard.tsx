import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface NudgeCardProps {
  /** Small leading icon — bring your own size/color classes. */
  icon: ReactNode;
  title: ReactNode;
  description: ReactNode;
  /** Primary action (usually a Button), rendered under the description. */
  action?: ReactNode;
  /** Trailing control, e.g. a collapse chevron or a close button. */
  trailing?: ReactNode;
  className?: string;
  role?: string;
  onClick?: () => void;
}

/**
 * Compact "nudge" card body: a small leading icon, a title, a muted
 * description, an optional primary action, and an optional trailing control.
 *
 * The shared shape behind the storage-protection banner and the mobile app
 * gate — same typography and spacing so the two read as one family. Callers own
 * the surrounding container (a sidebar strip, a floating popover, …).
 */
export function NudgeCard({
  icon,
  title,
  description,
  action,
  trailing,
  className,
  role,
  onClick,
}: NudgeCardProps) {
  return (
    <div
      role={role}
      onClick={onClick}
      className={cn("flex items-start gap-2.5 px-3.5 py-2.5", className)}
    >
      <span className="mt-px shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[12.5px] font-semibold leading-[1.35] text-foreground">
          {title}
        </span>
        <span className="text-[11.5px] leading-[1.45] text-muted-foreground">
          {description}
        </span>
        {action}
      </div>
      {trailing}
    </div>
  );
}
