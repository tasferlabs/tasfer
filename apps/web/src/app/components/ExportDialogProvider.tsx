import React, { createContext, useCallback, useContext, useState } from "react";
import { invariant } from "@shared/invariant";
import type { IListPage } from "../api/pages.api";

const ExportAllDialog = React.lazy(() =>
  import("./ExportAllDialog").then((module) => ({
    default: module.ExportAllDialog,
  })),
);

interface ExportTarget {
  spaceId: string;
  page: IListPage;
}

interface ExportDialogContextValue {
  /** Open the shared export dialog for one page and its subpages. */
  openExport: (spaceId: string, page: IListPage) => void;
}

const ExportDialogContext = createContext<ExportDialogContextValue | undefined>(
  undefined,
);

/**
 * Hosts a single {@link ExportAllDialog} for the whole app and exposes
 * `openExport` so any page row can raise it. Living above the page tree keeps
 * an export running when the row that started it scrolls away or collapses.
 */
export function ExportDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<ExportTarget | null>(null);

  const openExport = useCallback((spaceId: string, page: IListPage) => {
    setTarget({ spaceId, page });
  }, []);

  return (
    <ExportDialogContext.Provider value={{ openExport }}>
      {children}
      {target && (
        <React.Suspense fallback={null}>
          <ExportAllDialog
            open
            spaceId={target.spaceId}
            page={target.page}
            onOpenChange={(open) => {
              if (!open) setTarget(null);
            }}
          />
        </React.Suspense>
      )}
    </ExportDialogContext.Provider>
  );
}

export function useExportDialog(): ExportDialogContextValue {
  const ctx = useContext(ExportDialogContext);
  invariant(ctx, "useExportDialog must be used within an ExportDialogProvider");
  return ctx;
}
