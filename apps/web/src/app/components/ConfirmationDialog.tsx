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
import { createContext, useCallback, useContext, useState } from "react";
import { useTranslation } from "react-i18next";

interface DialogContextProps {
  getConfirmation: ({
    title,
    description,
    cancelText,
    confirmText,
  }: {
    title: string;
    description: string;
    cancelText?: string;
    confirmText?: string;
  }) => Promise<boolean>;
}

export const DialogContext = createContext<DialogContextProps | undefined>(undefined);

export function ConfirmationDialogProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  const [isDialogOpen, setDialogOpen] = useState(false);
  const [dialogTitle, setDialogTitle] = useState("");
  const [dialogDescription, setDialogDescription] = useState("");
  const [dialogCancelText, setDialogCancelText] = useState("");
  const [dialogConfirmText, setDialogConfirmText] = useState("");
  const [confirm, setConfirm] = useState<(value: boolean) => void>(() => {});

  const getConfirmation = useCallback(
    ({
      title,
      description,
      cancelText,
      confirmText,
    }: {
      title: string;
      description: string;
      cancelText?: string;
      confirmText?: string;
    }) => {
      setDialogOpen(true);
      setDialogTitle(title);
      setDialogDescription(description);
      setDialogCancelText(cancelText || "");
      setDialogConfirmText(confirmText || "");
      return new Promise<boolean>((resolve) => {
        setConfirm(() => resolve);
      });
    },
    [],
  );

  return (
    <DialogContext.Provider value={{ getConfirmation }}>
      {children}
      <AlertDialog open={isDialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            {dialogTitle && <AlertDialogTitle>{dialogTitle}</AlertDialogTitle>}
            {dialogDescription && <AlertDialogDescription>{dialogDescription}</AlertDialogDescription>}
          </AlertDialogHeader>

          <AlertDialogFooter>
            <AlertDialogCancel
              onClick={() => {
                setDialogOpen(false);
                confirm(false);
              }}
            >
              {dialogCancelText || t("common.cancel", "Cancel")}
            </AlertDialogCancel>

            <AlertDialogAction
              onClick={() => {
                setDialogOpen(false);
                confirm(true);
              }}
            >
              {dialogConfirmText || t("common.confirm", "Confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DialogContext.Provider>
  );
}

export function useConfirmation() {
  const context = useContext(DialogContext);
  if (context === undefined) {
    throw new Error("useConfirmation must be used within a ConfirmationDialogProvider");
  }
  return context;
}

