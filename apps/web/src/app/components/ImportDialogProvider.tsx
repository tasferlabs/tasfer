import React, { createContext, useCallback, useContext, useState } from "react";
import { invariant } from "@shared/invariant";
import { ImportAllDialog } from "./ImportAllDialog";

/** A page that imported pages can be nested under. */
export interface ImportParent {
  id: string;
  title: string;
  titleMd?: string | null;
}

interface ImportTarget {
  spaceId: string;
  parent: ImportParent | null;
}

interface ImportDialogContextValue {
  /**
   * Open the shared import dialog. `spaceId` preselects the target space; pass
   * `parent` to also preselect a page to import under (e.g. the page whose menu
   * opened this).
   */
  openImport: (spaceId: string, parent?: ImportParent) => void;
}

const ImportDialogContext = createContext<ImportDialogContextValue | undefined>(
  undefined,
);

/**
 * Hosts a single {@link ImportAllDialog} for the whole app and exposes
 * `openImport` so any space header or page row can raise it — with the space
 * (and optionally a parent page) preselected — without each rendering its own
 * dialog instance.
 */
export function ImportDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [target, setTarget] = useState<ImportTarget | null>(null);

  const openImport = useCallback((spaceId: string, parent?: ImportParent) => {
    setTarget({ spaceId, parent: parent ?? null });
  }, []);

  return (
    <ImportDialogContext.Provider value={{ openImport }}>
      {children}
      <ImportAllDialog
        open={!!target}
        spaceId={target?.spaceId}
        parent={target?.parent ?? null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      />
    </ImportDialogContext.Provider>
  );
}

export function useImportDialog(): ImportDialogContextValue {
  const ctx = useContext(ImportDialogContext);
  invariant(ctx, "useImportDialog must be used within an ImportDialogProvider");
  return ctx;
}
