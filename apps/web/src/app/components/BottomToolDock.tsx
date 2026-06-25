import type { ReactNode } from "react";

interface BottomToolDockProps {
  children: ReactNode;
}

/**
 * Shared positioning container for compact tools shown at the bottom of the app.
 * Add new tools as children and they will append to the same row.
 */
export function BottomToolDock({ children }: BottomToolDockProps) {
  return (
    <div className="fixed bottom-3 end-3 z-40 flex items-center gap-2">
      {children}
    </div>
  );
}
