import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

interface UnsavedChangesDialogContextProps {
  showUnsavedChangesDialog: () => Promise<boolean>;
}

export const UnsavedChangesDialogContext = createContext<
  UnsavedChangesDialogContextProps | undefined
>(undefined);

export function UnsavedChangesDialogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const showUnsavedChangesDialog = useCallback(() => {
    return new Promise<boolean>((resolve) => {
      resolveRef.current = resolve;
      setIsOpen(true);
    });
  }, []);

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open);
    // If dialog is closing without explicit action (e.g., Escape key), treat as "Wait"
    if (!open && resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
  };

  const handleWait = () => {
    if (resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
  };

  const handleLeave = () => {
    if (resolveRef.current) {
      resolveRef.current(true);
      resolveRef.current = null;
    }
  };

  return (
    <UnsavedChangesDialogContext.Provider value={{ showUnsavedChangesDialog }}>
      {children}
      <AlertDialog open={isOpen} onOpenChange={handleOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("editor.unsavedChanges", "Unsaved Changes")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("editor.changesBeingSaved", "Your changes are still being saved. Are you sure you want to leave?")}
            </AlertDialogDescription>
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogAction variant="outline" onClick={handleLeave}>
              {t("space.leaveAnyway", "Leave Anyway")}
            </AlertDialogAction>
            <AlertDialogCancel variant="default" onClick={handleWait}>
              {t("common.wait", "Wait")}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </UnsavedChangesDialogContext.Provider>
  );
}

export function useUnsavedChangesDialog() {
  const context = useContext(UnsavedChangesDialogContext);
  if (context === undefined) {
    throw new Error(
      "useUnsavedChangesDialog must be used within a UnsavedChangesDialogProvider"
    );
  }
  return context;
}
